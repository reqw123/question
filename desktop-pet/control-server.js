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

const MAX_BODY_BYTES = 64 * 1024;

// 哪些路由真的會讀 body（見 dispatch() 對應分支）：/extra-pets、/model-config/names 這兩個
// POST 才會用到 body 裡的欄位。其餘既有路由（show/hide/toggle-interactive/motion/
// reset-position）從來不看 body，呼叫端本來就不會送——但如果哪天有別的呼叫方式（手動測試、
// 舊版呼叫端）不小心帶了非 JSON 的 body，也不該因此讓這些動作本身失敗，見下面 startControlServer()
// 的分流。
const ROUTES_NEEDING_BODY = new Set(['POST /extra-pets', 'POST /model-config/names', 'POST /shortcuts']);

// 讀取並解析 JSON body，只給真的需要 body 的路由用。
// body 超過上限時**不能呼叫 req.destroy()**——HTTP/1.x 底下 req 跟 res 共用同一條 TCP
// socket，destroy() 會把整條連線關掉，等呼叫端要用 res 回錯誤訊息時 socket 早就死了，
// 呼叫端只會看到連線被重置、收不到真正的錯誤內容（跟 launchers/serve-lan.js 的
// readJsonBody() 踩過同一個坑，這裡比照同樣的修法：不 destroy，讓資料照常流完，
// 超量之後進來的內容直接丟棄、不佔記憶體，settled 旗標防止重複 resolve/reject）。
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      data += chunk;
      if (data.length > MAX_BODY_BYTES) { fail(new Error('body too large')); return; }
    });
    req.on('end', () => {
      if (settled) return;
      if (!data) { settled = true; resolve({}); return; }
      try {
        const parsed = JSON.parse(data);
        settled = true;
        resolve(parsed);
      } catch (err) {
        fail(err);
      }
    });
    req.on('error', fail);
  });
}

// handlers 由 main.js 注入（show/hide/toggleInteractive/randomMotion/resetPosition/getStatus，
// 額外寵物／模型命名管理那組，以及可自訂快捷鍵的 getShortcutsInfo/setShortcut/
// resetShortcuts，見 control-center「快捷鍵」分頁），這支檔案只管 HTTP 路由跟 CORS，
// 不直接碰 BrowserWindow/tray，避免跟 main.js 的狀態管理耦合。
function dispatch(handlers, route, body, res) {
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
    case 'GET /extra-pets':
      sendJson(res, 200, {
        ok: true,
        candidates: handlers.getExtraPetCandidates(),
        checked: handlers.getPendingExtraPetIds(),
      });
      return;
    case 'POST /extra-pets': {
      const ids = Array.isArray(body.ids) ? body.ids.filter((id) => Number.isInteger(id)) : null;
      if (!ids) { sendJson(res, 400, { ok: false, error: 'ids 必須是整數陣列' }); return; }
      const checked = handlers.setExtraPets(ids);
      sendJson(res, 200, { ok: true, checked });
      return;
    }
    case 'GET /model-config':
      sendJson(res, 200, { ok: true, ...handlers.getModelConfig() });
      return;
    case 'POST /model-config/names': {
      if (!body.names || typeof body.names !== 'object') {
        sendJson(res, 400, { ok: false, error: 'names 必須是物件' });
        return;
      }
      const result = handlers.saveModelNames(body.names);
      sendJson(res, result.ok ? 200 : 500, result);
      return;
    }
    case 'GET /shortcuts':
      sendJson(res, 200, { ok: true, ...handlers.getShortcutsInfo() });
      return;
    case 'POST /shortcuts': {
      const { action, accel } = body;
      if (typeof action !== 'string' || !action) {
        sendJson(res, 400, { ok: false, error: 'action 必須是字串' });
        return;
      }
      const result = handlers.setShortcut(action, accel);
      sendJson(res, 200, result);
      return;
    }
    case 'POST /shortcuts/reset':
      sendJson(res, 200, { ok: true, ...handlers.resetShortcuts() });
      return;
    default:
      sendJson(res, 404, { ok: false, error: 'not found' });
  }
}

// handlers 由 main.js 注入，見 dispatch() 開頭說明。
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
    if (req.method === 'POST' && ROUTES_NEEDING_BODY.has(route)) {
      readJsonBody(req)
        .then((body) => dispatch(handlers, route, body, res))
        .catch((err) => sendJson(res, 400, { ok: false, error: `body 解析失敗：${err.message}` }));
      return;
    }
    if (req.method === 'POST') {
      // body-agnostic 路由（show/hide/toggle-interactive/motion/reset-position）：不解析
      // body，帶什麼內容都不影響這些動作執行——維持這幾個路由原本「不管 body」的行為，
      // 不要因為全域加了 JSON 解析就意外讓它們在收到非 JSON body 時失敗。仍然要把 body
      // 讀乾淨（drain）：不然底層 socket 可能因為還有未讀資料卡住，影響連線重用。
      req.on('data', () => {});
      req.on('end', () => dispatch(handlers, route, {}, res));
      req.on('error', () => sendJson(res, 400, { ok: false, error: 'bad request' }));
      return;
    }
    dispatch(handlers, route, {}, res);
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
