const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tabs', {
  platform: process.platform,
  get: () => ipcRenderer.invoke('tabs:get'),
  newTab: () => ipcRenderer.send('tabs:new'),
  activate: (id) => ipcRenderer.send('tabs:activate', id),
  rename: (id, name) => ipcRenderer.send('tabs:rename', id, name),
  reload: (id) => ipcRenderer.send('tabs:reload', id),
  contextMenu: (id) => ipcRenderer.send('tabs:context', id),
  onUpdate: (fn) => ipcRenderer.on('tabs:update', (_e, state) => fn(state)),
  onRename: (fn) => ipcRenderer.on('ui:rename', (_e, id) => fn(id)),
});
