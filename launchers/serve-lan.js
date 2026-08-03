'use strict';
// 零套件相依的靜態檔案伺服器，給「啟動-網頁遊戲.bat」在偵測不到 caddy.exe 時當退路用。
//
// 只做「把專案根目錄當網站伺服器」這件事，沒有 Caddy 的 /mqtt 反向代理——純區網情境用不到
// 那條（multi/multiplay.js 的 mpMqttUrl() 在 http: 協定下會直連 ws://IP:9001，不經過反代），
// 想要外網/ngrok 公開存取還是要裝 caddy.exe，這支腳本只覆蓋區網這一半，見 launchers/README.md。

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const ROOT = path.resolve(__dirname, '..');   // launchers/ 的上一層 = 專案根目錄

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.mp3':  'audio/mpeg',
  '.mp4':  'video/mp4',
  '.wav':  'audio/wav',
  '.ogg':  'audio/ogg',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.txt':  'text/plain; charset=utf-8',
};
// .moc3/.moc/.mtn 等 Live2D 專屬二進位格式一律回 application/octet-stream（見下方 fallback），
// 瀏覽器端本來就是用 fetch() 讀成 ArrayBuffer，不靠 MIME type 判斷用途，不用特別列。

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(req.url.split('?')[0]);
  } catch {
    res.writeHead(400); res.end('Bad Request'); return;
  }

  // 防止路徑跳出專案根目錄（例如 /../../Windows/win.ini 這種跳脫嘗試）
  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  let filePath = path.join(ROOT, safePath);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');

    fs.readFile(filePath, (err2, data) => {
      if (err2) { res.writeHead(404); res.end('Not Found'); return; }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        // 這是本機開發用的靜態伺服器，檔案隨時可能被改動，一律禁止快取，
        // 避免瀏覽器用啟發式規則快取住舊版 .js/.html，改完程式碼重整卻看不到最新結果。
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  });
});

server.listen(PORT, () => {
  console.log(`[serve-lan] 區網靜態伺服器已啟動： http://localhost:${PORT}/`);
  console.log('[serve-lan] 這是沒偵測到 caddy.exe 時的退路版本，只支援區網內連線，不含 /mqtt 外網反代。');
  console.log('[serve-lan] 關閉這個視窗即停止伺服器。');
});
