const { app, BrowserWindow, WebContentsView, ipcMain, shell, Menu, dialog, session, clipboard } = require('electron');
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
// Abas filhas: compartilham a sessão (partição) da aba pai, para abrir uma URL já
// autenticada (ex.: link de login do Claude Code). Só existem em memória.
let children = []; // { id, parentId, url, title }
const views = new Map(); // id da aba -> WebContentsView (criada na primeira ativação)
const loading = new Set(); // abas carregando agora (só em memória)
// PIN: contas com PIN abrem bloqueadas ao iniciar o app; depois do PIN certo,
// ficam desbloqueadas (com as filhas) até o app ser fechado.
const unlocked = new Set(); // ids de contas desbloqueadas
let modalOpen = false; // diálogo de PIN aberto na barra: esconde as páginas
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
  // Filhas não são salvas: se uma estiver ativa, ao reabrir volta a aba pai.
  const activeId = findTab(state.activeId)?.parentId ?? state.activeId;
  fs.writeFileSync(stateFile(), JSON.stringify({ ...state, activeId }, null, 2));
}

// ---------- helpers ----------

const partitionFor = (id) => `persist:account-${id}`;

const findTab = (id) => state.accounts.find((a) => a.id === id) ?? children.find((c) => c.id === id);

// Ordem de exibição: cada conta seguida das suas filhas.
function orderedTabs() {
  return state.accounts.flatMap((a) => [a, ...children.filter((c) => c.parentId === a.id)]);
}

