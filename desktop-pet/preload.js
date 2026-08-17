'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// contextIsolation:true 讓 renderer（index.html）沒辦法直接 require('electron')，
// 這裡透過 contextBridge 只曝露「回報飛行動畫真的結束了」這一個管道，
// 讓 main.js 的 isFlying 狀態能跟 renderer 的實際動畫狀態同步，
// 不用再靠 main.js 自己猜（猜的話，動作自然播完 vs 被手動停止，main.js 分不出來）。
contextBridge.exposeInMainWorld('petBridge', {
  flyFinished: () => ipcRenderer.send('fly-finished'),
  // main process 語音合成完成後，把音檔 bytes（base64）推過來播放；
  // 只曝露「收音檔來播」這一個管道，renderer 沒有辦法反過來呼叫任何 Node/網路 API。
  onPlayTtsAudio: (callback) => ipcRenderer.on('play-tts-audio', (_event, data) => callback(data)),
  // 播放真的結束（或失敗）時回報 main process，讓 chat-send 的 Promise 等到這個才 resolve，
  // 語音模式的續錄迴圈才不會在角色話還沒講完時就把麥克風重新打開（避免聲學回授）。
  ttsPlaybackFinished: () => ipcRenderer.send('tts-playback-finished'),
  // 即時對話：把「使用者對哪個角色說了什麼」送給 main process，等回覆完成/失敗才
  // resolve（{ ok: true } 或 { ok: false, error }）。實際的回覆文字/語音走既有的
  // play-tts-audio + executeJavaScript(L2D.speak()) 管道顯示，這裡的回傳值只用來
  // 讓輸入框知道「這輪處理完了、成功還是失敗」。renderer 沒有辦法直接呼叫 OpenAI
  // 或碰到 API key，聊天/摘要的網路呼叫只在 main process 發生。
  sendChatMessage: (charKey, message) => ipcRenderer.invoke('chat-send', { charKey, message }),
  // 使用者打錯字/講錯話，趁「思考中」還沒收到回覆時按 Esc 收回——main process 會中止
  // 還在進行中的 fetch，讓上面 sendChatMessage() 那個還沒 resolve 的 Promise 改成回傳
  // { ok:false, cancelled:true }（見 main.js 的 chat-cancel handler）。
  cancelChatMessage: (charKey) => ipcRenderer.invoke('chat-cancel', { charKey }),
  // 語音輸入：把錄好的音檔 bytes（base64）送給 main process 轉錄，只回傳文字/錯誤，
  // 不會讓 renderer 碰到 OpenAI API key（跟 chat-send 的安全模型一致）。
  transcribeVoice: (audioBase64, mimeType) => ipcRenderer.invoke('voice-transcribe', { audioBase64, mimeType }),
  // 使用者打錯字/講錯話，趁「轉錄中」還沒轉完時按 Esc 收回——跟 cancelChatMessage 同一種
  // 模式（見 main.js 的 voice-transcribe-cancel handler），中止還在進行中的 Whisper 請求。
  cancelTranscription: () => ipcRenderer.invoke('voice-transcribe-cancel'),
  hasApiKey: () => ipcRenderer.invoke('has-api-key'),
  // 語音輸入的靜音/幻覺防呆門檻——使用者可以在設定畫面調整（見 settings-store.js 的
  // getMicSettings()），每次開始錄音前都問一次目前值，不用重開桌寵就能生效。
  getMicSettings: () => ipcRenderer.invoke('get-mic-settings'),
  // main process 的全域 Escape（globalShortcut，見 main.js updateGlobalEscapeRegistration）
  // 完全碰不到 renderer 的 MediaRecorder——只能透過這個管道被動得知「現在有沒有在錄音」，
  // 決定要不要讓全域 Escape 保持註冊（穿透模式/沒有鍵盤焦點時按 Esc 也要能打斷錄音）。
  notifyRecordingActive: (active) => ipcRenderer.send('recording-active', active),
  // 全域 Escape 觸發時推這個事件過來，讓 renderer 用跟本地 document keydown 監聽
  // 一模一樣的判斷邏輯處理（isRecording > transcribing > isTtsPlaying > chatRequestPending
  // > voiceInputActive）——不在 main process 另外重寫一份判斷順序，見 index.html。
  onGlobalEscape: (callback) => ipcRenderer.on('global-escape', () => callback()),
});
