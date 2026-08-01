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
  win.loadURL(HOST_URL);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
