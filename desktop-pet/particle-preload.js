'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// 3D 模型（光粒子）專用視窗 particle.html 的 preload。這個視窗蓋住「所有螢幕」的
// 聯集範圍，平常整個視窗都是滑鼠穿透（setIgnoreMouseEvents(true, {forward:true})），
// 只有互動模式下游標停在模型上／正在拖曳時，才請 main process 暫時關掉穿透，
// 讓拖曳/滾輪收得到——不然這個疊在最上層的大視窗會把底下 Live2D 主視窗的點擊全擋掉。
// 只曝露這一個管道，renderer 碰不到任何 Node/Electron API。
contextBridge.exposeInMainWorld('particleBridge', {
  setCaptureMouse: (capture) => ipcRenderer.send('particle-capture-mouse', !!capture),
});
