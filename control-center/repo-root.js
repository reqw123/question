'use strict';
// 算出 question 專案根目錄的絕對路徑，讓 process-manager.js（spawn 子行程）跟
// settings-bridge.js（require 桌寵的 settings-store.js）都能正確找到 desktop-pet/、
// host-app/、launchers/ 這些「跟 control-center 同一層」的資料夾——不管是直接用
// `electron .` 跑（開發模式），還是打包成 electron-builder 的 portable .exe 之後跑。
//
// 開發模式：這支檔案本身就在 control-center/ 裡，__dirname 的上一層就是專案根目錄，
// 跟原本 process-manager.js 寫死的 `path.join(__dirname, '..')` 完全一樣，行為不變。
//
// 打包後（portable .exe）：main.js 的程式碼實際上跑在 app.asar 裡面，__dirname 會變成
// 一個指向 asar 內部的虛擬路徑，往上疊資料夾算不出真正的專案根目錄。electron-builder
// 的 Windows portable target 對這個情況有專門的解法：執行時會設定
// process.env.PORTABLE_EXECUTABLE_DIR，內容就是使用者目前雙擊的那個 .exe 檔案實際
// 所在的資料夾（不是解壓縮到暫存目錄的路徑）。
//
// 這個資料夾往上要疊幾層才會到專案根目錄，取決於使用者把 .exe 放在哪裡——`npm run
// dist` 產生的檔案本來就在 control-center\dist\ 裡（疊兩層才到根目錄），使用者也可能
// 自己搬到 control-center\ 底下（疊一層）。與其寫死疊幾層（第一版就是這樣寫死疊一層，
// 结果使用者直接從 dist\ 雙擊執行就找不到 desktop-pet/，見對話紀錄的錯誤截圖），改成
// 從 .exe 所在資料夾開始往上逐層找，直到找到真的同時有 desktop-pet/settings-store.js
// 跟 launchers/ 的那一層為止——不管 .exe 實際放在 control-center\ 還是
// control-center\dist\，都能正確找到專案根目錄。
//
// 換句話說：這個 portable .exe 不是「複製到隨便哪台電腦、哪個路徑都能獨立運作」的
// 發佈檔，前提跟原本 launchers/*.bat、control-center 的 `npm start` 完全一樣——
// 必須放在專案資料夾樹裡的某一層之下（不管是 control-center\ 還是它的子資料夾），
// 只是把「先 npm install、再打開終端機打 electron .」簡化成「雙擊一個 .exe」。
const path = require('path');
const fs = require('fs');

function looksLikeRepoRoot(dir) {
  return fs.existsSync(path.join(dir, 'desktop-pet', 'settings-store.js'))
    && fs.existsSync(path.join(dir, 'launchers'));
}

// 從 startDir 開始往上找，最多找 6 層（devDependencies 巢狀再深也用不到這麼多層，
// 抓個安全上限避免萬一路徑算錯時無限往上跑到磁碟根目錄才停）。
function findRepoRootFrom(startDir) {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    if (looksLikeRepoRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // 已經到磁碟根目錄
    dir = parent;
  }
  return null;
}

function resolveRepoRoot() {
  const exeDir = process.env.PORTABLE_EXECUTABLE_DIR;
  const startDirs = exeDir ? [exeDir, __dirname] : [__dirname];
  for (const start of startDirs) {
    const found = findRepoRootFrom(start);
    if (found) return found;
  }
  // 開發模式（`npm start` / `electron .`）的保底：這支檔案本身就在 control-center/
  // 裡，上一層就是專案根目錄，跟原本 process-manager.js 寫死的
  // `path.join(__dirname, '..')` 完全一樣，行為不變。
  return path.join(__dirname, '..');
}

module.exports = { REPO_ROOT: resolveRepoRoot() };
