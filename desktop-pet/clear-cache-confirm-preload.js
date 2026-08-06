'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// 「清除本機快取並重開」確認視窗專用的 preload，跟 settings-preload.js／
// name-manager-preload.js 一樣各自獨立。開窗時接收要被清掉的資料夾路徑（純顯示用，
// 讓使用者自己判斷要不要先備份），「清除並重開」「取消」都送回 main.js 處理，
// renderer 端不會碰到任何 Node/檔案系統 API。
contextBridge.exposeInMainWorld('clearCacheConfirm', {
  onInit: (callback) => ipcRenderer.on('init', (_event, data) => callback(data)),
  confirm: () => ipcRenderer.send('clear-cache-confirm'),
  cancel: () => ipcRenderer.send('clear-cache-cancel'),
});
