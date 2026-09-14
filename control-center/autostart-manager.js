'use strict';
// Windows 開機自動啟動：在使用者的 Startup 資料夾放一個產生出來的 .bat，讓 Windows
// 登入時直接執行，不需要使用者先手動開 control-center。這支 .bat 會用當下這個
// control-center 行程「自己是怎麼被啟動的」（app.getPath('exe') + app.isPackaged）重新
// 組出一份能再次啟動 control-center 本身的指令，另外帶一個 --autostart=<modeId> 參數；
// control-center 看到這個參數時走的是完全不同的啟動路徑（見 main.js 開頭），不會開出
// 平常那個管理視窗，只是借用 process-manager.js 的既有啟動邏輯把目標模式叫起來，
// 做完就自己退出——見 main.js 該分支的說明。
//
// 只支援 Windows：Startup 資料夾（shell:startup）是 Windows 專屬的機制，這個專案目前
// 也只在 Windows 上使用（見 repo-root.js／process-manager.js 全部用 taskkill 等
// Windows 專屬指令），不用另外處理 macOS/Linux 的對應方案。
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

function getStartupFolder() {
  return path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

function getStartupScriptPath(modeId) {
  return path.join(getStartupFolder(), `question-autostart-${modeId}.bat`);
}

function isAutostartEnabled(modeId) {
  return fs.existsSync(getStartupScriptPath(modeId));
}

// 開發模式（`npm start` / `electron .`）：app.getPath('exe') 指到
// node_modules/electron/dist/electron.exe，要另外帶 "." 當作 app 目錄參數，且要把
// cwd 設成這支檔案所在的 control-center/，跟 process-manager.js 的 electronBinFor()
// 產生的執行檔搭配 ['.'] 參數是同一套用法。
// 打包成 portable .exe 之後：app.getPath('exe') 就是那個 .exe 本身，不需要目錄參數、
// 也不需要指定 cwd。
// 用 `start "" /min` 包一層，把中間那個 cmd.exe 外殼視窗盡量縮到最小，不要開機時
// 突然跳出一個終端機視窗。
function buildRelaunchCommand(modeId) {
  const exePath = app.getPath('exe');
  if (app.isPackaged) {
    return `start "" /min "${exePath}" --autostart=${modeId}`;
  }
  return `start "" /min /D "${__dirname}" "${exePath}" "." --autostart=${modeId}`;
}

function enableAutostart(modeId) {
  try {
    fs.mkdirSync(getStartupFolder(), { recursive: true });
    const content = [
      '@echo off',
      'REM 由 question 控制中心的「開機自動啟動」功能自動產生。',
      'REM 要取消自動啟動：直接刪除這個檔案即可，或回控制中心「行程管理」分頁關閉對應開關。',
      buildRelaunchCommand(modeId),
      '',
    ].join('\r\n');
    fs.writeFileSync(getStartupScriptPath(modeId), content, 'utf8');
    return { ok: true, path: getStartupScriptPath(modeId) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function disableAutostart(modeId) {
  try {
    const scriptPath = getStartupScriptPath(modeId);
    if (fs.existsSync(scriptPath)) fs.rmSync(scriptPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { getStartupScriptPath, isAutostartEnabled, enableAutostart, disableAutostart };
