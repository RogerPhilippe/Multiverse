const bar = document.getElementById('bar');

let state = { accounts: [], activeId: null, picking: false, services: [] };
let editingId = null; // aba sendo renomeada

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

function tabElement(label, color, active) {
  const tab = document.createElement('div');
  tab.className = 'tab' + (active ? ' active' : '');
  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = color;
  tab.append(dot);
  if (label !== null) {
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = label;
    tab.append(name);
  }
  return tab;
}

function render() {
  bar.replaceChildren();
  const services = Object.fromEntries(state.services.map((s) => [s.id, s]));

  state.accounts.forEach((account, i) => {
    const service = services[account.service];
    const editing = editingId === account.id;
    const tab = tabElement(editing ? null : account.name, service?.color ?? '#b0aea5',
      account.id === state.activeId && !state.picking);
    tab.title = `${account.name} · ${service?.name ?? ''}${account.title ? ' — ' + account.title : ''}\n` +
      `${i < 9 ? `⌘${i + 1} · ` : ''}clique direito para mais opções`;

    if (editing) {
      tab.append(inlineInput(account.name, 'Nome da aba',
        (name) => { editingId = null; window.tabs.rename(account.id, name); render(); },
        () => { editingId = null; render(); }));
    }

    tab.addEventListener('mousedown', (e) => {
      if (e.button === 0 && editingId !== account.id) window.tabs.activate(account.id);
    });
    tab.addEventListener('dblclick', () => { editingId = account.id; render(); });
    tab.addEventListener('auxclick', (e) => { if (e.button === 1) window.tabs.reload(account.id); });
    tab.addEventListener('contextmenu', (e) => { e.preventDefault(); window.tabs.contextMenu(account.id); });
    bar.append(tab);
  });

  if (state.picking) {
    const tab = tabElement('Nova aba', 'transparent', true);
    tab.classList.add('new');
    bar.append(tab);
  }

  const add = document.createElement('button');
  add.id = 'add';
  add.textContent = '+';
  add.title = 'Nova aba (⌘T)';
  add.addEventListener('click', () => window.tabs.newTab());
  bar.append(add);
}

window.tabs.onUpdate((s) => { state = s; render(); });
window.tabs.onRename((id) => { editingId = id; render(); });
window.tabs.get().then((s) => { state = s; render(); });
