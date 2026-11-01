const bar = document.getElementById('bar');
const COLORS = ['#d97757', '#6a9bcc', '#788c5d', '#c4a35a', '#a77bca', '#cc6a8f', '#5fa8a0', '#b0aea5'];

let state = { accounts: [], activeId: null };
let editingId = null; // aba sendo renomeada
let adding = false;   // campo de "nova conta" aberto

document.body.classList.add(window.tabs.platform);

function inlineInput(value, placeholder, onCommit, onCancel) {
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
  input.addEventListener('blur', () => finish(false));
  requestAnimationFrame(() => { input.focus(); input.select(); });
  return input;
}

function render() {
  bar.replaceChildren();

  state.accounts.forEach((account, i) => {
    const tab = document.createElement('div');
    tab.className = 'tab' + (account.id === state.activeId ? ' active' : '');
    tab.title = `${account.name}${account.title ? ' — ' + account.title : ''}\n` +
      `${i < 9 ? `⌘${i + 1} · ` : ''}clique direito para mais opções`;

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = COLORS[i % COLORS.length];
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

      const close = document.createElement('button');
      close.className = 'close';
      close.textContent = '×';
      close.title = 'Remover conta';
      close.addEventListener('click', (e) => { e.stopPropagation(); window.tabs.remove(account.id); });
      tab.append(close);
    }

    tab.addEventListener('mousedown', (e) => {
      if (e.button === 0 && editingId !== account.id) window.tabs.activate(account.id);
    });
    tab.addEventListener('dblclick', () => { editingId = account.id; render(); });
    tab.addEventListener('auxclick', (e) => { if (e.button === 1) window.tabs.reload(account.id); });
    tab.addEventListener('contextmenu', (e) => { e.preventDefault(); window.tabs.contextMenu(account.id); });
    bar.append(tab);
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

function startAdding() {
  adding = true;
  render();
}

window.tabs.onUpdate((s) => { state = s; render(); });
window.tabs.onNewTab(startAdding);
window.tabs.onRename((id) => { editingId = id; render(); });
window.tabs.get().then((s) => { state = s; render(); });
