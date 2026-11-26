const { app, BrowserWindow, WebContentsView, ipcMain, shell, Menu, dialog, session, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { startMcpServer, ToolError } = require('./mcp');

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
const MCP_DEFAULT_PORT = 47821;
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
// createdBy: 'user' (aberta por você) ou 'agent' (criada pelo Claude Code via MCP).
let children = []; // { id, parentId, url, title, createdBy }
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
  state.mcp = { enabled: false, port: MCP_DEFAULT_PORT, ...state.mcp };
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
  // Filhas do Claude Code: sem câmera/microfone, notificações ou leitura da área de transferência.
  const allowedForAgent = new Set(['clipboard-sanitized-write', 'fullscreen']);
  ses.setPermissionRequestHandler((wc, permission, callback) =>
    callback((isAgentContents(wc) ? allowedForAgent : allowed).has(permission)));
  // Filhas do Claude Code não baixam arquivos.
  ses.on('will-download', (event, _item, wc) => {
    if (isAgentContents(wc)) event.preventDefault();
  });
}

const isAgentContents = (wc) =>
  !!wc && children.some((c) => c.createdBy === 'agent' && views.get(c.id)?.webContents === wc);

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
    mcp: { on: !!mcpServer, connected: mcpConnected },
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
  const isAgent = account.createdBy === 'agent';
  const view = isAgent
    ? createAgentHost(partition)
    : new WebContentsView({ webPreferences: { partition, sandbox: true, contextIsolation: true } });
  const wc = view.webContents;
  setupSession(wc.session);
  if (isAgent) {
    wc.setFrameRate(AGENT_FPS_IDLE);
    wc.on('paint', (_e, _dirty, image) => queueMirrorFrame(account.id, image));
  }

  wc.setWindowOpenHandler(({ url }) => {
    // Na filha do Claude Code, um popup/nova janela vira outra filha dele (dentro do limite),
    // para continuar ao alcance do Claude Code e nunca abrir o navegador do usuário.
    if (isAgent) {
      const target = normalizeUrl(url);
      if (target && agentChildCount(account.parentId) < MAX_AGENT_CHILDREN) spawnAgentChild(account.parentId, target);
      return { action: 'deny' };
    }
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

  if (!isAgent) win.contentView.addChildView(view);
  views.set(account.id, view);
  if (isAgent) placeView(account.id, view); // tamanho certo antes de carregar
  wc.loadURL(account.url ?? START_URL);
  return view;
}

// Filha do Claude Code: uma janela invisível que desenha na memória (offscreen), em vez
// de uma aba dentro da janela. Assim cliques, digitação e prints funcionam mesmo com o
// Multiverse minimizado ou coberto por outro programa, e o tamanho da página é o da área
// das abas. O usuário a vê pelo espelho ao vivo (mirror*). Devolve um objeto com a
// mesma interface usada aqui para as abas (webContents, setBounds, setVisible…).
function createAgentHost(partition) {
  const host = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    useContentSize: true,
    width: 1280,
    height: 800,
    webPreferences: { partition, sandbox: true, contextIsolation: true, offscreen: true, backgroundThrottling: false },
  });
  return {
    host,
    webContents: host.webContents,
    getVisible: () => false,
    setVisible: () => {},
    getBounds: () => { const [width, height] = host.getContentSize(); return { x: 0, y: TAB_BAR_HEIGHT, width, height }; },
    setBounds: ({ width, height }) => {
      const [w, h] = host.getContentSize();
      if (w !== width || h !== height) host.setContentSize(Math.max(1, width), Math.max(1, height));
    },
  };
}

function destroyView(id) {
  const view = views.get(id);
  if (!view) return;
  if (view.host) {
    if (mirrorFocusId === id) mirrorFocusId = null;
    view.host.destroy();
  } else {
    win.contentView.removeChildView(view);
    view.webContents.close();
  }
  views.delete(id);
  loading.delete(id);
}

