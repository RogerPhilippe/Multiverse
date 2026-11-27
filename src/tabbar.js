const bar = document.getElementById('bar');
const COLORS = ['#d97757', '#6a9bcc', '#788c5d', '#c4a35a', '#a77bca', '#cc6a8f', '#5fa8a0', '#b0aea5'];

const panel = document.getElementById('panel');
let state = { accounts: [], children: [], locked: [], activeId: null, loading: [] };
let pinRequest = null;    // diálogo de PIN aberto: { mode: 'set' | 'remove', id, name }
let panelKey = null;      // o que #panel mostra agora (não recria enquanto se digita)
let editingId = null;     // aba sendo renomeada
let adding = false;       // campo de "nova conta" aberto
let childParentId = null; // conta cujo campo de URL da "nova aba filha" está aberto

document.body.classList.add(window.tabs.platform);

// sticky: não cancela ao perder o foco (só Enter/Esc), para dar tempo de ir
// copiar a URL em outro app.
function inlineInput(value, placeholder, onCommit, onCancel, sticky = false) {
  const input = document.createElement('input');
  input.value = value;
  input.placeholder = placeholder;
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    commit ? onCommit(input.value) : onCancel();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  if (!sticky) input.addEventListener('blur', () => finish(false));
  requestAnimationFrame(() => { input.focus(); input.select(); });
  return input;
}

function render() {
  bar.replaceChildren();
  const loading = new Set(state.loading);

  state.accounts.forEach((account, i) => {
    const tab = document.createElement('div');
    tab.className = 'tab' + (account.id === state.activeId ? ' active' : '');
    tab.title = `${account.name}${account.title ? ' — ' + account.title : ''}` +
      `${loading.has(account.id) ? ' (carregando…)' : ''}\n` +
      `${i < 9 ? `⌘${i + 1} · ` : ''}clique direito para mais opções`;

    const dot = document.createElement('span');
    dot.className = 'dot';
    const color = COLORS[i % COLORS.length];
    if (loading.has(account.id)) {
      dot.classList.add('loading'); // anel girando enquanto a aba carrega
      dot.style.borderColor = color;
    } else {
      dot.style.background = color;
    }
    tab.append(dot);
    const locked = state.locked.includes(account.id);
    if (account.hasPin) tab.append(lockIcon(locked));
    if (account.mcpAllowed) tab.append(mcpIcon());

    if (editingId === account.id) {
      tab.append(inlineInput(account.name, 'Nome da conta',
        (name) => { editingId = null; window.tabs.rename(account.id, name); render(); },
        () => { editingId = null; render(); }));
    } else {
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = account.name;
      tab.append(name);
    }

    tab.addEventListener('mousedown', (e) => {
      if (e.button === 0 && editingId !== account.id) window.tabs.activate(account.id);
    });
    tab.addEventListener('dblclick', () => { editingId = account.id; render(); });
    tab.addEventListener('auxclick', (e) => { if (e.button === 1) window.tabs.reload(account.id); });
    tab.addEventListener('contextmenu', (e) => { e.preventDefault(); window.tabs.contextMenu(account.id); });
    bar.append(tab);

    for (const child of state.children.filter((c) => c.parentId === account.id)) {
      bar.append(childTab(child, account, color, loading.has(child.id), locked));
    }

    // Campo de URL da nova filha: só aparece até ser preenchido.
    if (childParentId === account.id) {
      const input = inlineInput('', 'Cole a URL e tecle Enter',
        (url) => { childParentId = null; if (url.trim()) window.tabs.addChild(account.id, url); render(); },
        () => { childParentId = null; render(); }, true);
      input.className = 'child-input';
      input.style.borderColor = color;
      bar.append(input);
    }
  });

  if (adding) {
    const input = inlineInput('', `Conta ${state.accounts.length + 1}`,
      (name) => { adding = false; window.tabs.add(name); render(); },
      () => { adding = false; render(); });
    input.id = 'new-input';
    bar.append(input);
  } else {
    const add = document.createElement('button');
    add.id = 'add';
    add.textContent = '+';
    add.title = 'Nova conta (⌘T)';
    add.addEventListener('click', startAdding);
    bar.append(add);
  }
}

