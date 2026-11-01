const { app, BrowserWindow, WebContentsView, ipcMain, shell, Menu, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

// Migra os dados da época em que o app se chamava "claude-browser" (mantém os logins).
// O Electron cria a pasta nova antes deste código rodar, então movemos só o que importa:
// a lista de contas e as partições (lidas depois do app iniciar). O resto é cache.
const legacyUserData = path.join(app.getPath('appData'), 'claude-browser');
if (fs.existsSync(path.join(legacyUserData, 'accounts.json'))) {
  for (const item of ['accounts.json', 'Partitions']) {
    const from = path.join(legacyUserData, item);
    const to = path.join(app.getPath('userData'), item);
    if (!fs.existsSync(from)) continue;
    fs.rmSync(to, { recursive: true, force: true });
    fs.renameSync(from, to);
  }
  fs.rmSync(legacyUserData, { recursive: true, force: true });
}

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
let state = { accounts: [], activeId: null };
const views = new Map(); // accountId -> WebContentsView
const configuredSessions = new WeakSet();

// ---------- persistência ----------

const stateFile = () => path.join(app.getPath('userData'), 'accounts.json');

function loadState() {
  try {
    state = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    state = { accounts: [], activeId: null };
  }
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

function broadcast() {
  win?.webContents.send('tabs:update', state);
}

function activeView() {
  return views.get(state.activeId);
}

// ---------- views ----------

function createView(account) {
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
  createView(account);
  activate(account.id);
}

function activate(id) {
  if (!views.has(id)) return;
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
    message: `Remover a aba "${account.name}"?`,
    detail: 'O login e os dados desta conta serão apagados deste app.',
  });
  if (response !== 0) return;

  const ses = views.get(id)?.webContents.session;
  destroyView(id);
  await ses?.clearStorageData();
  await ses?.clearCache();

  const index = state.accounts.indexOf(account);
  state.accounts.splice(index, 1);
  if (state.accounts.length === 0) {
    state.activeId = null;
    addAccount();
    return;
  }
  if (state.activeId === id) {
    state.activeId = state.accounts[Math.min(index, state.accounts.length - 1)].id;
  }
  saveState();
  layout();
  broadcast();
}

function cycle(step) {
  const n = state.accounts.length;
  if (n < 2) return;
  const i = state.accounts.findIndex((a) => a.id === state.activeId);
  activate(state.accounts[(i + step + n) % n].id);
}

// ---------- IPC (barra de abas) ----------

ipcMain.handle('tabs:get', () => state);
ipcMain.on('tabs:add', (_e, name) => addAccount(name));
ipcMain.on('tabs:activate', (_e, id) => activate(id));
ipcMain.on('tabs:rename', (_e, id, name) => rename(id, name));
ipcMain.on('tabs:remove', (_e, id) => removeAccount(id));
ipcMain.on('tabs:reload', (_e, id) => views.get(id)?.webContents.reload());

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

  loadState();
  if (state.accounts.length === 0) {
    addAccount('Conta 1');
  } else {
    for (const account of state.accounts) createView(account);
    if (!views.has(state.activeId)) state.activeId = state.accounts[0].id;
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
