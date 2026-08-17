'use strict';
// 橫跨模式的設定橋接層——重新實作了原本活在 desktop-pet/settings-store.js 裡「控制中心
// 專用」那 8 個函式（見 git log，那批已經從 desktop-pet 移除，desktop-pet 的
// settings-store.js 回到只服務它自己的 12 個原始函式），差別是這裡是一個獨立的 Electron
// 主行程，不能直接沿用 desktop-pet 那個行程內部的模組狀態——所以透過 require 相對路徑
// 直接載入 desktop-pet/settings-store.js（跟載入任何一般本機 JS 檔案沒兩樣，Node 的
// require 不在乎「這是不同的 npm 專案」），重用它既有、已經測試過的讀寫/驗證邏輯，
// 不重新寫一份可能跟桌寵核心行為漂移的版本。
//
// 關鍵前提：desktop-pet/settings-store.js 的 settingsPath() 用的是
// app.getPath('userData')，這在 Electron 裡是「依照目前這個行程的 app 名稱」算出來的
// （這裡的 package.json name 是 "control-center"，不是 "desktop-pet"）。main.js 在
// app.whenReady() 之前就用 app.setPath('userData', ...) 把整個 control-center 行程的
// userData 覆寫成 <AppData>/desktop-pet（desktop-pet 自己實際會用到的路徑）——這樣底下
// require 進來的 desktop-pet/settings-store.js 完全不用改一行程式碼，算出來的
// settingsPath() 就會正確指到桌寵真正在讀寫的那份 settings.json，兩邊看到的是同一份
// 檔案，不是各自為政的兩份設定。
const fs = require('fs');
const path = require('path');
const desktopPetSettingsStore = require('../desktop-pet/settings-store.js');
const schema = require('./settings-schema.js');

// 這三個是薄包裝，直接呼叫 desktop-pet/settings-store.js 對應的函式——**不**在這裡處理
// 「清除 API Key」「開啟 CLI 免確認」的原生二次確認對話框，那兩個跟桌寵原本的設計一樣，
// 刻意留在 main.js（跟 dialog.showMessageBox 綁在一起，settings-store.js 本來就不負責
// 跳確認視窗，desktop-pet 自己的版本也是這樣分工），這裡只負責「confirm 完之後真的執行」
// 那一步。
function saveApiKey(key) {
  return desktopPetSettingsStore.saveApiKey(key);
}
function clearApiKey() {
  return desktopPetSettingsStore.clearApiKey();
}
function setCliFreePermissionMode(enabled) {
  return desktopPetSettingsStore.setCliFreePermissionMode(enabled);
}

function getDesktopPetSettings() {
  const mic = desktopPetSettingsStore.getMicSettings();
  const chatProvider = desktopPetSettingsStore.getChatProviderSettings();
  return {
    values: {
      chatProvider: chatProvider.provider,
      ollamaBaseUrl: chatProvider.ollamaBaseUrl,
      ollamaModel: chatProvider.ollamaModel,
      micRmsThreshold: mic.rmsThreshold,
      micMinSpeechDurationMs: mic.minSpeechDurationMs,
      showLive2DOnStartup: desktopPetSettingsStore.getShowLive2DOnStartup(),
      showParticleModelOnStartup: desktopPetSettingsStore.getShowParticleModelOnStartup(),
      cliFreePermissionMode: desktopPetSettingsStore.getCliFreePermissionMode(),
    },
    apiKeyStatus: !!desktopPetSettingsStore.getApiKey(),
  };
}

// 只用 hasSettingKey()（回傳布林值，不回傳實際內容）判斷來源，不整包讀 settings.json——
// 避免不小心把明文 openaiApiKey 帶進這一層。
function getDesktopPetSettingSources() {
  const sources = {};
  for (const field of schema.SCHEMA) {
    if (field.sensitive) continue;
    sources[field.key] = desktopPetSettingsStore.hasSettingKey(field.key) ? 'user' : 'default';
  }
  return sources;
}

