'use strict';
const { app, BrowserWindow } = require('electron');

// 沿用 VS Code Live Server 網站（跟平常用瀏覽器開一模一樣的網址／同源／同樣的 MQTT 自動偵測邏輯）
// 執行前請先在 VS Code 對 multi/host.html 按「Go Live」，與平常使用方式相同
const HOST_URL = 'http://127.0.0.1:5500/multi/host.html';

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
    },
  });

  // 專案持續在開發，multi/ 底下的檔案隨時可能被改動，強制這個視窗永遠拿最新版，
  // 不要被 Chromium 自己的磁碟快取卡住（這裡是真的走 HTTP 向 Live Server 拿內容，
  // 比 desktop-pet 走 file:// 更容易踩到這個問題）：
  // 1) 每次啟動先清掉舊視窗累積下來的快取
  // 2) 之後每個回應都在 session 層強制蓋成 no-store，不管 Live Server 本身有沒有送這個標頭
  win.webContents.session.clearCache().catch(() => {});
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    details.responseHeaders['Cache-Control'] = ['no-store'];
    callback({ responseHeaders: details.responseHeaders });
  });

  win.loadURL(HOST_URL);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
