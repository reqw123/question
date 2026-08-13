'use strict';
// 本機控制伺服器：讓 desktop-pet-web（獨立的靜態網頁專案，見 ../desktop-pet-web/）
// 可以透過按鈕呼叫這裡的端點，遙控正在跑的桌寵（顯示/隱藏、切換互動模式、觸發動作）。
//
// 安全範圍：只綁定 127.0.0.1（loopback），不會被同一個區網的其他裝置連到；另外檢查
// Origin 是不是 localhost/127.0.0.1，擋掉「頁面本身開在別的網域、卻想呼叫這支本機
// API」的情境（例如被嵌在惡意頁面裡的請求）。這兩層都只防得住「意外/隨手」的濫用，
// 不是正式的驗證機制——桌寵本來就是純本機個人工具，這裡的目標是「不要因為多開了一個
// port 而被同機器上跑的其他網頁意外戳到」，不是對抗惡意攻擊者。

const http = require('http');

const PORT = 47821;
const ALLOWED_HOSTNAMES = new Set(['localhost', '127.0.0.1']);

function isAllowedOrigin(origin) {
  if (!origin) return true; // 非瀏覽器來源（例如 curl 測試）不會帶 Origin，本來就只綁 loopback，不用額外擋
  try {
    return ALLOWED_HOSTNAMES.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

// handlers 由 main.js 注入（show/hide/toggleInteractive/randomMotion/resetPosition/getStatus），
// 這支檔案只管 HTTP 路由跟 CORS，不直接碰 BrowserWindow/tray，避免跟 main.js 的狀態管理耦合。
function startControlServer(handlers) {
  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;

    if (origin && !isAllowedOrigin(origin)) {
      sendJson(res, 403, { ok: false, error: 'origin not allowed' });
      return;
    }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    let pathname;
    try {
      pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad request' });
      return;
    }

    const route = `${req.method} ${pathname}`;
    switch (route) {
      case 'GET /status':
        sendJson(res, 200, { ok: true, ...handlers.getStatus() });
        return;
      case 'POST /show':
        handlers.show();
        sendJson(res, 200, { ok: true, ...handlers.getStatus() });
        return;
      case 'POST /hide':
        handlers.hide();
        sendJson(res, 200, { ok: true, ...handlers.getStatus() });
        return;
      case 'POST /toggle-interactive':
        handlers.toggleInteractive();
        sendJson(res, 200, { ok: true, ...handlers.getStatus() });
        return;
      case 'POST /motion':
        handlers.randomMotion();
        sendJson(res, 200, { ok: true });
        return;
      case 'POST /reset-position':
        handlers.resetPosition();
        sendJson(res, 200, { ok: true });
        return;
      default:
        sendJson(res, 404, { ok: false, error: 'not found' });
    }
  });

  server.on('error', (err) => {
    // 不讓埠號被佔用等問題整個炸掉桌寵主程式——只印警告，控制伺服器打不開，
    // 桌寵本身（tray 選單、快捷鍵）照常運作，不受影響。
    console.error('[desktop-pet] 本機控制伺服器啟動失敗（不影響桌寵本身運作）：', err.message);
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[desktop-pet] 本機控制伺服器已啟動：http://127.0.0.1:${PORT}（僅接受 localhost 來源）`);
  });

  return server;
}

module.exports = { startControlServer, PORT };
