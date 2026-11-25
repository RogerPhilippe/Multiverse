const bar = document.getElementById('bar');
const COLORS = ['#d97757', '#6a9bcc', '#788c5d', '#c4a35a', '#a77bca', '#cc6a8f', '#5fa8a0', '#b0aea5'];

let state = { accounts: [], children: [], activeId: null, loading: [] };
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
      bar.append(childTab(child, account, color, loading.has(child.id)));
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

function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

// Aba filha: mesma cor da conta pai, mesma sessão, fecha no ×.
function childTab(child, parent, color, isLoading) {
  const tab = document.createElement('div');
  tab.className = 'tab child' + (child.id === state.activeId ? ' active' : '');
  tab.style.setProperty('--parent-color', color);
  const label = child.title || hostOf(child.url);
  tab.title = `${label}\nAba filha de "${parent.name}" (mesma sessão)\n${child.url}` +
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

  tab.append(dot, name, close);
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
  // Não recria a barra enquanto se digita a URL (perderia o texto); o campo é
  // atualizado ao terminar.
  if (childParentId && document.activeElement?.classList.contains('child-input')) return;
  render();
});
window.tabs.onNewTab(startAdding);
window.tabs.onRename((id) => { editingId = id; render(); });
window.tabs.onAddChild((parentId) => { childParentId = parentId; render(); });
window.tabs.get().then((s) => { state = s; render(); });