// 🤖 na conta liberada para o Claude Code: apagado com o servidor desligado,
// aceso quando o Claude Code fez requisições há pouco.
function mcpIcon() {
  const el = document.createElement('span');
  const { on, connected } = state.mcp ?? {};
  el.className = 'mcp' + (on ? ' on' : '') + (connected ? ' live' : '');
  el.textContent = '🤖';
  el.title = !on ? 'Liberada para o Claude Code (servidor desligado: Contas → Claude Code (MCP))'
    : connected ? 'Claude Code conectado' : 'Liberada para o Claude Code';
  return el;
}

function lockIcon(locked) {
  const el = document.createElement('span');
  el.className = 'lock';
  el.textContent = locked ? '🔒' : '🔓';
  el.title = locked ? 'Bloqueada: digite o PIN' : 'Com PIN (desbloqueada)';
  return el;
}

// ---------- PIN: tela de bloqueio e diálogo ----------

function pinBox({ icon, title, text, fields, submitLabel, onSubmit, onCancel }) {
  const box = document.createElement('form');
  box.className = 'pin-box';
  const h = document.createElement('h2');
  h.textContent = title;
  const p = document.createElement('p');
  p.textContent = text;
  const ic = document.createElement('div');
  ic.className = 'icon';
  ic.textContent = icon;
  const inputs = fields.map((placeholder) => {
    const input = document.createElement('input');
    input.type = 'password';
    input.placeholder = placeholder;
    input.autocomplete = 'off';
    return input;
  });
  const error = document.createElement('div');
  error.className = 'error';
  const buttons = document.createElement('div');
  buttons.className = 'buttons';
  if (onCancel) {
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancelar';
    cancel.addEventListener('click', onCancel);
    buttons.append(cancel);
  }
  const ok = document.createElement('button');
  ok.type = 'submit';
  ok.className = 'primary';
  ok.textContent = submitLabel;
  buttons.append(ok);

  box.addEventListener('keydown', (e) => { if (e.key === 'Escape' && onCancel) onCancel(); });
  box.addEventListener('submit', async (e) => {
    e.preventDefault();
    ok.disabled = true;
    error.textContent = '';
    const message = await onSubmit(inputs.map((i) => i.value));
    ok.disabled = false;
    if (message) {
      error.textContent = message;
      inputs.forEach((i) => { i.value = ''; });
      inputs[0].focus();
    }
  });
  box.append(ic, h, p, ...inputs, error, buttons);
  requestAnimationFrame(() => inputs[0].focus());
  return box;
}

// ---------- espelho da aba do Claude Code ----------
// A aba do Claude Code é desenhada fora da tela (funciona com o app minimizado).
// Aqui aparecem os quadros dela ao vivo, e cliques, rolagem e teclas vão para ela.

let mirror = null; // { id, img }

