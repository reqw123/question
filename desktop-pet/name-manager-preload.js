'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// 模型命名管理視窗專用的 preload，跟 preload.js／extra-pets-preload.js 一樣各自獨立，
// 只曝露這個視窗需要的三件事：開窗時接收 manifest/names 資料、按「儲存」把整包
// 名稱對照表送回 main.js 寫檔、按「關閉」通知 main.js 關掉這個視窗。
contextBridge.exposeInMainWorld('nameManager', {
  onInit: (callback) => ipcRenderer.on('init', (_event, data) => callback(data)),
  onSaved: (callback) => ipcRenderer.on('saved', (_event, result) => callback(result)),
  save: (names) => ipcRenderer.send('name-manager-save', names),
  close: () => ipcRenderer.send('name-manager-close'),
});
