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
  } catch {
    // 檔案不存在或內容壞掉，一律視同「還沒設定過」，不要讓桌寵啟動流程因為這個壞掉
    // （見 docs/specs/0001-desktop-pet-tts-playback.md 的 Edge Cases）。
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

module.exports = {
  getApiKey, saveApiKey, clearApiKey,
  getMicSettings, saveMicSettings, resetMicSettings,
};