// Tamanho e visibilidade de uma aba (sem mexer no foco).
function placeView(id, view) {
  const { width, height } = win.getContentBounds();
  if (isOffscreen(view)) {
    // Filha do Claude Code: nunca aparece na janela; só o tamanho importa (= área das abas).
    view.setBounds({ x: 0, y: TAB_BAR_HEIGHT, width, height: Math.max(0, height - TAB_BAR_HEIGHT) });
    view.setVisible(false);
    view.webContents.setFrameRate(id === state.activeId ? AGENT_FPS_MIRROR : AGENT_FPS_IDLE);
    return;
  }
  const shown = id === state.activeId && !isLocked(id) && !modalOpen;
  // Aba escondida no meio de uma ação do Claude Code fica na borda (veja withSurface).
  const x = !shown && surfaceUsers.has(view) ? width - 1 : 0;
  view.setBounds({ x, y: TAB_BAR_HEIGHT, width, height: Math.max(0, height - TAB_BAR_HEIGHT) });
  view.setVisible(shown || surfaceUsers.has(view));
}

function layout() {
  if (!win) return;
  for (const [id, view] of views) placeView(id, view);
  if (mirrorFocusId && !mirrorShown(mirrorFocusId)) blurMirror();
  // Bloqueada, com diálogo aberto ou filha do Claude Code (espelho), o foco vai para a barra.
  const active = views.get(state.activeId);
  if (modalOpen || isLocked(state.activeId) || (active && isOffscreen(active))) {
    win.webContents.focus();
    if (active && isOffscreen(active) && !isLocked(state.activeId)) active.webContents.invalidate(); // 1º quadro do espelho já
  } else {
    activeView()?.webContents.focus();
  }
}

const isOffscreen = (view) => !!view.host; // filha do Claude Code (createAgentHost)

// ---------- espelho das filhas do Claude Code ----------
// A filha offscreen não aparece na janela. Quando o usuário a abre, a barra mostra
// os quadros dela ao vivo (JPEG) e devolve cliques, rolagem e teclas (mirror:input).

const AGENT_FPS_IDLE = 4;    // em segundo plano: o bastante para prints e para a página andar
const AGENT_FPS_MIRROR = 15; // quando o usuário está olhando
const MIRROR_MIN_MS = 66;    // ~15 quadros/s para a barra
let mirrorPending = null;    // { id, image } do último quadro ainda não enviado
let mirrorTimer = null;
let mirrorLastSent = 0;

function queueMirrorFrame(id, image) {
  if (!win || id !== state.activeId || win.isMinimized() || isLocked(id) || modalOpen) return;
  mirrorPending = { id, image };
  if (mirrorTimer) return;
  mirrorTimer = setTimeout(flushMirror, Math.max(0, MIRROR_MIN_MS - (Date.now() - mirrorLastSent)));
}

function flushMirror() {
  mirrorTimer = null;
  const frame = mirrorPending;
  mirrorPending = null;
  if (!frame || !win || frame.id !== state.activeId) return;
  mirrorLastSent = Date.now();
  const { width, height } = frame.image.getSize();
  win.webContents.send('mirror:frame', { id: frame.id, width, height, data: frame.image.toJPEG(80).toString('base64') });
}

// Foco de teclado da filha. A janela offscreen nunca é mostrada, então nunca ganha foco
// sozinha: a página fica sem foco (document.hasFocus() false) e campos não entram em
// edição. Quando o usuário interage com o espelho, a página ganha o foco (sem mostrar a
// janela nem tirar o foco do Multiverse); ao sair da aba ou do app, perde. Filhas que o
// Claude Code usa em segundo plano nunca ganham foco por conta própria.
let mirrorFocusId = null;

const mirrorShown = (id) =>
  id === state.activeId && !isLocked(id) && !modalOpen && !!win && win.isFocused() && !!views.get(id)?.host;

function focusMirror(id) {
  if (mirrorFocusId === id || !mirrorShown(id)) return;
  blurMirror();
  views.get(id).host.focusOnWebView();
  mirrorFocusId = id;
}

function blurMirror() {
  const host = views.get(mirrorFocusId)?.host;
  mirrorFocusId = null;
  if (host && !host.isDestroyed()) host.blurWebView();
}

