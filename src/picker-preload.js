const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('picker', {
  services: () => ipcRenderer.invoke('picker:services'),
  pick: (serviceId) => ipcRenderer.send('picker:pick', serviceId),
  cancel: () => ipcRenderer.send('picker:cancel'),
});
