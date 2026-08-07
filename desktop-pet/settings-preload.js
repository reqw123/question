'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// 設定視窗專用的 preload，跟 preload.js／name-manager-preload.js 一樣各自獨立。
// 曝露這個視窗需要的幾件事：開窗時接收「目前是否已設定 key」＋語音輸入門檻現況＋
// 即時對話 provider 現況（不曝露 key 本身，避免沒必要地把密鑰顯示在 renderer DOM 裡）、
// 儲存新 key、清空對話記憶、語音輸入門檻的存檔/還原預設值、對話 provider 的存檔/測試
// Ollama 連線、關閉視窗。
contextBridge.exposeInMainWorld('settings', {
  onInit: (callback) => ipcRenderer.on('init', (_event, data) => callback(data)),
  save: (apiKey) => ipcRenderer.invoke('settings-save-api-key', apiKey),
  clear: () => ipcRenderer.invoke('settings-clear-api-key'),
  clearMemory: (charKey) => ipcRenderer.invoke('settings-clear-memory', charKey),
  close: () => ipcRenderer.send('settings-close'),
  // 語音輸入的靜音/幻覺防呆門檻——目前值已經包在 onInit 收到的 micSettings 裡，
  // 不用另外問一次；這裡只曝露「存新值」跟「還原預設值」兩個管道。
  saveMicSettings: (payload) => ipcRenderer.invoke('settings-save-mic-settings', payload),
  resetMicSettings: () => ipcRenderer.invoke('settings-reset-mic-settings'),
  // 即時對話 provider（OpenAI／Ollama 本機）——目前值也包在 onInit 的 chatProviderSettings
  // 裡；testOllama 是「測試連線」按鈕用，main process 直接呼叫 Ollama 不會撞到 CORS。
  saveChatProvider: (payload) => ipcRenderer.invoke('settings-save-chat-provider', payload),
  testOllama: (baseUrl) => ipcRenderer.invoke('settings-test-ollama', { baseUrl }),
});