// Ações do usuário no espelho, repassadas à filha (só à que está aberta na tela).
function mirrorInput(id, input) {
  const child = children.find((c) => c.id === id && c.createdBy === 'agent');
  const wc = views.get(id)?.webContents;
  if (!child || !wc || id !== state.activeId || isLocked(id) || !input || typeof input !== 'object') return;
  if (input.type === 'mouseDown' || input.kind === 'text' || input.kind === 'key') focusMirror(id);
  const num = (v) => (Number.isFinite(v) ? Math.round(v) : 0);
  const modifiers = ['shift', 'control', 'alt', 'meta'].filter((m) => input[m]);
  switch (input.kind) {
    case 'mouse':
      if (!['mouseDown', 'mouseUp', 'mouseMove'].includes(input.type)) return;
      wc.sendInputEvent({
        type: input.type, x: num(input.x), y: num(input.y), modifiers,
        button: ['left', 'middle', 'right'].includes(input.button) ? input.button : 'left',
        clickCount: Math.min(3, Math.max(1, num(input.clickCount))),
      });
      break;
    case 'wheel':
      wc.sendInputEvent({ type: 'mouseWheel', x: num(input.x), y: num(input.y), deltaX: -num(input.deltaX), deltaY: -num(input.deltaY), modifiers });
      break;
    case 'text': // caractere digitável (inclui acentos e emoji)
      if (typeof input.text === 'string' && input.text.length <= 16) wc.insertText(input.text);
      break;
    case 'key': { // tecla especial ou atalho (Enter, Backspace, setas, Ctrl+A…)
      if (typeof input.key !== 'string' || input.key.length > 20) return;
      const keyCode = KEY_ALIASES[input.key] ?? (input.key.length === 1 ? input.key.toUpperCase() : input.key);
      wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      if (keyCode === 'Enter' && !modifiers.some((m) => m !== 'shift')) wc.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
      wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
      break;
    }
  }
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
  const child = { id: crypto.randomUUID(), parentId, url, createdBy: 'user' };
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
    account.mcpAllowed
      ? { label: 'Retirar acesso do Claude Code', click: () => setMcpAllowed(id, false) }
      : { label: 'Permitir Claude Code', enabled: !locked, click: () => setMcpAllowed(id, true) },
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

// ---------- Claude Code (MCP) ----------
// Regras em planos/mcp-claude-code.md. O servidor (src/mcp.js) só chama as funções
// de mcpApi, que checam aqui a liberação da conta e o PIN.

let mcpServer = null;     // { close } enquanto o servidor está ligado
let mcpConnected = false; // houve requisição do Claude Code há pouco (indicador na barra)
let mcpIdleTimer = null;
const MCP_IDLE_MS = 30_000;
const MAX_AGENT_CHILDREN = 5; // por conta
const LOAD_TIMEOUT_MS = 30_000;

const tokenFile = () => path.join(app.getPath('userData'), 'mcp-token');

function mcpToken() {
  try {
    const token = fs.readFileSync(tokenFile(), 'utf8').trim();
    if (token) return token;
  } catch {}
  return regenerateMcpToken({ silent: true });
}

function regenerateMcpToken({ silent } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(tokenFile(), token, { mode: 0o600 });
  if (silent !== true) {
    dialog.showMessageBox(win, {
      type: 'info',
      message: 'Novo token gerado.',
      detail: 'O comando antigo do Claude Code deixou de funcionar. Use "Copiar comando do Claude Code" e rode-o de novo ' +
        '(antes, "claude mcp remove multiverse").',
    });
  }
  return token;
}

const mcpCommand = () =>
  `claude mcp add --transport http multiverse http://127.0.0.1:${state.mcp.port}/mcp ` +
  `--header "Authorization: Bearer ${mcpToken()}"`;

function copyMcpCommand() {
  clipboard.writeText(mcpCommand());
  dialog.showMessageBox(win, {
    type: 'info',
    message: 'Comando copiado.',
    detail: 'Cole e rode no terminal para adicionar o Multiverse ao Claude Code.\n\n' +
      'O comando contém o token de acesso: não compartilhe.' +
      (mcpServer ? '' : '\n\nO servidor está desligado: ligue em Contas → Claude Code (MCP) → Servidor ligado.'),
  });
}

function markMcpActivity() {
  clearTimeout(mcpIdleTimer);
  mcpIdleTimer = setTimeout(() => { mcpConnected = false; broadcast(); }, MCP_IDLE_MS);
  if (!mcpConnected) { mcpConnected = true; broadcast(); }
}

async function startMcp() {
  if (mcpServer) return;
  try {
    mcpServer = await startMcpServer({
      port: state.mcp.port,
      getToken: mcpToken,
      api: mcpApi,
      version: app.getVersion(),
      onActivity: markMcpActivity,
    });
  } catch (err) {
    state.mcp.enabled = false;
    saveState();
    buildMenu();
    dialog.showMessageBox(win, {
      type: 'error',
      message: 'Não foi possível ligar o servidor do Claude Code.',
      detail: err.code === 'EADDRINUSE'
        ? `A porta ${state.mcp.port} já está em uso. Feche o outro programa ou mude "mcp.port" em accounts.json.`
        : String(err.message ?? err),
    });
  }
  broadcast();
}

async function stopMcp() {
  const server = mcpServer;
  mcpServer = null;
  clearTimeout(mcpIdleTimer);
  mcpConnected = false;
  broadcast();
  await server?.close();
}

function setMcpEnabled(enabled) {
  state.mcp.enabled = enabled;
  saveState();
  enabled ? startMcp() : stopMcp();
}

function setMcpAllowed(id, allowed) {
  const account = state.accounts.find((a) => a.id === id);
  if (!account) return;
  if (allowed) {
    account.mcpAllowed = true;
  } else {
    delete account.mcpAllowed;
    // Retirar o acesso fecha na hora as filhas que o Claude Code criou nesta conta.
    for (const child of children.filter((c) => c.parentId === id && c.createdBy === 'agent')) closeChild(child.id);
  }
  saveState();
  broadcast();
}

// Conta que o Claude Code pode usar agora; senão, erro explicado.
function mcpAccount(id) {
  const account = state.accounts.find((a) => a.id === id);
  if (!account?.mcpAllowed) throw new ToolError(`Conta "${id}" não existe ou não está liberada. Use list_accounts.`);
  if (isLocked(id)) throw new ToolError(`A conta "${account.name}" está bloqueada por PIN. Peça ao usuário para desbloqueá-la no Multiverse.`);
  if (!win) throw new ToolError('A janela do Multiverse está fechada.');
  return account;
}

// Garante a página da aba criada (as abas carregam sob demanda) e espera terminar de carregar.
async function loadedView(tab, timeoutMs = LOAD_TIMEOUT_MS) {
  const view = ensureView(tab);
  placeView(tab.id, view); // sem layout(): não rouba o foco do usuário
  await waitLoad(view.webContents, timeoutMs);
  return view;
}

async function waitLoad(wc, timeoutMs = LOAD_TIMEOUT_MS) {
  if (!wc.isLoading()) return;
  await Promise.race([new Promise((r) => wc.once('did-stop-loading', r)), delay(timeoutMs)]);
}

// Superfície de desenho para aba escondida. O Chromium não desenha uma aba escondida,
// e sem superfície não há print (erro) nem destino para cliques de mouse (somem em
// silêncio). Isso vale para aba nunca mostrada e depois de cada navegação. Então,
// durante a ação, a aba fica "visível" com o tamanho normal, mas quase toda fora da
// janela: só 1 px à mostra na borda direita. O usuário não percebe e o foco não muda.
// Testado no Electron 45 (planos/mcp-claude-code.md).
const surfaceUsers = new Map(); // view -> ações em andamento (várias podem se sobrepor)

async function withSurface(id, view, fn) {
  if (isOffscreen(view)) return fn(); // filha do Claude Code: sempre desenhada (na memória)
  if (view.getVisible() && !surfaceUsers.has(view)) return fn(); // à mostra de verdade
  const users = surfaceUsers.get(view) ?? 0;
  surfaceUsers.set(view, users + 1);
  if (users === 0) {
    view.setBounds({ ...view.getBounds(), x: win.getContentBounds().width - 1 });
    view.setVisible(true);
  }
  try {
    await delay(250); // dá tempo de o Chromium criar a superfície e desenhar
    return await fn();
  } finally {
    const left = surfaceUsers.get(view) - 1;
    if (left > 0) {
      surfaceUsers.set(view, left);
    } else {
      surfaceUsers.delete(view);
      // Devolve tamanho e visibilidade certos (a aba pode ter virado a ativa no meio), sem roubar o foco.
      if (win && views.get(id) === view) placeView(id, view);
    }
  }
}

async function capturePng(id, view) {
  return withSurface(id, view, async () => {
    const image = await view.webContents.capturePage();
    if (image.isEmpty()) {
      throw new ToolError('O print da aba da conta veio vazio: a janela do Multiverse está minimizada ou coberta. ' +
        'Use read_account_tab (funciona sempre) ou trabalhe numa aba filha (prints funcionam sempre).');
    }
    return image.toPNG();
  });
}

// ----- scripts injetados -----
// Rodam num "mundo isolado": veem o mesmo DOM da página, mas não as variáveis dela,
// e a página não os vê. Só eval_js roda no mundo da página (como no Chrome).
const ISOLATED_WORLD = 1000;
const isolated = (wc, code) => wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code }]);

