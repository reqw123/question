'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// 「模型設定」視窗（model-config.html）專用的 preload，跟其他編輯視窗一樣各自獨立，
// 只曝露這個視窗需要的管道。檔案選擇、複製、寫檔全部在 main process 做（見 main.js
// 的「模型設定視窗」段落與 model-config-store.js），renderer 碰不到 fs。
contextBridge.exposeInMainWorld('modelConfig', {
  onInit: (callback) => ipcRenderer.on('init', (_event, data) => callback(data)),
  reload: () => ipcRenderer.invoke('model-config-reload'),
  close: () => ipcRenderer.send('model-config-close'),
  // 3D
  glbAnimations: (file) => ipcRenderer.invoke('model-config-glb-animations', file),
  pickFile: (kind) => ipcRenderer.invoke('model-config-pick-file', kind),
  suggestModelKey: (file, existingKeys) => ipcRenderer.invoke('model-config-suggest-key', file, existingKeys),
  saveParticle: (config) => ipcRenderer.invoke('model-config-save-particle', config),
  // 2D
  pickLive2DFolder: () => ipcRenderer.invoke('model-config-pick-live2d-folder'),
  addLive2D: (args) => ipcRenderer.invoke('model-config-add-live2d', args),
  trackLive2D: (folderName) => ipcRenderer.invoke('model-config-track-live2d', folderName),
  mocIds: (modelPath) => ipcRenderer.invoke('model-config-moc-ids', modelPath),
  saveLive2D: (args) => ipcRenderer.invoke('model-config-save-live2d', args),
});
