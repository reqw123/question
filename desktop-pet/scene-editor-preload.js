'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// 情境編輯器視窗專用的 preload，跟 name-manager-preload.js 一樣各自獨立，只曝露這個
// 視窗需要的幾件事：讀目前 scenes.json、跟桌寵要「現在」的即時座標/手勢清單、存檔、
// 測試手勢/台詞、整段預覽播放。get 系列都是「問一次、拿一次答案」，用 invoke（Promise）
// 比 send + 事件監聽的寫法直接，且天生就是一問一答，不會有舊事件殘留干擾下一次呼叫的問題。
contextBridge.exposeInMainWorld('sceneEditor', {
  getScenes: () => ipcRenderer.invoke('scene-editor-get-scenes'),
  getLivePositions: () => ipcRenderer.invoke('scene-editor-get-live'),
  getGestureList: () => ipcRenderer.invoke('scene-editor-get-gestures'),
  save: (scenes) => ipcRenderer.invoke('scene-editor-save', scenes),
  testGesture: (charKey, name) => ipcRenderer.send('scene-editor-test-gesture', { charKey, name }),
  testSpeak: (charKey, text) => ipcRenderer.send('scene-editor-test-speak', { charKey, text }),
  // 獨立測試單一步驟的走位，不用存檔、不用整段情境播放。
  testMove: (charKey, x, y, durationMs) =>
    ipcRenderer.send('scene-editor-test-move', { charKey, x, y, durationMs }),
  // 不經過 tween，直接把角色瞬間放到指定座標。
  snapPosition: (charKey, x, y) => ipcRenderer.send('scene-editor-snap-position', { charKey, x, y }),
  playScene: (key) => ipcRenderer.send('scene-editor-play', key),
  // 閒話台詞（idle chat）：獨立於「情境」之外的另一份資料，用同一套 get/save 模式。
  getIdleChat: () => ipcRenderer.invoke('scene-editor-get-idle-chat'),
  saveIdleChat: (pairs) => ipcRenderer.invoke('scene-editor-save-idle-chat', pairs),
  // 文字泡泡定位校正（headRatio/headXRatio/bubbleGrow/scale）：get 讀目前實際套用的
  // 模型+數值，testLive 即時套用不寫檔（配合既有的 testSpeak 一起用就能馬上在畫面上
  // 看到效果），save 才是真的寫回 manifest.json 該模型的 layout。opts 是
  // { headRatio, headXRatio, bubbleGrow, scale }，欄位可以只帶部分。
  getBubbleConfig: () => ipcRenderer.invoke('scene-editor-get-bubble-config'),
  testBubbleLive: (charKey, opts) =>
    ipcRenderer.send('scene-editor-test-bubble-live', { charKey, opts }),
  saveBubbleConfig: (modelPath, opts) =>
    ipcRenderer.invoke('scene-editor-save-bubble-config', { modelPath, ...opts }),
});