function buildMirror(id) {
  panel.classList.add('mirror');
  panel.tabIndex = 0;
  const img = document.createElement('img');
  img.alt = '';
  img.draggable = false;
  const badge = document.createElement('div');
  badge.className = 'badge';
  badge.textContent = '🤖 Aba do Claude Code · você também pode clicar e digitar aqui';
  // Recebe o texto já composto pelo sistema (acentos, teclas mortas, IME, colar).
  const input = document.createElement('textarea');
  input.className = 'mirror-input';
  input.setAttribute('aria-label', 'Digitar na aba do Claude Code');
  panel.append(img, badge, input);
  mirror = { id, img, input };

  // Posição na página: a imagem fica em escala (object-fit: contain), alinhada ao topo à esquerda.
  const at = (e) => {
    const r = img.getBoundingClientRect();
    const scale = img.naturalWidth ? Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight) : 1;
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  };
  const mods = (e) => ({ shift: e.shiftKey, control: e.ctrlKey, alt: e.altKey, meta: e.metaKey });
  const send = (input) => window.tabs.mirrorInput(id, input);
  const button = (e) => ['left', 'middle', 'right'][e.button] ?? 'left';

  img.addEventListener('mousedown', (e) => {
    e.preventDefault();
    input.focus();
    send({ kind: 'mouse', type: 'mouseDown', ...at(e), button: button(e), clickCount: e.detail, ...mods(e) });
  });
  img.addEventListener('mouseup', (e) => send({ kind: 'mouse', type: 'mouseUp', ...at(e), button: button(e), clickCount: e.detail, ...mods(e) }));
  let lastMove = 0;
  img.addEventListener('mousemove', (e) => {
    if (Date.now() - lastMove < 40) return; // hover e arrastar, sem inundar
    lastMove = Date.now();
    send({ kind: 'mouse', type: 'mouseMove', ...at(e), button: button(e), ...mods(e) });
  });
  img.addEventListener('wheel', (e) => {
    e.preventDefault();
    send({ kind: 'wheel', ...at(e), deltaX: e.deltaX, deltaY: e.deltaY, ...mods(e) });
  }, { passive: false });
  img.addEventListener('contextmenu', (e) => e.preventDefault());

  // Texto: chega pelo evento input do campo invisível (já com acento/IME/colar).
  input.addEventListener('input', (e) => {
    if (e.isComposing) return;
    if (input.value) send({ kind: 'text', text: input.value.slice(0, 16) });
    input.value = '';
  });
  input.addEventListener('compositionend', () => {
    if (input.value) send({ kind: 'text', text: input.value.slice(0, 16) });
    input.value = '';
  });
  // Teclas especiais e atalhos (Enter, Backspace, setas, Tab, Ctrl+A…) vão como tecla.
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Dead', 'Unidentified', 'Process'].includes(e.key)) return;
    const combo = e.ctrlKey || e.metaKey || e.altKey;
    const pasting = combo && e.key.toLowerCase() === 'v'; // colar: deixa o campo receber o texto
    if (pasting || (!combo && [...e.key].length === 1)) return; // caractere: vem pelo input
    e.preventDefault();
    send({ kind: 'key', key: e.key, ...mods(e) });
  });
  requestAnimationFrame(() => input.focus());
}

window.tabs.onMirror((frame) => {
  if (mirror && frame.id === mirror.id) mirror.img.src = `data:image/jpeg;base64,${frame.data}`;
});

function closePinDialog() {
  pinRequest = null;
  window.tabs.setModal(false);
  renderPanel();
}

