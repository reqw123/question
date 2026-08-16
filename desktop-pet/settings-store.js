'use strict';
// OpenAI API key 存放（ADR-0006：不用 .env，改用應用程式內建設定畫面存到本機設定檔）。
// 只有 main process 會 require 這個檔案，key 不會經過任何 IPC 傳到 renderer 端。
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
// 語音輸入靜音/幻覺防呆的兩個門檻，內建預設值的唯一真相來源在 silence-detector.js
// （renderer 端錄音時也是讀同一個模組），這裡只 require 進來當「使用者沒調過」時的
// fallback，不要另外複製一份數字，避免兩邊改一個忘記改另一個。
const { DEFAULT_RMS_THRESHOLD, DEFAULT_MIN_SPEECH_DURATION_MS } = require('./silence-detector.js');

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch (err) {
    // 檔案不存在或內容壞掉，一律視同「還沒設定過」，不要讓桌寵啟動流程因為這個壞掉
    // （見 docs/specs/0001-desktop-pet-tts-playback.md 的 Edge Cases）。檔案不存在是
    // 首次啟動的正常狀態，不用警告；內容壞掉（JSON parse 失敗等）才值得留意，
    // 不然使用者設定過的 key/偏好被悄悄清空，完全不會知道發生過這件事。
    if (err.code !== 'ENOENT') console.warn('[desktop-pet] 讀取 settings.json 失敗，設定已退回預設值：', err.message);
    return {};
  }
}

function getApiKey() {
  const { openaiApiKey } = readSettings();
  return typeof openaiApiKey === 'string' ? openaiApiKey : '';
}