const READ_PAGE_JS = '({ url: location.href, title: document.title, text: document.body ? document.body.innerText : "" })';

// Marca os elementos interativos com data-mv-ref="N" e devolve a lista.
const SNAPSHOT_JS = (max) => `(() => {
  for (const el of document.querySelectorAll('[data-mv-ref]')) el.removeAttribute('data-mv-ref');
  const sel = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[contenteditable=""],[contenteditable=true],' +
    '[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=option],' +
    '[role=textbox],[role=combobox],[role=searchbox],[tabindex]:not([tabindex="-1"])';
  const out = [];
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const st = getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none' || el.closest('[aria-hidden=true]')) continue;
    if (n >= ${max}) break;
    el.setAttribute('data-mv-ref', String(++n));
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? 'input:' + (el.type || 'text') : el.isContentEditable ? 'editor' : tag);
    const name = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('title') ||
      el.getAttribute('alt') || el.getAttribute('name') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    const item = { ref: n, role, name };
    if (tag !== 'button' && el.type !== 'password' && typeof el.value === 'string' && el.value) item.value = el.value.slice(0, 80);
    if (tag === 'a') item.href = el.href;
    if (el.disabled) item.disabled = true;
    if (el.type === 'checkbox' || el.type === 'radio') item.checked = el.checked;
    if (!(r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth)) item.offscreen = true;
    out.push(item);
  }
  return { url: location.href, title: document.title, elements: out, more: n >= ${max},
    text: document.body ? document.body.innerText : '' };
})()`;

