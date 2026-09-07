'use strict';
// 零套件相依的靜態檔案伺服器，給「啟動-網頁遊戲.bat」在偵測不到 caddy.exe 時當退路用。
//
// 只做「把專案根目錄當網站伺服器」這件事，沒有 Caddy 的 /mqtt 反向代理——純區網情境用不到
// 那條（multi/multiplay.js 的 mpMqttUrl() 在 http: 協定下會直連 ws://IP:9001，不經過反代），
// 想要外網/ngrok 公開存取還是要裝 caddy.exe，這支腳本只覆蓋區網這一半，見 launchers/README.md。

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = process.env.PORT || process.argv[2] || 8080;
const ROOT = path.resolve(__dirname, '..');   // launchers/ 的上一層 = 專案根目錄
const QUESTIONS_DIR = path.join(ROOT, 'questions');

// ── 題庫寫檔 API（POST /api/save-bank）──────────────────────────────────────
// host.html「上傳自訂題庫」時呼叫，把 JSON 題庫真的寫進 questions/<檔名>.json 並在
// questions/index.json 登記一筆，之後重整 host.html 就會出現在下拉選單。純瀏覽器 JS
// 沒辦法寫任意磁碟路徑，所以靠這個小後端。Caddy 模式下由 Caddyfile 的
// `reverse_proxy /api/* localhost:8081` 轉進來（見 launchers/啟動-網頁遊戲.bat）。
const BUILTIN_BANKS = new Set([
  'index.json', 'player.json',
  'business.json', 'security.json', 'ai.json', 'english.json', 'questions.json',
]);

function bankSlug(name) {
  const base = String(name || '').trim()
    .replace(/[^\p{L}\p{N}_-]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return base || 'custom';
}

function handleSaveBank(req, res) {
  const sendJson = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };
  const chunks = [];
  let size = 0, tooBig = false;
  req.on('data', (d) => {
    size += d.length;
    if (size > 1024 * 1024) { tooBig = true; req.destroy(); }
    else chunks.push(d);
  });
  req.on('error', () => { try { sendJson(400, { ok: false, error: '讀取失敗' }); } catch {} });
  req.on('end', () => {
    if (tooBig) return sendJson(413, { ok: false, error: '請求過大（>1MB）' });

    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return sendJson(400, { ok: false, error: 'JSON 解析失敗' }); }

    const questions = Array.isArray(body && body.questions) ? body.questions
                    : (Array.isArray(body) ? body : null);
    if (!questions || questions.length < 1 || questions.length > 1000) {
      return sendJson(400, { ok: false, error: '題庫需為 1~1000 題的 JSON 陣列' });
    }

    const rawName = String(body && body.name || '').trim();
    // body.file：重存時帶回上次的檔名，讓「改名」只更新 index.json 的顯示名稱、不另開新檔
    const rawFile = String(body && body.file || '').trim();
    let file;
    if (rawFile && /^[\p{L}\p{N}_-]{1,60}\.json$/u.test(rawFile) && !BUILTIN_BANKS.has(rawFile)) {
      file = rawFile;
    } else {
      file = bankSlug(rawName) + '.json';
      if (BUILTIN_BANKS.has(file)) file = 'custom_' + file;   // 不覆寫內建題庫
    }
    const displayName = rawName || file.replace(/\.json$/i, '');

    const target = path.join(QUESTIONS_DIR, file);
    if (path.dirname(target) !== QUESTIONS_DIR) {
      return sendJson(400, { ok: false, error: '檔名不合法' });
    }

    const payload = JSON.stringify(questions, null, 2) + '\n';
    if (Buffer.byteLength(payload) > 512 * 1024) {
      return sendJson(413, { ok: false, error: '題庫檔案過大（>512KB）' });
    }

    try {
      fs.mkdirSync(QUESTIONS_DIR, { recursive: true });
      fs.writeFileSync(target, payload, 'utf8');

      const idxPath = path.join(QUESTIONS_DIR, 'index.json');
      let index = [];
      try { index = JSON.parse(fs.readFileSync(idxPath, 'utf8')); } catch {}
      if (!Array.isArray(index)) index = [];
      const entry = { file, name: displayName };
      const i = index.findIndex((b) => b && b.file === file);
      if (i >= 0) index[i] = entry; else index.push(entry);
      fs.writeFileSync(idxPath, JSON.stringify(index, null, 2) + '\n', 'utf8');

      console.log(`[serve-lan] 已寫入題庫 questions/${file}（${questions.length} 題）`);
      sendJson(200, { ok: true, file, name: displayName, path: `../questions/${file}`, count: questions.length });
    } catch (e) {
      sendJson(500, { ok: false, error: String((e && e.message) || e) });
    }
  });
}

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

  // 題庫寫檔 API（見檔案上方 handleSaveBank 說明）
  if (urlPath === '/api/save-bank') {
    if (req.method !== 'POST') { res.writeHead(405); res.end('Method Not Allowed'); return; }
    handleSaveBank(req, res);
    return;
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
  console.log('[serve-lan] POST /api/save-bank 可把上傳的題庫寫進 questions/ 並更新 index.json。');
  console.log('[serve-lan] 關閉這個視窗即停止伺服器。');
});
