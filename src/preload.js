const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tabs', {
  platform: process.platform,
  get: () => ipcRenderer.invoke('tabs:get'),
  add: (name) => ipcRenderer.send('tabs:add', name),
  activate: (id) => ipcRenderer.send('tabs:activate', id),
  rename: (id, name) => ipcRenderer.send('tabs:rename', id, name),
  reload: (id) => ipcRenderer.send('tabs:reload', id),
  contextMenu: (id) => ipcRenderer.send('tabs:context', id),
  addChild: (parentId, url) => ipcRenderer.send('tabs:add-child', parentId, url),
  closeChild: (id) => ipcRenderer.send('tabs:close-child', id),
  setPin: (id, pin) => ipcRenderer.invoke('pin:set', id, pin),
  removePin: (id, pin) => ipcRenderer.invoke('pin:remove', id, pin),
  unlock: (id, pin) => ipcRenderer.invoke('pin:unlock', id, pin),
  setModal: (open) => ipcRenderer.send('ui:modal', open),
  onPin: (fn) => ipcRenderer.on('ui:pin', (_e, req) => fn(req)),
  mirrorInput: (id, input) => ipcRenderer.send('mirror:input', id, input),
  onMirror: (fn) => ipcRenderer.on('mirror:frame', (_e, frame) => fn(frame)),
  onAddChild: (fn) => ipcRenderer.on('ui:add-child', (_e, parentId) => fn(parentId)),
  onUpdate: (fn) => ipcRenderer.on('tabs:update', (_e, state) => fn(state)),
  onNewTab: (fn) => ipcRenderer.on('ui:new-tab', () => fn()),
  onRename: (fn) => ipcRenderer.on('ui:rename', (_e, id) => fn(id)),
});
