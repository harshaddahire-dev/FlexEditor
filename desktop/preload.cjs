'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// The only things the page may ask the desktop shell for. No Node, no file access: the page talks to the local server for that.
contextBridge.exposeInMainWorld('cutroomDesktop', {
  platform: process.platform,
  pickFolder: () => ipcRenderer.invoke('cutroom:pick-folder'),
  reveal: (target) => ipcRenderer.invoke('cutroom:reveal', String(target)),
  copyDiagnostics: () => ipcRenderer.invoke('cutroom:diagnostics'),
  updates: {
    get: () => ipcRenderer.invoke('cutroom:update-get'),
    check: () => ipcRenderer.invoke('cutroom:update-check'),
    download: () => ipcRenderer.invoke('cutroom:update-download'),
    install: (force) => ipcRenderer.invoke('cutroom:update-install', force === true),
    setAuto: (on) => ipcRenderer.invoke('cutroom:update-set-auto', on === true),
    /** Subscribe to state changes; returns the unsubscribe function. */
    onState: (cb) => {
      const listener = (_e, state) => cb(state);
      ipcRenderer.on('cutroom:update-state', listener);
      return () => ipcRenderer.removeListener('cutroom:update-state', listener);
    },
  },
});