// Rola até o elemento e devolve o centro dele (px CSS da janela da página).
const ELEMENT_POINT_JS = (ref) => `(() => {
  const el = document.querySelector('[data-mv-ref="${ref}"]');
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`;

// Foca o campo e, se pedido, seleciona o conteúdo (o texto digitado substitui).
const FOCUS_JS = (ref, clear) => `(() => {
  const el = document.querySelector('[data-mv-ref="${ref}"]');
  if (!el) return false;
  el.focus();
  if (${clear}) {
    if (typeof el.select === 'function') el.select();
    else if (el.isContentEditable) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const s = getSelection(); s.removeAllRanges(); s.addRange(range);
    }
  }
  return true;
})()`;

const refMissing = (ref) => new ToolError(`Elemento [${ref}] não encontrado (a página mudou?). Rode snapshot de novo.`);

// ----- teclado e mouse (eventos confiáveis, como os de uma pessoa) -----

const KEY_ALIASES = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', ' ': 'Space', Esc: 'Escape', Return: 'Enter', Del: 'Delete' };
const MODIFIERS = { control: 'control', ctrl: 'control', shift: 'shift', alt: 'alt', option: 'alt', meta: 'meta', cmd: 'meta', command: 'meta' };

function pressKey(wc, combo) {
  const parts = String(combo).split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new ToolError('Tecla vazia.');
  const modifiers = [];
  for (const p of parts.slice(0, -1)) {
    const m = MODIFIERS[p.toLowerCase()];
    if (!m) throw new ToolError(`Modificador desconhecido: "${p}". Use Control, Shift, Alt ou Meta.`);
    modifiers.push(m);
  }
  const raw = parts.at(-1);
  const keyCode = KEY_ALIASES[raw] ?? raw;
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  // Caractere digitável (ou Enter) sem Ctrl/Alt/Meta também gera o evento "char".
  const plain = !modifiers.some((m) => m !== 'shift');
  if (plain && (keyCode.length === 1 || keyCode === 'Enter' || keyCode === 'Space')) {
    const ch = keyCode === 'Enter' ? '\r' : keyCode === 'Space' ? ' ' : keyCode;
    wc.sendInputEvent({ type: 'char', keyCode: ch, modifiers });
  }
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
}

