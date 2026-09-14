'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// 這個行程的 userData 覆寫成跟 desktop-pet 完全一樣的路徑——desktop-pet/settings-store.js
// 的 settingsPath() 讀的是 app.getPath('userData')，Electron 預設會依照這個行程自己的
// package.json name（"control-center"）算路徑，不覆寫的話會指到一個全新、空的資料夾，
// 不是桌寵真正在用的那份 settings.json。這一步一定要在任何用到 settings-bridge.js
// （因而間接 require 到 desktop-pet/settings-store.js）之前執行。見 settings-bridge.js
// 開頭更完整的說明。
app.setPath('userData', path.join(app.getPath('appData'), 'desktop-pet'));

const settingsBridge = require('./settings-bridge.js');
const processManager = require('./process-manager.js');
const schema = require('./settings-schema.js');
const autostartManager = require('./autostart-manager.js');

// 開機自動啟動：Windows Startup 資料夾裡產生出來的 .bat（見 autostart-manager.js）會用
// 這個參數重新叫起 control-center，代表這次啟動不是使用者手動打開，而是開機時的自動
// 啟動流程——這條路徑完全不開平常那個管理視窗，只是借用 process-manager.js 的既有
// 啟動邏輯把目標模式叫起來，做完就自己退出，讓使用者感受到的是「那個模式自己開起來
// 了」，而不是「多開了一個 control-center 視窗」。
const AUTOSTART_ARG_PREFIX = '--autostart=';
const autostartArg = process.argv.find((a) => a.startsWith(AUTOSTART_ARG_PREFIX));
const autostartModeId = autostartArg ? autostartArg.slice(AUTOSTART_ARG_PREFIX.length) : null;