// 邏輯跟原本在 desktop-pet/settings-store.js 裡的 saveControlCenterSettings() 完全相同：
// 逐欄位呼叫 desktop-pet 既有的 setX()/saveX()，讓「選 Ollama 但 URL 留空」這種跨欄位
// 規則自動套用，all-or-nothing。
function saveDesktopPetSettings(payload) {
  const { ok, values, errors } = schema.validatePayload(payload);
  if (!ok) return { ok: false, errors };

  if ('chatProvider' in values || 'ollamaBaseUrl' in values || 'ollamaModel' in values) {
    const merged = desktopPetSettingsStore.getChatProviderSettings();
    const result = desktopPetSettingsStore.saveChatProviderSettings({
      provider: 'chatProvider' in values ? values.chatProvider : merged.provider,
      ollamaBaseUrl: 'ollamaBaseUrl' in values ? values.ollamaBaseUrl : merged.ollamaBaseUrl,
      ollamaModel: 'ollamaModel' in values ? values.ollamaModel : merged.ollamaModel,
    });
    if (!result.ok) {
      return { ok: false, errors: [{ key: 'chatProvider', label: '即時對話 AI 提供者', message: result.error }] };
    }
  }
  if ('micRmsThreshold' in values || 'micMinSpeechDurationMs' in values) {
    const merged = desktopPetSettingsStore.getMicSettings();
    const result = desktopPetSettingsStore.saveMicSettings({
      rmsThreshold: 'micRmsThreshold' in values ? values.micRmsThreshold : merged.rmsThreshold,
      minSpeechDurationMs: 'micMinSpeechDurationMs' in values ? values.micMinSpeechDurationMs : merged.minSpeechDurationMs,
    });
    if (!result.ok) {
      return { ok: false, errors: [{ key: 'micRmsThreshold', label: '語音輸入靈敏度', message: result.error }] };
    }
  }
  if ('showLive2DOnStartup' in values) desktopPetSettingsStore.setShowLive2DOnStartup(values.showLive2DOnStartup);
  if ('showParticleModelOnStartup' in values) desktopPetSettingsStore.setShowParticleModelOnStartup(values.showParticleModelOnStartup);

  return { ok: true, values };
}

function resetDesktopPetSettings(keys) {
  const validKeys = (Array.isArray(keys) ? keys : []).filter((k) => schema.BATCH_WRITABLE_KEYS.includes(k));
  if (validKeys.length === 0) return { ok: false, error: '沒有指定任何可重設的欄位' };
  // desktop-pet/settings-store.js 沒有曝露「刪掉任意 key」這種通用函式（刻意窄範圍，
  // 見該檔案），這裡用它既有的專屬 reset/save 函式逐一處理，行為跟直接刪 key 等價
  // （resetMicSettings 本來就是刪 key；showLive2D/showParticle/chatProvider 用它們的
  // setX() 寫回 schema 預設值，效果上等於恢復預設，不需要另外幫 desktop-pet 開一個
  // 「刪任意 key」的後門）。
  for (const key of validKeys) {
    switch (key) {
      case 'micRmsThreshold':
      case 'micMinSpeechDurationMs':
        desktopPetSettingsStore.resetMicSettings();
        break;
      case 'showLive2DOnStartup':
        desktopPetSettingsStore.setShowLive2DOnStartup(schema.findField('showLive2DOnStartup').defaultValue);
        break;
      case 'showParticleModelOnStartup':
        desktopPetSettingsStore.setShowParticleModelOnStartup(schema.findField('showParticleModelOnStartup').defaultValue);
        break;
      case 'chatProvider':
      case 'ollamaBaseUrl':
      case 'ollamaModel':
        desktopPetSettingsStore.saveChatProviderSettings({
          provider: schema.findField('chatProvider').defaultValue,
          ollamaBaseUrl: schema.findField('ollamaBaseUrl').defaultValue,
          ollamaModel: schema.findField('ollamaModel').defaultValue,
        });
        break;
      default:
        break;
    }
  }
  return { ok: true, keys: validKeys };
}

function exportDesktopPetSettings() {
  return schema.buildSafeExport(getDesktopPetSettings().values);
}

function validateImportSettings(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, errors: [{ key: null, label: null, message: '匯入的內容不是合法的 JSON 物件' }] };
  }
  const { ok, values, errors } = schema.validatePayload(payload);
  if (!ok) return { ok: false, errors };
  const changes = schema.diffSettings(getDesktopPetSettings().values, values);
  return { ok: true, values, changes };
}

function applyImportedSettings(payload) {
  const { ok, values, errors } = schema.validatePayload(payload);
  if (!ok) return { ok: false, errors };
  return saveDesktopPetSettings(values);
}

// 純讀取，不修改/不覆蓋/不清空設定檔——跟原本在 desktop-pet 裡那版行為一致。用
// desktop-pet/settings-store.js 曝露出來的 settingsPath()，不猜路徑、不自己重新拼一次。
function getDesktopPetSettingsDiagnostics() {
  const filePath = desktopPetSettingsStore.settingsPath();
  let exists = false;
  let lastModified = null;
  try {
    const stat = fs.statSync(filePath);
    exists = true;
    lastModified = stat.mtime.toISOString();
  } catch {
    exists = false;
  }
  let parseOk = true;
  let parseError = null;
  if (exists) {
    try {
      JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      parseOk = false;
      parseError = err.message;
    }
  }
  return { path: filePath, exists, parseOk, parseError, lastModified };
}

module.exports = {
  getDesktopPetSettings, getDesktopPetSettingSources, saveDesktopPetSettings,
  resetDesktopPetSettings, exportDesktopPetSettings,
  validateImportSettings, applyImportedSettings, getDesktopPetSettingsDiagnostics,
  saveApiKey, clearApiKey, setCliFreePermissionMode,
};
