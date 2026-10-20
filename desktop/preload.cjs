'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// The only things the page may ask the desktop shell for. No Node, no file access: the page talks to the local server for that.
contextBridge.exposeInMainWorld('cutroomDesktop', {
  platform: process.platform,
  pickFolder: () => ipcRenderer.invoke('cutroom:pick-folder'),
  reveal: (target) => ipcRenderer.invoke('cutroom:reveal', String(target)),
});
