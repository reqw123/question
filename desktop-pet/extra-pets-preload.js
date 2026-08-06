'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// 額外寵物勾選視窗專用的 preload（跟 preload.js 分開，因為這是完全不同用途的獨立視窗，
// 不需要也不該共用桌寵主視窗那條 petBridge 通道）。只曝露這個小視窗需要的三件事：
// 開窗時接收候選清單/目前勾選狀態、按「確定套用」時把使用者勾好的清單送回 main.js、
// 按「關閉」時通知 main.js 關掉這個視窗。
contextBridge.exposeInMainWorld('extraPetsPicker', {
  onInit: (callback) => ipcRenderer.on('init', (_event, data) => callback(data)),
  apply: (ids) => ipcRenderer.send('extra-pets-apply', ids),
  close: () => ipcRenderer.send('extra-pets-close'),
});
