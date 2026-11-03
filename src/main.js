const { app, BrowserWindow, WebContentsView, ipcMain, shell, Menu, dialog, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

// Em desenvolvimento (npm start) usa uma pasta própria, para nunca disputar
// os dados (logins) com o app instalado.
if (!app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('appData'), 'Multiverse Dev'));
}

// Uma instância por pasta de dados: abrir de novo só traz a janela para frente.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

const START_URL = 'https://claude.ai/';
const TAB_BAR_HEIGHT = 40;
const ICON = path.join(__dirname, '..', 'build', 'icon.png');

// Domínios que abrem dentro do app (login, OAuth). O resto vai para o navegador padrão.
const INTERNAL_HOSTS = [
  /(^|\.)claude\.ai$/,
  /(^|\.)claude\.com$/,
  /(^|\.)anthropic\.com$/,
  /^accounts\.google\.com$/,
  /^appleid\.apple\.com$/,
];

// User-Agent de Chrome "puro" (sem "Electron"), para o login não estranhar o navegador.
const UA_PLATFORM = {
  darwin: 'Macintosh; Intel Mac OS X 10_15_7',
  win32: 'Windows NT 10.0; Win64; x64',
}[process.platform] ?? 'X11; Linux x86_64';
app.userAgentFallback =
  `Mozilla/5.0 (${UA_PLATFORM}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/${process.versions.chrome} Safari/537.36`;

let win;
// pendingWipes: contas removidas cujos dados ainda estão sendo apagados.
let state = { accounts: [], activeId: null, pendingWipes: [] };
const views = new Map(); // accountId -> WebContentsView (criada na primeira ativação)
const loading = new Set(); // abas carregando agora (só em memória)
const configuredSessions = new WeakSet();

// ---------- persistência ----------

const stateFile = () => path.join(app.getPath('userData'), 'accounts.json');

function loadState() {
  try {
    state = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    state = { accounts: [], activeId: null };
  }
  state.pendingWipes ??= [];
  // A versão 1.1.0 criava abas de outros serviços (Gmail, Outlook…), que não existem
  // mais: elas saem, e os dados delas são apagados.
  for (const account of state.accounts.filter((a) => a.service && a.service !== 'claude')) {
    state.pendingWipes.push(account.id);
  }
  state.accounts = state.accounts.filter((a) => !a.service || a.service === 'claude');
  for (const account of state.accounts) delete account.service;
}

function saveState() {
  fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2));
}

// ---------- helpers ----------

const partitionFor = (id) => `persist:account-${id}`;

function isInternal(url) {
  try {
    return INTERNAL_HOSTS.some((re) => re.test(new URL(url).hostname));
  } catch {
    return false;
  }
}

function openExternal(url) {
  if (/^https?:\/\//.test(url)) shell.openExternal(url);
}

function setupSession(ses) {
  if (configuredSessions.has(ses)) return;
  configuredSessions.add(ses);
  const allowed = new Set(['clipboard-read', 'clipboard-sanitized-write', 'notifications', 'media', 'fullscreen']);
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)));
}

function publicState() {
  return { accounts: state.accounts, activeId: state.activeId, loading: [...loading] };
}

function broadcast() {
  win?.webContents.send('tabs:update', publicState());
}

function activeView() {
  return views.get(state.activeId);
}

// ---------- views ----------

function ensureView(account) {
  if (views.has(account.id)) return views.get(account.id);
  const partition = partitionFor(account.id);
  const view = new WebContentsView({
    webPreferences: { partition, sandbox: true, contextIsolation: true },
  });
  const wc = view.webContents;
  setupSession(wc.session);

  wc.setWindowOpenHandler(({ url }) => {
    if (isInternal(url)) {
      // Popups de login herdam a mesma partição (mesma conta).
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { width: 520, height: 720, webPreferences: { partition } },
      };
    }
    openExternal(url);
    return { action: 'deny' };
  });

  wc.on('page-title-updated', (_e, title) => {
    account.title = title;
    broadcast();
  });
  wc.on('did-start-loading', () => {
    loading.add(account.id);
    broadcast();
  });
  wc.on('did-stop-loading', () => {
    loading.delete(account.id);
    broadcast();
  });

  win.contentView.addChildView(view);
  views.set(account.id, view);
  wc.loadURL(START_URL);
  return view;
}

function destroyView(id) {
  const view = views.get(id);
  if (!view) return;
  win.contentView.removeChildView(view);
  view.webContents.close();
  views.delete(id);
  loading.delete(id);
}

function layout() {
  if (!win) return;
  const { width, height } = win.getContentBounds();
  for (const [id, view] of views) {
    view.setBounds({ x: 0, y: TAB_BAR_HEIGHT, width, height: Math.max(0, height - TAB_BAR_HEIGHT) });
    view.setVisible(id === state.activeId);
  }
  activeView()?.webContents.focus();
}

// ---------- ações ----------

function addAccount(name) {
  const account = {
    id: crypto.randomUUID(),
    name: name?.trim() || `Conta ${state.accounts.length + 1}`,
  };
  state.accounts.push(account);
  activate(account.id);
}

function activate(id) {
  const account = state.accounts.find((a) => a.id === id);
  if (!account || id === state.activeId) return;
  ensureView(account);
  state.activeId = id;
  saveState();
  layout();
  broadcast();
}

function rename(id, name) {
  const account = state.accounts.find((a) => a.id === id);
  if (!account || !name?.trim()) return;
  account.name = name.trim();
  saveState();
  broadcast();
}

