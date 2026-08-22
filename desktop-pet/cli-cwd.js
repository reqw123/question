'use strict';
// CLI 模式（docs/specs/0006-desktop-pet-claude-cli-mode.md）用哪個資料夾當 Claude CLI
// 的工作目錄——開發模式（`npm start` / `electron .`）跟打包成 electron-builder 的
// portable .exe 之後，這裡的答案不一樣：
//
// 開發模式：desktop-pet/ 本身就在專案 repo 裡，__dirname 的上一層就是專案根目錄
// （跟 main.js 原本寫死的 `path.join(__dirname, '..')` 完全一樣，行為不變）。
//
// 打包後（portable .exe）：main.js 的程式碼實際上跑在 app.asar 裡面，__dirname 會變成
// 一個指向 asar 內部的虛擬路徑，往上疊資料夾疊不到真正有原始碼、能讓 CLI 模式操作的
// 目錄——這個 .exe 本身就是設計成「可以獨立搬到別的資料夾使用」的單一檔案，不像
// control-center 那樣假設一定跟 repo 放在一起，所以這裡沒有「真正的專案根目錄」可以找。
// 使用者決定 CLI 模式改成「跟著 .exe 目前所在資料夾走」：用 electron-builder 的 Windows
// portable target 專門提供的 process.env.PORTABLE_EXECUTABLE_DIR（使用者目前雙擊的那個
// .exe 檔案實際所在的資料夾，不是解壓縮到暫存目錄的路徑）當作 CLI 模式的工作目錄。
function resolveCliCwd() {
  const path = require('path');
  const exeDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (exeDir) return exeDir;
  return path.join(__dirname, '..');
}

module.exports = { CLAUDE_CLI_CWD: resolveCliCwd() };
