const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('myLogger', {
  log: (...args) => ipcRenderer.send('log', ...args)
});