async function removeAccount(id) {
  const account = state.accounts.find((a) => a.id === id);
  if (!account) return;
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Remover', 'Cancelar'],
    defaultId: 1,
    cancelId: 1,
    message: `Remover a conta "${account.name}"?`,
    detail: 'O login e todos os dados desta conta serão apagados deste app, e a aba será fechada.',
  });
  const index = state.accounts.indexOf(account);
  if (response !== 0 || index === -1) return;

  // A aba sai na hora; os dados são apagados em segundo plano (veja wipe).
  destroyView(id);
  state.accounts.splice(index, 1);
  state.pendingWipes.push(id);
  if (state.accounts.length === 0) {
    state.activeId = null;
    addAccount(); // salva o estado
  } else {
    if (state.activeId === id) {
      const next = state.accounts[Math.min(index, state.accounts.length - 1)];
      state.activeId = next.id;
      ensureView(next);
    }
    saveState();
    layout();
    broadcast();
  }
  wipe(id);
}

// Apaga login e dados de uma conta removida, sem travar a interface. Se o app
// fechar antes de terminar, o id continua em pendingWipes e a limpeza é retomada
// na próxima abertura.
async function wipe(id) {
  // A aba pode nunca ter sido aberta nesta execução, então a sessão vem da partição.
  const ses = session.fromPartition(partitionFor(id));
  try {
    await ses.clearStorageData();
    await ses.clearCache();
  } catch (err) {
    console.error(`Falha ao apagar os dados da conta ${id}:`, err);
    return; // fica pendente para a próxima abertura
  }
  state.pendingWipes = state.pendingWipes.filter((x) => x !== id);
  saveState();
}

function showTabMenu(id) {
  const account = state.accounts.find((a) => a.id === id);
  if (!account) return;
  Menu.buildFromTemplate([
    { label: 'Renomear', click: () => { win.webContents.focus(); win.webContents.send('ui:rename', id); } },
    { label: 'Recarregar', click: () => views.get(id)?.webContents.reload() },
    { type: 'separator' },
    { label: 'Remover conta…', click: () => removeAccount(id) },
  ]).popup({ window: win });
}

function cycle(step) {
  const n = state.accounts.length;
  if (n < 2) return;
  const i = state.accounts.findIndex((a) => a.id === state.activeId);
  activate(state.accounts[(i + step + n) % n].id);
}

// ---------- IPC (barra de abas) ----------

ipcMain.handle('tabs:get', () => publicState());
ipcMain.on('tabs:add', (_e, name) => addAccount(name));
ipcMain.on('tabs:activate', (_e, id) => activate(id));
ipcMain.on('tabs:rename', (_e, id, name) => rename(id, name));
ipcMain.on('tabs:reload', (_e, id) => views.get(id)?.webContents.reload());
ipcMain.on('tabs:context', (_e, id) => showTabMenu(id));

// ---------- menu / atalhos ----------

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const tabShortcuts = Array.from({ length: 9 }, (_, i) => ({
    label: `Aba ${i + 1}`,
    accelerator: `CmdOrCtrl+${i + 1}`,
    click: () => state.accounts[i] && activate(state.accounts[i].id),
  }));

  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'Contas',
      submenu: [
        { label: 'Nova conta', accelerator: 'CmdOrCtrl+T', click: () => { win.webContents.focus(); win.webContents.send('ui:new-tab'); } },
        { label: 'Próxima aba', accelerator: 'Ctrl+Tab', click: () => cycle(1) },
        { label: 'Aba anterior', accelerator: 'Ctrl+Shift+Tab', click: () => cycle(-1) },
        { type: 'separator' },
        ...tabShortcuts,
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Ver',
      submenu: [
        { label: 'Recarregar', accelerator: 'CmdOrCtrl+R', click: () => activeView()?.webContents.reload() },
        { label: 'Voltar', accelerator: 'CmdOrCtrl+[', click: () => activeView()?.webContents.navigationHistory.goBack() },
        { label: 'Avançar', accelerator: 'CmdOrCtrl+]', click: () => activeView()?.webContents.navigationHistory.goForward() },
        { label: 'Página inicial', accelerator: 'CmdOrCtrl+Shift+H', click: () => activeView()?.webContents.loadURL(START_URL) },
        { type: 'separator' },
        { label: 'Zoom +', accelerator: 'CmdOrCtrl+=', click: () => zoom(0.5) },
        { label: 'Zoom −', accelerator: 'CmdOrCtrl+-', click: () => zoom(-0.5) },
        { label: 'Zoom 100%', accelerator: 'CmdOrCtrl+0', click: () => activeView()?.webContents.setZoomLevel(0) },
        { type: 'separator' },
        { label: 'DevTools da aba', accelerator: 'Alt+CmdOrCtrl+I', click: () => activeView()?.webContents.toggleDevTools() },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function zoom(delta) {
  const wc = activeView()?.webContents;
  if (wc) wc.setZoomLevel(wc.getZoomLevel() + delta);
}

// ---------- janela ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 600,
    minHeight: 400,
    title: 'Multiverse',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#1f1e1d',
    icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'tabbar.html'));
  win.on('resize', layout);
  win.on('closed', () => {
    win = null;
    views.clear();
  });

  // Só a aba ativa carrega ao abrir o app; as outras, na primeira vez que forem ativadas.
  loadState();
  for (const id of state.pendingWipes) wipe(id);
  if (state.accounts.length === 0) {
    addAccount('Conta 1');
  } else {
    const active = state.accounts.find((a) => a.id === state.activeId) ?? state.accounts[0];
    state.activeId = active.id;
    ensureView(active);
    saveState();
    layout();
  }
  win.webContents.on('did-finish-load', broadcast);
}

app.whenReady().then(() => {
  app.dock?.setIcon(ICON);
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (!win) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
