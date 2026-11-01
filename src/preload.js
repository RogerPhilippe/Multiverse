const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tabs', {
  platform: process.platform,
  get: () => ipcRenderer.invoke('tabs:get'),
  add: (name) => ipcRenderer.send('tabs:add', name),
  activate: (id) => ipcRenderer.send('tabs:activate', id),
  rename: (id, name) => ipcRenderer.send('tabs:rename', id, name),
  reload: (id) => ipcRenderer.send('tabs:reload', id),
  contextMenu: (id) => ipcRenderer.send('tabs:context', id),
  onUpdate: (fn) => ipcRenderer.on('tabs:update', (_e, state) => fn(state)),
  onNewTab: (fn) => ipcRenderer.on('ui:new-tab', () => fn()),
  onRename: (fn) => ipcRenderer.on('ui:rename', (_e, id) => fn(id)),
});