function clickAt(wc, x, y, { double = false, button = 'left' } = {}) {
  const z = wc.getZoomFactor(); // coordenadas da página (CSS) → da aba
  const at = { x: Math.round(x * z), y: Math.round(y * z), button };
  wc.sendInputEvent({ type: 'mouseMove', ...at });
  for (let i = 1; i <= (double ? 2 : 1); i++) {
    wc.sendInputEvent({ type: 'mouseDown', ...at, clickCount: i });
    wc.sendInputEvent({ type: 'mouseUp', ...at, clickCount: i });
  }
}

// Depois de uma ação: espera um pouco e, se ela disparou navegação, o carregamento.
async function settle(wc) {
  await delay(300);
  await waitLoad(wc);
  return { url: wc.getURL(), title: wc.getTitle() };
}

// ----- filhas do Claude Code -----

const agentChildCount = (accountId) => children.filter((c) => c.parentId === accountId && c.createdBy === 'agent').length;

// Cria a filha em segundo plano: não troca a aba que o usuário está vendo.
function spawnAgentChild(parentId, url) {
  const child = { id: crypto.randomUUID(), parentId, url, createdBy: 'agent' };
  children.push(child);
  const view = ensureView(child);
  placeView(child.id, view);
  broadcast();
  return { child, view };
}

// Filha que o Claude Code pode usar: criada por ele, numa conta liberada e desbloqueada.
function agentTab(childId) {
  const child = children.find((c) => c.id === childId && c.createdBy === 'agent');
  if (!child) throw new ToolError(`Aba "${childId}" não existe ou não foi criada pelo Claude Code. Use list_accounts.`);
  mcpAccount(child.parentId);
  const view = ensureView(child);
  return { child, view, wc: view.webContents };
}

function checkedUrl(raw) {
  const url = normalizeUrl(raw);
  if (!url) throw new ToolError(`URL inválida: "${raw}". Use http:// ou https://.`);
  return url;
}

async function loadInto(wc, url) {
  try {
    await Promise.race([wc.loadURL(url), delay(LOAD_TIMEOUT_MS)]);
  } catch (err) {
    // ERR_ABORTED acontece quando a página redireciona no meio do carregamento: não é falha.
    if (err.code !== 'ERR_ABORTED') throw new ToolError(`Não foi possível abrir ${url}: ${err.code ?? err.message}`);
  }
  await waitLoad(wc);
  return { url: wc.getURL(), title: wc.getTitle() };
}

const truncate = (text, max) => ({ text: text.slice(0, max), truncated: text.length > max });

function formatSnapshot(page, maxChars) {
  const lines = page.elements.map((e) => {
    const extra = [
      e.value !== undefined && `valor="${e.value}"`,
      e.checked !== undefined && (e.checked ? 'marcado' : 'desmarcado'),
      e.disabled && 'desativado',
      e.offscreen && 'fora da tela',
      e.href && `→ ${e.href}`,
    ].filter(Boolean).join(', ');
    return `[${e.ref}] ${e.role} "${e.name}"${extra ? ` (${extra})` : ''}`;
  });
  const { text, truncated } = truncate(page.text, maxChars);
  return `URL: ${page.url}\nTítulo: ${page.title}\n\n` +
    `Elementos interativos (use o número em click/type):\n${lines.join('\n') || '(nenhum)'}` +
    `${page.more ? '\n… (lista cortada; role a página e rode snapshot de novo)' : ''}\n\n` +
    `Texto da página${truncated ? ' (cortado)' : ''}:\n${text}`;
}