if (autostartModeId) {
  // 不搶單一實例鎖——這個行程不開視窗、活不久，搶鎖只會讓使用者剛好在這幾秒內手動
  // 開控制中心時，手動那次直接被擋下來、開不了視窗。
  app.whenReady().then(async () => {
    const logPath = path.join(app.getPath('userData'), 'autostart-log.txt');
    const writeLog = (line) => {
      try { fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`); } catch { /* 沒地方能報告失敗，忽略 */ }
    };
    if (!processManager.MODES[autostartModeId]) {
      writeLog(`未知的模式：${autostartModeId}`);
    } else {
      writeLog(`開始自動啟動：${autostartModeId}`);
      try {
        // opts.detached：讓目標行程不會因為這個短命的 bootstrapper 結束而被牽連砍掉，
        // 見 process-manager.js 的 spawnAndTrack() 開頭說明。
        const result = await Promise.resolve(processManager.start(autostartModeId, () => {}, { detached: true }));
        writeLog(result.ok ? `成功（PID ${result.pid}）` : `失敗：${result.error}`);
      } catch (err) {
        writeLog(`例外：${err.message}`);
      }
    }
    app.quit();
  });
} else {
// 單一實例：這個 app 代表「question 專案的中樞」，同時開兩個視窗沒有意義，也會讓兩邊
// 對同一批正在追蹤的行程狀態各自為政。拿不到 lock 代表已經有一個在跑，直接讓這次
// 啟動結束，讓既有那個視窗聚焦。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let win = null;

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  function createWindow() {
    win = new BrowserWindow({
      width: 1100,
      height: 800,
      title: '🧠 question 專案控制中心',
      webPreferences: {
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
      },
    });
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, 'index.html'));
    win.on('closed', () => { win = null; });
  }

  // preload 載入失敗（例如踩到 sandbox 模式限制 require 本地檔案）預設只會在該視窗自己
  // 的 DevTools console 印一行，這裡轉印到啟動這個 app 的終端機，不用特地開 DevTools找。
  app.on('preload-error', (_event, preloadPath, error) => {
    console.error('[control-center] preload 腳本載入失敗：', preloadPath, '\n', error);
  });

  app.whenReady().then(createWindow);

  app.on('window-all-closed', () => {
    // 關閉這個視窗**不會**連帶停止它啟動過的桌寵/host-app/網頁伺服器——這個 app 是
    // 額外的管理層，不是這些行程的生命線，使用者關掉控制中心不代表想連帶關掉正在跑
    // 的桌寵。要停止哪個行程，回這個視窗裡按對應的「停止」才會動作。
    app.quit();
  });

  // ── 設定：全部沿用 settings-bridge.js，讀寫的是 desktop-pet 那份真正的 settings.json ──
  ipcMain.handle('cc-get-schema', () => ({
    TABS: schema.TABS, SCHEMA: schema.SCHEMA, APPLIES_AT_LABEL: schema.APPLIES_AT_LABEL,
  }));

  ipcMain.handle('cc-load-settings', () => {
    const { values, apiKeyStatus } = settingsBridge.getDesktopPetSettings();
    return {
      values,
      apiKeyStatus,
      sources: settingsBridge.getDesktopPetSettingSources(),
      diagnostics: settingsBridge.getDesktopPetSettingsDiagnostics(),
    };
  });

  ipcMain.handle('cc-save-settings', (_e, payload) => settingsBridge.saveDesktopPetSettings(payload));
  ipcMain.handle('cc-reset-settings', (_e, keys) => settingsBridge.resetDesktopPetSettings(keys));

  ipcMain.handle('cc-export-settings', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: '匯出設定',
      defaultPath: 'desktop-pet-settings-export.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { ok: false, cancelled: true };
    try {
      fs.writeFileSync(filePath, JSON.stringify(settingsBridge.exportDesktopPetSettings(), null, 2));
      return { ok: true, path: filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  const IMPORT_MAX_BYTES = 256 * 1024;

  ipcMain.handle('cc-import-preview', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: '匯入設定',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths || !filePaths[0]) return { ok: false, cancelled: true };
    let raw;
    try {
      const stat = fs.statSync(filePaths[0]);
      if (stat.size > IMPORT_MAX_BYTES) {
        return { ok: false, errors: [{ key: null, label: null, message: `檔案過大（上限 ${IMPORT_MAX_BYTES / 1024}KB）` }] };
      }
      raw = fs.readFileSync(filePaths[0], 'utf8');
    } catch (err) {
      return { ok: false, errors: [{ key: null, label: null, message: `讀取檔案失敗：${err.message}` }] };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return { ok: false, errors: [{ key: null, label: null, message: `不是合法的 JSON：${err.message}` }] };
    }
    return settingsBridge.validateImportSettings(parsed);
  });

  ipcMain.handle('cc-import-apply', (_e, payload) => settingsBridge.applyImportedSettings(payload));

  ipcMain.handle('cc-save-api-key', (_e, apiKey) => settingsBridge.saveApiKey(apiKey));

  // 跟 desktop-pet/main.js 的 settings-clear-api-key 一字不差的確認文字——這個 app 是
  // 獨立的 Electron 行程，沒辦法沿用桌寵那邊的 IPC channel（IPC 是同一個 app 內部
  // main↔renderer 的溝通，跨不了不同的 Electron app），所以這個原生二次確認要在這裡
  // 重新做一份，不能只轉呼叫桌寵的 channel。
  ipcMain.handle('cc-clear-api-key', async () => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['取消', '清除'],
      defaultId: 0,
      cancelId: 0,
      title: '清除 API Key',
      message: '確定要清除已儲存的 OpenAI API key 嗎？',
      detail: '清除後桌寵的「語音測試」「即時對話」都會回到「尚未設定」的狀態，要重新輸入才能繼續使用。',
    });
    if (response !== 1) return { ok: false, cancelled: true };
    return settingsBridge.clearApiKey();
  });

  // 同上，跟 desktop-pet/main.js 的 settings-set-cli-free-mode 一字不差。
  ipcMain.handle('cc-set-cli-free-mode', async (_e, enabled) => {
    if (!enabled) return settingsBridge.setCliFreePermissionMode(false);
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['取消', '我了解風險，啟用'],
      defaultId: 0,
      cancelId: 0,
      title: '啟用 CLI 模式免確認模式',
      message: '確定要開啟「免確認模式」嗎？',
      detail: 'CLI 模式（跟角色說「進入 CLI 模式」觸發）目前每個寫檔、執行指令等有風險操作都會先問你同意才做。開啟這個選項後會跳過逐步確認，Claude 會直接自動執行，只在文字泡泡告訴你它做了什麼，不會再暫停等你回覆。\n\n這等於拿掉原本用來防止「觸發短語被誤判、風險操作在你沒真的同意的情況下被執行」的最後一道防線。建議只在會全程盯著螢幕、且信任目前交代的任務時才開啟，用完記得回這裡關閉。',
    });
    if (response !== 1) return { ok: false, cancelled: true };
    return settingsBridge.setCliFreePermissionMode(true);
  });

  // ── 行程管理：桌寵模式／App 模式／網頁模式 ──────────────────────────────────
  function forwardLog(modeId, text, streamName) {
    if (win) win.webContents.send('cc-process-log', { modeId, text, streamName });
  }

  ipcMain.handle('cc-process-start', (_e, modeId) => processManager.start(modeId, forwardLog));
  ipcMain.handle('cc-process-stop', (_e, modeId) => processManager.stop(modeId));
  ipcMain.handle('cc-process-status', () => processManager.getStatus());

  // 網頁模式啟動後開瀏覽器用——跟 launchers/啟動-網頁遊戲.bat 開同一個網址。不用
  // shell.openExternal 包在啟動流程裡自動觸發，是刻意讓使用者自己按「開啟瀏覽器」，
  // 避免每次按「啟動」都彈出一個新分頁（例如重複點兩次的話）。
  ipcMain.on('cc-open-external', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
  });

  // 開機自動啟動：每個模式各自獨立的 Startup .bat 開關，見 autostart-manager.js。
  ipcMain.handle('cc-autostart-get', () => {
    const status = {};
    Object.keys(processManager.MODES).forEach((modeId) => {
      status[modeId] = autostartManager.isAutostartEnabled(modeId);
    });
    return status;
  });
  ipcMain.handle('cc-autostart-set', (_e, modeId, enabled) => {
    if (!processManager.MODES[modeId]) return { ok: false, error: `不明的模式：${modeId}` };
    return enabled ? autostartManager.enableAutostart(modeId) : autostartManager.disableAutostart(modeId);
  });

  // ── 角色與寵物：透過 desktop-pet 的本機控制伺服器（127.0.0.1:47821）遙控正在跑的
  // 桌寵，跟 desktop-pet-web「本機控制面板」是同一套機制、同一份 loopback 伺服器，
  // 見 desktop-pet/control-server.js。桌寵沒有跑的話 fetch 會直接連線失敗，統一當成
  // 「偵測不到桌寵」回傳，不特別區分是連線被拒還是逾時。
  const CONTROL_SERVER_BASE = 'http://127.0.0.1:47821';
  const PET_NOT_DETECTED_ERROR = '偵測不到桌寵，請先在「行程管理」啟動桌寵模式';

  async function fetchDesktopPet(pathname, options) {
    try {
      const res = await fetch(`${CONTROL_SERVER_BASE}${pathname}`, options);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: body.error || `桌寵控制伺服器回應錯誤（HTTP ${res.status}）` };
      return body;
    } catch {
      return { ok: false, error: PET_NOT_DETECTED_ERROR };
    }
  }

  ipcMain.handle('cc-get-extra-pets', () => fetchDesktopPet('/extra-pets'));
  ipcMain.handle('cc-set-extra-pets', (_e, ids) => fetchDesktopPet('/extra-pets', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }),
  }));
  ipcMain.handle('cc-get-model-config', () => fetchDesktopPet('/model-config'));
  ipcMain.handle('cc-save-model-names', (_e, names) => fetchDesktopPet('/model-config/names', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ names }),
  }));
}
}
