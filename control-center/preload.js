'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// 只曝露這個視窗需要的最小必要 API，不曝露完整 ipcRenderer。
//
// 欄位描述（schema）透過 IPC 問 main process，不在這裡直接 require('./settings-schema.js')
// ——Electron 20+ 之後 preload 腳本預設跑在 sandbox 模式，這個模式下 require() 只允許
// electron/events/timers/url 幾個內建模組，本地檔案的相對路徑 require 會直接失敗整個
// preload 腳本（這個坑桌寵那邊的 control-center-preload.js 已經踩過一次，這裡直接照
// 學到的教訓寫，不重踩）。
contextBridge.exposeInMainWorld('controlCenter', {
  getSchema: () => ipcRenderer.invoke('cc-get-schema'),

  loadSettings: () => ipcRenderer.invoke('cc-load-settings'),
  saveSettings: (payload) => ipcRenderer.invoke('cc-save-settings', payload),
  resetSettings: (keys) => ipcRenderer.invoke('cc-reset-settings', keys),
  exportSettings: () => ipcRenderer.invoke('cc-export-settings'),
  importPreview: () => ipcRenderer.invoke('cc-import-preview'),
  importApply: (values) => ipcRenderer.invoke('cc-import-apply', values),

  // 這個 app 是獨立行程，沒辦法沿用桌寵那邊的 settings-clear-api-key／
  // settings-set-cli-free-mode channel（IPC 跨不了不同的 Electron app），main.js 這邊
  // 重新做了一份、確認文字逐字對齊桌寵原本的版本，見 main.js 的說明。
  saveApiKey: (apiKey) => ipcRenderer.invoke('cc-save-api-key', apiKey),
  clearApiKey: () => ipcRenderer.invoke('cc-clear-api-key'),
  setCliFreeMode: (enabled) => ipcRenderer.invoke('cc-set-cli-free-mode', enabled),

  // 行程管理：桌寵模式／App 模式／網頁模式的啟動/關閉/現況查詢，見 process-manager.js。
  startProcess: (modeId) => ipcRenderer.invoke('cc-process-start', modeId),
  stopProcess: (modeId) => ipcRenderer.invoke('cc-process-stop', modeId),
  getProcessStatus: () => ipcRenderer.invoke('cc-process-status'),
  onProcessLog: (callback) => ipcRenderer.on('cc-process-log', (_event, data) => callback(data)),
  openExternal: (url) => ipcRenderer.send('cc-open-external', url),

  // 開機自動啟動：見 autostart-manager.js／main.js 的 cc-autostart-* handler。
  getAutostartStatus: () => ipcRenderer.invoke('cc-autostart-get'),
  setAutostart: (modeId, enabled) => ipcRenderer.invoke('cc-autostart-set', modeId, enabled),

  // 角色與寵物：透過桌寵的本機控制伺服器遙控，見 main.js 的 cc-get-extra-pets 等 handler。
  getExtraPets: () => ipcRenderer.invoke('cc-get-extra-pets'),
  setExtraPets: (ids) => ipcRenderer.invoke('cc-set-extra-pets', ids),
  getModelConfig: () => ipcRenderer.invoke('cc-get-model-config'),
  saveModelNames: (names) => ipcRenderer.invoke('cc-save-model-names', names),

  // 快捷鍵：一樣透過桌寵的本機控制伺服器遙控，見 main.js 的 cc-get-shortcuts 等 handler。
  getShortcuts: () => ipcRenderer.invoke('cc-get-shortcuts'),
  setShortcut: (action, accel) => ipcRenderer.invoke('cc-set-shortcut', action, accel),
  resetShortcuts: () => ipcRenderer.invoke('cc-reset-shortcuts'),
});