const mcpApi = {
  listAccounts() {
    return state.accounts.filter((a) => a.mcpAllowed).map((a) => ({
      id: a.id,
      name: a.name,
      locked: isLocked(a.id),
      agent_children: isLocked(a.id) ? [] : children
        .filter((c) => c.parentId === a.id && c.createdBy === 'agent')
        .map((c) => ({ id: c.id, url: views.get(c.id)?.webContents.getURL() || c.url, title: c.title ?? '', loading: loading.has(c.id) })),
      max_children: MAX_AGENT_CHILDREN,
    }));
  },

  // --- aba da conta (somente leitura) ---

  async readAccountTab(id, maxChars) {
    const { webContents: wc } = await loadedView(mcpAccount(id));
    const page = await isolated(wc, READ_PAGE_JS);
    return { url: page.url, title: page.title, ...truncate(page.text, maxChars) };
  },

  async screenshotAccountTab(id) {
    return capturePng(id, await loadedView(mcpAccount(id)));
  },

  // --- filhas ---

  async createChild(accountId, rawUrl) {
    mcpAccount(accountId);
    const url = checkedUrl(rawUrl);
    if (agentChildCount(accountId) >= MAX_AGENT_CHILDREN) {
      throw new ToolError(`Limite de ${MAX_AGENT_CHILDREN} abas filhas por conta. Feche alguma com close_child.`);
    }
    const { child, view } = spawnAgentChild(accountId, url);
    await waitLoad(view.webContents);
    return { child_id: child.id, url: view.webContents.getURL(), title: view.webContents.getTitle() };
  },

  closeChild(childId) {
    agentTab(childId);
    closeChild(childId);
    return { closed: childId };
  },

  async navigate(childId, rawUrl) {
    return loadInto(agentTab(childId).wc, checkedUrl(rawUrl));
  },

  async history(childId, action) {
    const { wc } = agentTab(childId);
    const nav = wc.navigationHistory;
    if (action === 'back') {
      if (!nav.canGoBack()) throw new ToolError('Não há página anterior.');
      nav.goBack();
    } else if (action === 'forward') {
      if (!nav.canGoForward()) throw new ToolError('Não há página seguinte.');
      nav.goForward();
    } else {
      wc.reload();
    }
    return settle(wc);
  },

  async readPage(childId, maxChars) {
    const { wc } = agentTab(childId);
    await waitLoad(wc);
    const page = await isolated(wc, READ_PAGE_JS);
    return { url: page.url, title: page.title, ...truncate(page.text, maxChars) };
  },

  async snapshot(childId, maxChars, maxElements) {
    const { wc } = agentTab(childId);
    await waitLoad(wc);
    return formatSnapshot(await isolated(wc, SNAPSHOT_JS(maxElements)), maxChars);
  },

  async screenshot(childId) {
    const { child, view } = agentTab(childId);
    await waitLoad(view.webContents);
    return capturePng(child.id, view);
  },

  async click(childId, { ref, x, y, double, button }) {
    const { child, view, wc } = agentTab(childId);
    if (ref === undefined && (x === undefined || y === undefined)) throw new ToolError('Informe ref (de snapshot) ou x e y.');
    await withSurface(child.id, view, async () => {
      let point = { x, y };
      if (ref !== undefined) {
        point = await isolated(wc, ELEMENT_POINT_JS(ref));
        if (!point) throw refMissing(ref);
        await delay(100); // deixa a rolagem assentar
      }
      clickAt(wc, point.x, point.y, { double, button });
      await delay(50); // o clique precisa ser entregue antes de a aba voltar a se esconder
    });
    return settle(wc);
  },

  async type(childId, { ref, text, clear, submit }) {
    const { child, view, wc } = agentTab(childId);
    if (ref !== undefined) {
      // Clique de verdade antes (editores como o da claude.ai só ativam assim), depois foco/seleção.
      await withSurface(child.id, view, async () => {
        const point = await isolated(wc, ELEMENT_POINT_JS(ref));
        if (!point) throw refMissing(ref);
        await delay(100);
        clickAt(wc, point.x, point.y);
        await delay(100);
      });
      if (!(await isolated(wc, FOCUS_JS(ref, !!clear)))) throw refMissing(ref);
    } else if (clear) {
      pressKey(wc, process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    }
    await wc.insertText(text);
    if (submit) pressKey(wc, 'Enter');
    return settle(wc);
  },

  async pressKey(childId, key) {
    const { wc } = agentTab(childId);
    pressKey(wc, key);
    return settle(wc);
  },

  async scroll(childId, { ref, dy }) {
    const { wc } = agentTab(childId);
    if (ref !== undefined) {
      if (!(await isolated(wc, ELEMENT_POINT_JS(ref)))) throw refMissing(ref);
    } else {
      await isolated(wc, `window.scrollBy(0, ${Number(dy) || 0})`);
    }
    return isolated(wc, '({ scrollY: Math.round(scrollY), height: document.documentElement.scrollHeight, viewport: innerHeight })');
  },

  async waitFor(childId, { selector, text, timeoutMs }) {
    const { wc } = agentTab(childId);
    const start = Date.now();
    await waitLoad(wc, timeoutMs);
    if (!selector && !text) return { ok: true, waited_ms: Date.now() - start };
    // O texto vale se estiver visível na página ou num aria-label/title (botões só com ícone).
    const check = `(() => {
      const hasText = (t) => (document.body && document.body.innerText.includes(t)) ||
        [...document.querySelectorAll('[aria-label], [title]')].some((el) =>
          (el.getAttribute('aria-label') || '').includes(t) || (el.getAttribute('title') || '').includes(t));
      ${selector ? `if (!document.querySelector(${JSON.stringify(selector)})) return false;` : ''}
      ${text ? `if (!hasText(${JSON.stringify(text)})) return false;` : ''} return true; })()`;
    while (Date.now() - start < timeoutMs) {
      try {
        if (await isolated(wc, check)) return { ok: true, waited_ms: Date.now() - start };
      } catch {} // a página pode estar trocando no meio
      await delay(250);
    }
    throw new ToolError(`Tempo esgotado (${timeoutMs} ms) esperando ${selector ? `o seletor ${selector}` : ''}${selector && text ? ' e ' : ''}${text ? `o texto "${text}"` : ''}. ` +
      'A página pode ainda estar carregando ou processando (respostas de IA podem levar mais tempo): ' +
      'chame wait_for de novo ou use um timeout_ms maior (até 60000). Rode snapshot para ver o estado atual.');
  },

  // Roda no mundo da própria página (acesso às variáveis dela), como no Chrome.
  async evalJs(childId, code, maxChars) {
    const { wc } = agentTab(childId);
    let result;
    try {
      result = await Promise.race([
        wc.executeJavaScript(code, true),
        delay(LOAD_TIMEOUT_MS).then(() => { throw new Error('tempo esgotado (30 s)'); }),
      ]);
    } catch (err) {
      throw new ToolError(`Erro no JavaScript: ${err.message}`);
    }
    const json = result === undefined ? 'undefined' : JSON.stringify(result, null, 2) ?? String(result);
    return truncate(json, maxChars);
  },
};

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
ipcMain.on('mirror:input', (_e, id, input) => mirrorInput(id, input));

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
        {
          label: 'Claude Code (MCP)',
          submenu: [
            { label: 'Servidor ligado', type: 'checkbox', checked: !!state.mcp?.enabled, click: (item) => setMcpEnabled(item.checked) },
            { label: 'Copiar comando do Claude Code', click: copyMcpCommand },
            { label: 'Gerar novo token', click: regenerateMcpToken },
          ],
        },
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
  win.on('blur', blurMirror); // o app perdeu o foco: a página da filha também
  win.on('closed', () => {
    win = null;
    // As janelas invisíveis das filhas do Claude Code fecham junto (senão o app não encerra).
    for (const view of views.values()) view.host?.destroy();
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
  if (state.mcp.enabled) startMcp();
}

app.whenReady().then(() => {
  app.dock?.setIcon(ICON);
  createWindow();
  buildMenu(); // depois de carregar o estado (o item "Servidor ligado" depende dele)
  app.on('activate', () => {
    if (!win) createWindow();
  });
});

app.on('will-quit', () => { mcpServer?.close(); });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