// 回傳 { ok, error? }；空白/純空白字元的 key 一律拒絕，不寫進設定檔
// （Acceptance Criteria #8）。
function saveApiKey(key) {
  const trimmed = typeof key === 'string' ? key.trim() : '';
  if (!trimmed) {
    return { ok: false, error: 'API key 不能是空白' };
  }
  try {
    const current = readSettings();
    current.openaiApiKey = trimmed;
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(current, null, 2));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// 明確清除（跟「儲存空白值」是兩件事——saveApiKey() 刻意擋空白，避免手滑清掉；
// 這個是使用者在設定畫面主動按「清除」、經過二次確認後才會呼叫）。
function clearApiKey() {
  try {
    const current = readSettings();
    delete current.openaiApiKey;
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(current, null, 2));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// 語音輸入設定畫面（settings.html）的「聲音最低門檻」「聲音累計時長」——見
// docs/specs/0004-desktop-pet-voice-input.md 幻覺防呆那幾輪修正。沒存過就回傳
// silence-detector.js 的內建預設值，跟一開始沒調過設定時的行為完全一樣。
function getMicSettings() {
  const { micRmsThreshold, micMinSpeechDurationMs } = readSettings();
  return {
    rmsThreshold: typeof micRmsThreshold === 'number' && Number.isFinite(micRmsThreshold)
      ? micRmsThreshold : DEFAULT_RMS_THRESHOLD,
    minSpeechDurationMs: typeof micMinSpeechDurationMs === 'number' && Number.isFinite(micMinSpeechDurationMs)
      ? micMinSpeechDurationMs : DEFAULT_MIN_SPEECH_DURATION_MS,
  };
}

// 回傳 { ok, error? }。範圍檢查刻意寬鬆但不是完全不管——0 或負數的門檻等於「什麼都算
// 有講話」，會讓這整套防呆形同虛設，寧可擋下來提示使用者重新輸入。
function saveMicSettings({ rmsThreshold, minSpeechDurationMs }) {
  const rms = Number(rmsThreshold);
  const durationMs = Number(minSpeechDurationMs);
  if (!Number.isFinite(rms) || rms <= 0 || rms > 1) {
    return { ok: false, error: '聲音最低門檻要是 0～1 之間的數字（RMS 音量，預設 0.04）' };
  }
  if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 60000) {
    return { ok: false, error: '聲音累計時長要是 0～60000 之間的毫秒數（預設 400）' };
  }
  try {
    const current = readSettings();
    current.micRmsThreshold = rms;
    current.micMinSpeechDurationMs = durationMs;
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(current, null, 2));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// 還原成 silence-detector.js 的內建預設值（拿掉存檔裡的兩個 key，getMicSettings()
// 就會自動 fallback 回預設值，不用另外存一份「預設值」進設定檔）。
function resetMicSettings() {
  try {
    const current = readSettings();
    delete current.micRmsThreshold;
    delete current.micMinSpeechDurationMs;
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(current, null, 2));
    return { ok: true, ...getMicSettings() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// 即時對話要用哪個 LLM provider（見 docs/specs/0005-desktop-pet-ollama-provider.md、
// docs/adr/0001-openai-for-live-chat.md 的更新說明）。預設 openai——沒存過設定的舊使用者
// 行為完全不變，Ollama 是使用者自己在設定畫面切過去才會生效的選項。
const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434';
const DEFAULT_OLLAMA_MODEL = 'qwen2.5:7b';

function getChatProviderSettings() {
  const { chatProvider, ollamaBaseUrl, ollamaModel } = readSettings();
  return {
    provider: chatProvider === 'ollama' ? 'ollama' : 'openai',
    ollamaBaseUrl: typeof ollamaBaseUrl === 'string' && ollamaBaseUrl.trim() ? ollamaBaseUrl : DEFAULT_OLLAMA_BASE_URL,
    ollamaModel: typeof ollamaModel === 'string' && ollamaModel.trim() ? ollamaModel : DEFAULT_OLLAMA_MODEL,
  };
}

// 回傳 { ok, error? }。選 ollama 時 baseUrl/model 不能是空白——這兩個沒填，聊天送出去
// 一定失敗，寧可在設定畫面就擋下來，不要等使用者實際聊天才發現存了個打不通的設定。
// 選 openai 時不檢查這兩個欄位（維持沿用/不影響既有的 openaiApiKey 設定）。
function saveChatProviderSettings({ provider, ollamaBaseUrl, ollamaModel }) {
  if (provider !== 'openai' && provider !== 'ollama') {
    return { ok: false, error: '不明的 provider' };
  }
  const trimmedUrl = typeof ollamaBaseUrl === 'string' ? ollamaBaseUrl.trim() : '';
  const trimmedModel = typeof ollamaModel === 'string' ? ollamaModel.trim() : '';
  if (provider === 'ollama') {
    if (!trimmedUrl) return { ok: false, error: 'Ollama Base URL 不能是空白' };
    if (!trimmedModel) return { ok: false, error: 'Ollama 模型名稱不能是空白' };
  }
  try {
    const current = readSettings();
    current.chatProvider = provider;
    // 就算目前選 openai，也照樣把 Ollama 欄位存起來（如果使用者有填），下次切回 Ollama
    // 不用重打一次；只有留空才不寫入，交給 getChatProviderSettings() 的預設值 fallback。
    if (trimmedUrl) current.ollamaBaseUrl = trimmedUrl;
    if (trimmedModel) current.ollamaModel = trimmedModel;
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(current, null, 2));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// CLI 模式免確認模式（見 docs/adr/0010-desktop-pet-cli-free-permission-mode.md）。預設關閉
// （沒存過就是 false，跟舊使用者/新使用者行為一致，一定要在設定畫面主動開啟才會生效）。
// 開啟前的二次確認交給 main process 的 dialog.showMessageBox（跟清除 API key 同一套手法，
// 見 main.js 的 settings-set-cli-free-mode），這裡只負責存值，不判斷要不要跳確認。
function getCliFreePermissionMode() {
  const { cliFreePermissionMode } = readSettings();
  return cliFreePermissionMode === true;
}

function setCliFreePermissionMode(enabled) {
  try {
    const current = readSettings();
    if (enabled) {
      current.cliFreePermissionMode = true;
    } else {
      delete current.cliFreePermissionMode; // 關閉＝回到「沒設定過」的預設安全狀態
    }
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(current, null, 2));
    return { ok: true, enabled: !!enabled };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// 桌寵啟動（或 F8／套用角色選擇這種 reload）時要不要預設顯示 Live2D 模型／光粒子
// 3D 模型（particle-effect）——這兩個是「開機預設值本身」，使用者在設定畫面調整，
// 所以要存進 settings.json；跟 main.js 的 clickThrough／extraPetWander／
// particleEffectOn 那種「每次重開都固定同一個值、故意不記使用者上次操作」是不同
// 性質的東西——那些是「這次 session 的即時狀態」不用記，這兩個則是「往後每次開機
// 該用哪個預設值」要能記住。
//
// Live2D 預設顯示：沒存過就是 true（顯示）——桌寵的核心賣點就是看得到角色，維持
// 舊使用者原本「一開就看得到」的行為，不因為新加了這個開關就悄悄變了預設體驗。
function getShowLive2DOnStartup() {
  const { showLive2DOnStartup } = readSettings();
  return typeof showLive2DOnStartup === 'boolean' ? showLive2DOnStartup : true;
}

function setShowLive2DOnStartup(enabled) {
  try {
    const current = readSettings();
    current.showLive2DOnStartup = !!enabled;
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(current, null, 2));
    return { ok: true, enabled: !!enabled };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// 光粒子 3D 模型（particle-effect）預設顯示：沒存過就是 false——跟 main.js 原本
// `let particleEffectOn = false` 那個「預設關閉，不吵，使用者自己決定要不要開」的
// 意圖一致，只是現在這個「false」本身變成可以被使用者在設定畫面改掉的一份設定，
// 不再是寫死在程式碼裡的常數。
function getShowParticleModelOnStartup() {
  const { showParticleModelOnStartup } = readSettings();
  return typeof showParticleModelOnStartup === 'boolean' ? showParticleModelOnStartup : false;
}

function setShowParticleModelOnStartup(enabled) {
  try {
    const current = readSettings();
    current.showParticleModelOnStartup = !!enabled;
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(current, null, 2));
    return { ok: true, enabled: !!enabled };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  getApiKey, saveApiKey, clearApiKey,
  getMicSettings, saveMicSettings, resetMicSettings,
  getChatProviderSettings, saveChatProviderSettings,
  getCliFreePermissionMode, setCliFreePermissionMode,
  getShowLive2DOnStartup, setShowLive2DOnStartup,
  getShowParticleModelOnStartup, setShowParticleModelOnStartup,
};
