'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// contextIsolation:true 讓 renderer（index.html）沒辦法直接 require('electron')，
// 這裡透過 contextBridge 只曝露「回報飛行動畫真的結束了」這一個管道，
// 讓 main.js 的 isFlying 狀態能跟 renderer 的實際動畫狀態同步，
// 不用再靠 main.js 自己猜（猜的話，動作自然播完 vs 被手動停止，main.js 分不出來）。
contextBridge.exposeInMainWorld('petBridge', {
  flyFinished: () => ipcRenderer.send('fly-finished'),
});
