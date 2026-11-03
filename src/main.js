const { app, BrowserWindow, WebContentsView, ipcMain, shell, Menu, dialog, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { SERVICES, AUTH_HOSTS, DEFAULT_SERVICE } = require('./services');

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

const TAB_BAR_HEIGHT = 40;
const ICON = path.join(__dirname, '..', 'build', 'icon.png');

const serviceById = Object.fromEntries(SERVICES.map((s) => [s.id, s]));
const serviceOf = (account) => serviceById[account.service] ?? serviceById[DEFAULT_SERVICE];
// O que a barra de abas e a tela de escolha precisam saber de cada serviço.
const SERVICE_INFO = SERVICES.map(({ id, name, mark, color }) => ({ id, name, mark, color }));

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
let picking = false; // tela de "Nova aba" (escolha do serviço) visível
let pickerView;
const views = new Map(); // accountId -> WebContentsView (criada na primeira ativação)
const configuredSessions = new WeakSet();

// ---------- persistência ----------

const stateFile = () => path.join(app.getPath('userData'), 'accounts.json');

function loadState() {
  try {
    state = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    state = { accounts: [], activeId: null };
  }
  for (const account of state.accounts) account.service ??= DEFAULT_SERVICE;
}

function saveState() {
  fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2));
}

// ---------- helpers ----------

const partitionFor = (id) => `persist:account-${id}`;

function hostMatches(url, patterns) {
  try {
    const { hostname } = new URL(url);
    return patterns.some((re) => re.test(hostname));
  } catch {
    return false;
  }
}

const isAuth = (url) => hostMatches(url, AUTH_HOSTS);
const isInternal = (url, service) => isAuth(url) || hostMatches(url, service.hosts);
const findAccount = (id) => state.accounts.find((a) => a.id === id);

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
  return { ...state, picking, services: SERVICE_INFO };
}

function broadcast() {
  win?.webContents.send('tabs:update', publicState());
}

function activeView() {
  return picking ? undefined : views.get(state.activeId);
}

function activeAccount() {
  return picking ? undefined : findAccount(state.activeId);
}

// ---------- views ----------

// Janelas abertas pelo site (window.open / target=_blank):
// - login (Google, Microsoft, Apple): popup pequeno;
// - páginas do próprio serviço (e-mail em nova janela, documento do Drive…): janela grande;
// - o resto vai para o navegador padrão.
// Todas usam a partição da conta, e as janelas filhas seguem a mesma regra.
function handleWindowOpen(wc, account) {
  const service = serviceOf(account);
  const partition = partitionFor(account.id);
  wc.setWindowOpenHandler(({ url }) => {
    if (url !== 'about:blank' && !isInternal(url, service)) {
      openExternal(url);
      return { action: 'deny' };
    }
    const size = isAuth(url) ? { width: 520, height: 720 } : { width: 1200, height: 850 };
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        ...size,
        icon: ICON,
        webPreferences: { partition, sandbox: true, contextIsolation: true },
      },
    };
  });
  wc.on('did-create-window', (child) => handleWindowOpen(child.webContents, account));
}

function ensureView(account) {
  if (views.has(account.id)) return views.get(account.id);
  const view = new WebContentsView({
    webPreferences: { partition: partitionFor(account.id), sandbox: true, contextIsolation: true },
  });
  const wc = view.webContents;
  setupSession(wc.session);
  handleWindowOpen(wc, account);

  wc.on('page-title-updated', (_e, title) => {
    account.title = title;
    broadcast();
  });

  win.contentView.addChildView(view);
  views.set(account.id, view);
  wc.loadURL(serviceOf(account).url);
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
  const bounds = { x: 0, y: TAB_BAR_HEIGHT, width, height: Math.max(0, height - TAB_BAR_HEIGHT) };
  pickerView.setBounds(bounds);
  pickerView.setVisible(picking);
  for (const [id, view] of views) {
    view.setBounds(bounds);
    view.setVisible(!picking && id === state.activeId);
  }
  (picking ? pickerView : activeView())?.webContents.focus();
}

// ---------- ações ----------

function startPicking() {
  if (!win) return;
  picking = true;
  layout();
  broadcast();
}

function cancelPicking() {
  if (!picking || state.accounts.length === 0) return; // sem contas, a tela de escolha fica
  picking = false;
  layout();
  broadcast();
}

// Nome padrão: o do serviço ("Gmail"), numerado a partir da segunda ("Gmail 2").
function defaultName(service) {
  const names = new Set(state.accounts.map((a) => a.name));
  if (!names.has(service.name)) return service.name;
  let n = 2;
  while (names.has(`${service.name} ${n}`)) n++;
  return `${service.name} ${n}`;
}

function addAccount(serviceId) {
  const service = serviceById[serviceId];
  if (!service) return;
  const account = { id: crypto.randomUUID(), service: service.id, name: defaultName(service) };
  state.accounts.push(account);
  activate(account.id);
}

function activate(id) {
  const account = findAccount(id);
  if (!account || (id === state.activeId && !picking)) return;
  picking = false;
  state.activeId = id;
  ensureView(account);
  saveState();
  layout();
  broadcast();
}

function rename(id, name) {
  const account = findAccount(id);
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
  if (response !== 0) return;

  // A aba pode nunca ter sido aberta nesta execução, então a sessão vem da partição.
  const ses = session.fromPartition(partitionFor(id));
  destroyView(id);
  await ses.clearStorageData();
  await ses.clearCache();

  const index = state.accounts.indexOf(account);
  state.accounts.splice(index, 1);
  if (state.accounts.length === 0) {
    state.activeId = null;
    saveState();
    startPicking();
    return;
  }
  if (state.activeId === id) {
    const next = state.accounts[Math.min(index, state.accounts.length - 1)];
    state.activeId = next.id;
    ensureView(next);
  }
  saveState();
  layout();
  broadcast();
}

function showTabMenu(id) {
  const account = findAccount(id);
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
ipcMain.on('tabs:new', () => startPicking());
ipcMain.on('tabs:activate', (_e, id) => activate(id));
ipcMain.on('tabs:rename', (_e, id, name) => rename(id, name));
ipcMain.on('tabs:reload', (_e, id) => views.get(id)?.webContents.reload());
ipcMain.on('tabs:context', (_e, id) => showTabMenu(id));

// ---------- IPC (tela de escolha do serviço) ----------

ipcMain.handle('picker:services', () => SERVICE_INFO);
ipcMain.on('picker:pick', (_e, serviceId) => addAccount(serviceId));
ipcMain.on('picker:cancel', () => cancelPicking());

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
        { label: 'Nova aba', accelerator: 'CmdOrCtrl+T', click: startPicking },
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
        { label: 'Página inicial', accelerator: 'CmdOrCtrl+Shift+H', click: goHome },
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

function goHome() {
  const account = activeAccount();
  if (account) views.get(account.id)?.webContents.loadURL(serviceOf(account).url);
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
    pickerView = null;
    views.clear();
  });

  pickerView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'picker-preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  pickerView.webContents.loadFile(path.join(__dirname, 'picker.html'));
  win.contentView.addChildView(pickerView);

  // Só a aba ativa carrega ao abrir o app; as outras, na primeira vez que forem ativadas.
  loadState();
  picking = state.accounts.length === 0;
  if (!picking) {
    if (!findAccount(state.activeId)) state.activeId = state.accounts[0].id;
    ensureView(findAccount(state.activeId));
  }
  layout();
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