function renderPanel() {
  const active = state.accounts.find((a) => a.id === state.activeId)
    ?? state.children.find((c) => c.id === state.activeId);
  const ownerId = active?.parentId ?? active?.id;
  const owner = state.accounts.find((a) => a.id === ownerId);
  const lockedActive = owner && state.locked.includes(owner.id);

  const agentActive = active?.createdBy === 'agent';
  const key = pinRequest ? `${pinRequest.mode}:${pinRequest.id}`
    : lockedActive ? `unlock:${owner.id}`
    : agentActive ? `mirror:${active.id}` : null;
  if (key === panelKey) return; // já está na tela certa: não apaga o que se digita
  panelKey = key;
  panel.hidden = !key;
  panel.replaceChildren();
  panel.classList.remove('mirror');
  panel.removeAttribute('tabindex');
  mirror = null;
  if (!key) return;

  if (key.startsWith('mirror:')) {
    buildMirror(active.id);
    return;
  }

  if (pinRequest?.mode === 'set') {
    const { id, name } = pinRequest;
    panel.append(pinBox({
      icon: '🔐',
      title: `Definir PIN — ${name}`,
      text: 'A conta e as abas filhas abrem bloqueadas sempre que o app iniciar.',
      fields: ['Novo PIN (mín. 4)', 'Repita o PIN'],
      submitLabel: 'Definir',
      onCancel: closePinDialog,
      onSubmit: async ([pin, again]) => {
        if (pin !== again) return 'Os PINs não conferem.';
        const r = await window.tabs.setPin(id, pin);
        if (!r.ok) return r.error;
        closePinDialog();
      },
    }));
  } else if (pinRequest?.mode === 'remove') {
    const { id, name } = pinRequest;
    panel.append(pinBox({
      icon: '🔓',
      title: `Remover PIN — ${name}`,
      text: 'Digite o PIN atual para remover.',
      fields: ['PIN atual'],
      submitLabel: 'Remover',
      onCancel: closePinDialog,
      onSubmit: async ([pin]) => {
        const r = await window.tabs.removePin(id, pin);
        if (!r.ok) return r.error;
        closePinDialog();
      },
    }));
  } else {
    panel.append(pinBox({
      icon: '🔒',
      title: `${owner.name} está bloqueada`,
      text: active.parentId ? 'Digite o PIN da conta para ver esta aba filha.' : 'Digite o PIN para desbloquear.',
      fields: ['PIN'],
      submitLabel: 'Desbloquear',
      onSubmit: async ([pin]) => {
        const r = await window.tabs.unlock(owner.id, pin);
        if (!r.ok) return r.error;
      },
    }));
  }
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

// Aba filha: mesma cor da conta pai, mesma sessão, fecha no ×.
function childTab(child, parent, color, isLoading, locked) {
  const tab = document.createElement('div');
  tab.className = 'tab child' + (child.id === state.activeId ? ' active' : '');
  tab.style.setProperty('--parent-color', color);
  const label = locked ? 'Bloqueada' : child.title || hostOf(child.url);
  tab.title = `${label}\nAba filha de "${parent.name}" (mesma sessão)\n${child.url ?? ''}` +
    `${isLoading ? '\n(carregando…)' : ''}\nFechar não desconecta a conta.`;

  const dot = document.createElement('span');
  dot.className = 'dot';
  if (isLoading) {
    dot.classList.add('loading');
    dot.style.borderColor = color;
  } else {
    dot.style.background = color;
  }

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = label;

  const close = document.createElement('button');
  close.className = 'close';
  close.textContent = '×';
  close.title = 'Fechar aba filha (⌘W)';
  close.addEventListener('mousedown', (e) => e.stopPropagation());
  close.addEventListener('click', () => window.tabs.closeChild(child.id));

  tab.append(dot);
  if (parent.hasPin) tab.append(lockIcon(locked));
  if (child.createdBy === 'agent') {
    const bot = mcpIcon();
    bot.title = 'Aba criada pelo Claude Code (você pode usar e fechar)';
    tab.append(bot);
  }
  tab.append(name, close);
  tab.addEventListener('mousedown', (e) => { if (e.button === 0) window.tabs.activate(child.id); });
  tab.addEventListener('auxclick', (e) => { if (e.button === 1) window.tabs.reload(child.id); });
  tab.addEventListener('contextmenu', (e) => { e.preventDefault(); window.tabs.contextMenu(child.id); });
  return tab;
}

function startAdding() {
  adding = true;
  render();
}

window.tabs.onUpdate((s) => {
  state = s;
  renderPanel();
  // Não recria a barra enquanto se digita a URL (perderia o texto); o campo é
  // atualizado ao terminar.
  if (childParentId && document.activeElement?.classList.contains('child-input')) return;
  render();
});
window.tabs.onPin((req) => {
  pinRequest = req;
  window.tabs.setModal(true);
  renderPanel();
});
window.tabs.onNewTab(startAdding);
window.tabs.onRename((id) => { editingId = id; render(); });
window.tabs.onAddChild((parentId) => { childParentId = parentId; render(); });
window.tabs.get().then((s) => { state = s; render(); renderPanel(); });