// Aceita "exemplo.com/x" e completa com https://. Só http(s).
// Remove todo espaço/quebra de linha: links copiados do terminal vêm quebrados em
// várias linhas (ex.: "redirect_uri\n=..." viraria o parâmetro "redirect_uri ").
// Uma URL válida nunca tem espaço literal (seria %20), então é seguro.
function normalizeUrl(input) {
  const text = input?.replace(/\s+/g, '');
  if (!text) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

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

// ---------- PIN ----------

const ownerId = (id) => findTab(id)?.parentId ?? id; // conta dona da aba (a própria, ou a pai)
const isLocked = (id) => {
  const account = state.accounts.find((a) => a.id === ownerId(id));
  return !!account?.pin && !unlocked.has(account.id);
};

function hashPin(pin, salt) {
  return crypto.scryptSync(pin, Buffer.from(salt, 'hex'), 32).toString('hex');
}

function checkPin(account, pin) {
  if (!account?.pin || typeof pin !== 'string') return false;
  const a = Buffer.from(hashPin(pin, account.pin.salt), 'hex');
  const b = Buffer.from(account.pin.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const MIN_PIN = 4;

function setPin(id, pin) {
  const account = state.accounts.find((a) => a.id === id);
  if (!account) return { ok: false, error: 'Conta não encontrada.' };
  if (account.pin) return { ok: false, error: 'Esta conta já tem PIN.' };
  if (typeof pin !== 'string' || pin.length < MIN_PIN) return { ok: false, error: `O PIN precisa ter ao menos ${MIN_PIN} caracteres.` };
  const salt = crypto.randomBytes(16).toString('hex');
  account.pin = { salt, hash: hashPin(pin, salt) };
  unlocked.add(id); // quem acabou de definir continua usando; bloqueia ao reabrir o app
  saveState();
  broadcast();
  return { ok: true };
}

// Erro de PIN espera um pouco, para dificultar tentativa e erro.
async function removePin(id, pin) {
  const account = state.accounts.find((a) => a.id === id);
  if (!checkPin(account, pin)) { await delay(800); return { ok: false, error: 'PIN incorreto.' }; }
  delete account.pin;
  unlocked.delete(id);
  saveState();
  showActive();
  return { ok: true };
}

async function unlock(id, pin) {
  const account = state.accounts.find((a) => a.id === ownerId(id));
  if (!checkPin(account, pin)) { await delay(800); return { ok: false, error: 'PIN incorreto.' }; }
  unlocked.add(account.id);
  showActive();
  return { ok: true };
}

// Depois de desbloquear/remover o PIN: carrega a aba ativa, se ainda não tinha carregado.
function showActive() {
  const active = findTab(state.activeId);
  if (active && !isLocked(active.id)) ensureView(active);
  layout();
  broadcast();
}

function openPinDialog(mode, id) {
  const account = state.accounts.find((a) => a.id === id);
  if (!account) return;
  win.webContents.focus();
  win.webContents.send('ui:pin', { mode, id, name: account.name });
}

function publicState() {
  // Nunca envia o hash do PIN para a barra; e não expõe o título da página de abas bloqueadas.
  const locked = new Set(state.accounts.filter((a) => isLocked(a.id)).map((a) => a.id));
  return {
    accounts: state.accounts.map(({ pin, ...a }) => ({ ...a, hasPin: !!pin, title: locked.has(a.id) ? undefined : a.title })),
    children: children.map((c) => (locked.has(c.parentId) ? { ...c, title: undefined, url: undefined } : c)),
    locked: [...locked],
    activeId: state.activeId,
    loading: [...loading],
  };
}

function broadcast() {
  win?.webContents.send('tabs:update', publicState());
}

// A página da aba ativa, se estiver à mostra (bloqueada não conta: nada de DevTools, recarregar etc.).
function activeView() {
  return isLocked(state.activeId) ? undefined : views.get(state.activeId);
}

// ---------- views ----------

// tab: uma conta ou uma filha (a filha usa a partição da conta pai).
function ensureView(account) {
  if (views.has(account.id)) return views.get(account.id);
  const partition = partitionFor(account.parentId ?? account.id);
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
  wc.loadURL(account.url ?? START_URL);
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
    view.setVisible(id === state.activeId && !isLocked(id) && !modalOpen);
  }
  // Bloqueada ou com diálogo aberto, o foco vai para a barra (tela do PIN).
  if (modalOpen || isLocked(state.activeId)) win.webContents.focus();
  else activeView()?.webContents.focus();
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
  const account = findTab(id);
  if (!account || id === state.activeId) return;
  if (!isLocked(id)) ensureView(account); // bloqueada só carrega depois do PIN
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
  // As filhas usam a mesma sessão, então fecham junto.
  for (const child of children.filter((c) => c.parentId === id)) destroyView(child.id);
  if (children.some((c) => c.parentId === id && c.id === state.activeId)) state.activeId = id;
  children = children.filter((c) => c.parentId !== id);
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
      if (!isLocked(next.id)) ensureView(next);
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

function addChild(parentId, rawUrl) {
  const parent = state.accounts.find((a) => a.id === parentId);
  const url = normalizeUrl(rawUrl);
  if (!parent || isLocked(parentId)) return;
  if (!url) {
    dialog.showMessageBox(win, { type: 'error', message: 'URL inválida.', detail: 'Use um endereço http:// ou https://.' });
    return;
  }
  const child = { id: crypto.randomUUID(), parentId, url };
  // Entra logo depois das outras filhas da mesma conta.
  children.push(child);
  activate(child.id);
}

// Fecha só a view: a sessão é da conta pai, então nada é apagado e o login continua.
function closeChild(id) {
  const child = children.find((c) => c.id === id);
  if (!child) return;
  destroyView(id);
  children = children.filter((c) => c !== child);
  if (state.activeId === id) {
    state.activeId = null;
    activate(child.parentId);
  } else {
    layout();
    broadcast();
  }
}

function showTabMenu(id) {
  const child = children.find((c) => c.id === id);
  if (child) {
    Menu.buildFromTemplate([
      { label: 'Recarregar', click: () => views.get(id)?.webContents.reload() },
      { label: 'Copiar URL', enabled: !isLocked(id), click: () => clipboard.writeText(views.get(id)?.webContents.getURL() ?? child.url) },
      { type: 'separator' },
      { label: 'Fechar aba filha', click: () => closeChild(id) },
    ]).popup({ window: win });
    return;
  }
  const account = state.accounts.find((a) => a.id === id);
  if (!account) return;
  const locked = isLocked(id);
  // PIN só se define/remove na conta (pai); as filhas seguem a regra dela.
  const pinItems = !account.pin
    ? [{ label: 'Definir PIN…', click: () => openPinDialog('set', id) }]
    : [{ label: 'Remover PIN…', click: () => openPinDialog('remove', id) }];
  Menu.buildFromTemplate([
    { label: 'Nova aba filha…', enabled: !locked, click: () => { win.webContents.focus(); win.webContents.send('ui:add-child', id); } },
    { type: 'separator' },
    ...pinItems,
    { type: 'separator' },
    { label: 'Renomear', click: () => { win.webContents.focus(); win.webContents.send('ui:rename', id); } },
    { label: 'Recarregar', click: () => views.get(id)?.webContents.reload() },
    { type: 'separator' },
    { label: 'Remover conta…', click: () => removeAccount(id) },
  ]).popup({ window: win });
}

function cycle(step) {
  const tabs = orderedTabs();
  const n = tabs.length;
  if (n < 2) return;
  const i = tabs.findIndex((t) => t.id === state.activeId);
  activate(tabs[(i + step + n) % n].id);
}

// ---------- IPC (barra de abas) ----------

ipcMain.handle('tabs:get', () => publicState());
ipcMain.on('tabs:add', (_e, name) => addAccount(name));
ipcMain.on('tabs:activate', (_e, id) => activate(id));
ipcMain.on('tabs:rename', (_e, id, name) => rename(id, name));
ipcMain.on('tabs:reload', (_e, id) => views.get(id)?.webContents.reload());
ipcMain.on('tabs:context', (_e, id) => showTabMenu(id));
ipcMain.on('tabs:add-child', (_e, parentId, url) => addChild(parentId, url));
ipcMain.on('tabs:close-child', (_e, id) => closeChild(id));
ipcMain.handle('pin:set', (_e, id, pin) => setPin(id, pin));
ipcMain.handle('pin:remove', (_e, id, pin) => removePin(id, pin));
ipcMain.handle('pin:unlock', (_e, id, pin) => unlock(id, pin));
ipcMain.on('ui:modal', (_e, open) => { modalOpen = !!open; layout(); });

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
        {
          label: 'Nova aba filha da conta atual…',
          accelerator: 'CmdOrCtrl+Shift+T',
          click: () => {
            const parentId = findTab(state.activeId)?.parentId ?? state.activeId;
            if (parentId && !isLocked(parentId)) { win.webContents.focus(); win.webContents.send('ui:add-child', parentId); }
          },
        },
        { label: 'Fechar aba filha', accelerator: 'CmdOrCtrl+W', click: () => closeChild(state.activeId) },
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
    children = [];
  });

  // Só a aba ativa carrega ao abrir o app; as outras, na primeira vez que forem ativadas.
  loadState();
  for (const id of state.pendingWipes) wipe(id);
  if (state.accounts.length === 0) {
    addAccount('Conta 1');
  } else {
    const active = state.accounts.find((a) => a.id === state.activeId) ?? state.accounts[0];
    state.activeId = active.id;
    if (!isLocked(active.id)) ensureView(active);
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
