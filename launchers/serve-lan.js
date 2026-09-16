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
const STATS_DIR = path.join(ROOT, 'stats');
const MULTI_DIR = path.join(ROOT, 'multi');
const GAME_SETTINGS_PATH = path.join(MULTI_DIR, 'game-settings.json');

// ── 題庫寫檔 API（POST /api/save-bank）──────────────────────────────────────
// host.html「上傳自訂題庫」時呼叫，把 JSON 題庫真的寫進 questions/<檔名>.json 並在
// questions/index.json 登記一筆，之後重整 host.html 就會出現在下拉選單。純瀏覽器 JS
// 沒辦法寫任意磁碟路徑，所以靠這個小後端。Caddy 模式下由 Caddyfile 的
// `reverse_proxy /api/* localhost:8081` 轉進來（見 launchers/啟動-網頁遊戲.bat）。
const BUILTIN_BANKS = new Set([
  'index.json', 'player.json',
  'business.json', 'security.json', 'ai.json', 'english.json', 'questions.json',
]);

// 暱稱／題庫名轉檔名。以前會把清乾淨後開頭/結尾的底線再修剪掉一次，副作用是「Tom」跟
// 「Tom!」都會變成同一個檔名（"Tom!" → "Tom_" → 修剪成 "Tom"）——不同的兩個名字撞成同一個
// 識別碼，學習報告會把兩個人的紀錄悄悄合併寫在一起。拿掉那次修剪，「Tom!」保留成「Tom_」，
// 不會再跟「Tom」撞名；純符號（沒有任何字母/數字）的名字清乾淨後只剩底線，用
// /^_*$/ 判斷出來、當成不合法暱稱處理，跟修剪前的「拒絕純符號名字」行為一致。
// 一般情況（名字沒有頭尾符號，例如「575」「主持人」）輸出完全不變，既有的 stats/ 檔案
// 不受影響。
function statsSlug(name) {
  const base = String(name || '').trim()
    .replace(/[^\p{L}\p{N}_-]+/gu, '_')
    .slice(0, 40);
  return /^_*$/.test(base) ? '' : base;
}

// 題庫檔名沿用跟 statsSlug() 同一套清理規則，只是多一個「清出來是空的就用預設檔名」的
// fallback（題庫檔名沒有「識別碼」這種嚴謹要求，不像暱稱那樣空字串要直接回錯）。以前這裡
// 整套規則自己重複寫一次，兩份要同步改很容易忘記改到其中一邊。
function bankSlug(name) {
  return statsSlug(name) || 'custom';
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// Promise 版的 body 讀取，失敗時 reject { code, error }——handleSaveBank 原本內嵌的
// chunked 讀取 + 大小上限邏輯搬到這裡，題庫管理那組新路由（body 小很多）也共用同一份，
// 不用各自重寫一次同樣的讀取/防呆邏輯。
// body 超過上限時直接在 'data' 事件裡當場 reject（不是設個旗標、等 req.destroy() 之後
// 靠 'end'/'error' 收尾）：req.destroy() 沒帶錯誤參數只會讓底層 socket 發出 'close'，
// 不會是 'end' 也不會是 'error'，這個 Promise 只聽這兩個事件的話永遠不會 settle，
// 等於卡死整個 handler、客戶端只會看到連線被斷掉、拿不到原本要回的 413。
// 特別注意：偵測到超量**不能呼叫 req.destroy()**——HTTP/1.x 底下 req 跟 res 共用同一條
// TCP socket，destroy() 會把整條連線關掉，等呼叫端的 catch 區塊要用 res 回 413 時，
// socket 早就死了，客戶端只會看到連線被重置（實測跑出來是這樣：本來想「盡快斷開超量
// 連線」，反而讓真正該回的錯誤訊息送不出去）。正確做法是不要求它，讓資料照常流完
// （之後進來的 chunk 直接丟棄、不佔記憶體），呼叫端才有機會用還活著的 res 送出 413。
function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, settled = false;
    const fail = (code, error) => {
      if (settled) return;
      settled = true;
      reject({ code, error });
    };
    req.on('data', (d) => {
      if (settled) return;
      size += d.length;
      if (size > maxBytes) { fail(413, `請求過大（>${Math.round(maxBytes / 1024)}KB）`); return; }
      chunks.push(d);
    });
    req.on('error', () => fail(400, '讀取失敗'));
    req.on('end', () => {
      if (settled) return;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { fail(400, 'JSON 解析失敗'); return; }
      settled = true;
      resolve(body);
    });
  });
}

const INDEX_PATH = path.join(QUESTIONS_DIR, 'index.json');
function loadIndex() {
  try {
    const j = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}
function saveIndex(index) {
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2) + '\n', 'utf8');
}

async function handleSaveBank(req, res) {
  let body;
  try { body = await readJsonBody(req, 1024 * 1024); }
  catch (e) { sendJson(res, e.code || 400, { ok: false, error: e.error || String(e) }); return; }

  const questions = Array.isArray(body && body.questions) ? body.questions
                  : (Array.isArray(body) ? body : null);
  if (!questions || questions.length < 1 || questions.length > 1000) {
    sendJson(res, 400, { ok: false, error: '題庫需為 1~1000 題的 JSON 陣列' });
    return;
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
    sendJson(res, 400, { ok: false, error: '檔名不合法' });
    return;
  }

  const payload = JSON.stringify(questions, null, 2) + '\n';
  if (Buffer.byteLength(payload) > 512 * 1024) {
    sendJson(res, 413, { ok: false, error: '題庫檔案過大（>512KB）' });
    return;
  }

  try {
    fs.mkdirSync(QUESTIONS_DIR, { recursive: true });
    fs.writeFileSync(target, payload, 'utf8');

    const index = loadIndex();
    const entry = { file, name: displayName };
    const i = index.findIndex((b) => b && b.file === file);
    if (i >= 0) index[i] = { ...index[i], ...entry }; else index.push(entry);
    saveIndex(index);

    console.log(`[serve-lan] 已寫入題庫 questions/${file}（${questions.length} 題）`);
    sendJson(res, 200, { ok: true, file, name: displayName, path: `../questions/${file}`, count: questions.length });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
}

// ── 題庫管理 API（GET /api/banks、POST /api/update-bank-meta、POST /api/delete-bank）──
// 給 multi/host.html 的「🗂️ 題庫管理」彈窗用：只做元資料（名稱/分類）編輯跟刪除，
// 不編輯題目內容本身（那是自建題庫表單的職責）。
function handleListBanks(req, res) {
  const index = loadIndex();
  const banks = index
    .filter((b) => b && b.file)
    .map((b) => ({
      file: b.file,
      name: b.name || b.file,
      category: typeof b.category === 'string' ? b.category : '',
      builtin: BUILTIN_BANKS.has(b.file),
    }));
  sendJson(res, 200, { ok: true, banks });
}

async function handleUpdateBankMeta(req, res) {
  let body;
  try { body = await readJsonBody(req, 8 * 1024); }
  catch (e) { sendJson(res, e.code || 400, { ok: false, error: e.error || String(e) }); return; }

  const file = String(body && body.file || '').trim();
  const name = String(body && body.name || '').trim();
  const category = String(body && body.category || '').trim().slice(0, 40);
  if (!file) { sendJson(res, 400, { ok: false, error: '缺少 file' }); return; }
  if (!name) { sendJson(res, 400, { ok: false, error: '名稱不可為空' }); return; }

  const index = loadIndex();
  const i = index.findIndex((b) => b && b.file === file);
  if (i < 0) { sendJson(res, 404, { ok: false, error: '找不到該題庫（index.json 無此項目）' }); return; }

  // 內建題庫也能改名/分類（不動題目內容本身，沒有毀損風險），不用另外擋 BUILTIN_BANKS。
  index[i] = { ...index[i], name, category };
  try {
    saveIndex(index);
    sendJson(res, 200, { ok: true, file, name, category });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
}

async function handleDeleteBank(req, res) {
  let body;
  try { body = await readJsonBody(req, 4 * 1024); }
  catch (e) { sendJson(res, e.code || 400, { ok: false, error: e.error || String(e) }); return; }

  const file = String(body && body.file || '').trim();
  if (!file) { sendJson(res, 400, { ok: false, error: '缺少 file' }); return; }
  // BUILTIN_BANKS 已經包含 index.json/player.json 這兩個保留名，這一個判斷就夠了。
  if (BUILTIN_BANKS.has(file)) { sendJson(res, 403, { ok: false, error: '內建題庫不可刪除' }); return; }

  const index = loadIndex();
  const i = index.findIndex((b) => b && b.file === file);
  if (i < 0) { sendJson(res, 404, { ok: false, error: '找不到該題庫（index.json 無此項目）' }); return; }

  const target = path.join(QUESTIONS_DIR, file);
  if (path.dirname(target) !== QUESTIONS_DIR) { sendJson(res, 400, { ok: false, error: '檔名不合法' }); return; }

  try {
    // 先清索引、再刪檔：萬一刪檔失敗，只留下一個沒人指到的孤兒檔案（無害）；
    // 反過來若先刪檔、寫索引失敗，會留下指向不存在檔案的殘留項目，
    // bank-select 選到它時會直接 fetch 404。
    index.splice(i, 1);
    saveIndex(index);
    try { fs.unlinkSync(target); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }  // 已經不存在視為刪除成功
    sendJson(res, 200, { ok: true, file });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
}

// ── 學習報告 API（POST /api/record-session、GET /api/stats、GET /api/stats-list）──────
// 給 multi/host.html 在每場遊戲結束（endGame()）時，把每個玩家這場答對/答錯的範圍
// （題目 domain 欄位）跟具體錯題寫進 stats/<暱稱>.json，之後「📊 學習報告」畫面靠
// GET /api/stats 讀出跨場次的完整紀錄，在前端算準確率趨勢——伺服器端只管 append，
// 不做任何聚合，避免多一份要跟著維護同步的彙總資料。
// 暱稱等同識別碼、沒有帳號驗證，跟 /api/save-bank 是同一套信任模型（見檔案開頭說明），
// 公開到公網（ngrok）時任何人都能用別人的暱稱寫入/查詢，只適合信任範圍內使用。
function statsPath(slug) {
  return path.join(STATS_DIR, `${slug}.json`);
}
function loadStats(slug) {
  try {
    const j = JSON.parse(fs.readFileSync(statsPath(slug), 'utf8'));
    return (j && Array.isArray(j.sessions)) ? j : { name: slug, sessions: [] };
  } catch { return { name: slug, sessions: [] }; }
}

async function handleRecordSession(req, res) {
  let body;
  try { body = await readJsonBody(req, 16 * 1024); }
  catch (e) { sendJson(res, e.code || 400, { ok: false, error: e.error || String(e) }); return; }

  const name = String(body && body.name || '').trim();
  const slug = statsSlug(name);
  if (!slug) { sendJson(res, 400, { ok: false, error: '暱稱不合法' }); return; }

  const toCount = (v) => { const n = Math.trunc(Number(v)); return (Number.isFinite(n) && n >= 0) ? n : 0; };

  const domains = {};
  if (body && body.domains && typeof body.domains === 'object') {
    for (const [domain, v] of Object.entries(body.domains)) {
      const key = String(domain || '(未分類)').trim().slice(0, 40) || '(未分類)';
      domains[key] = { correct: toCount(v && v.correct), wrong: toCount(v && v.wrong) };
    }
  }

  const wrongQuestions = Array.isArray(body && body.wrongQuestions)
    ? body.wrongQuestions
        .filter((w) => w && typeof w.question === 'string' && w.question.trim())
        .slice(0, 1000)
        .map((w) => ({
          question: String(w.question).trim().slice(0, 200),
          domain: String(w.domain || '(未分類)').trim().slice(0, 40) || '(未分類)',
          yourAnswer: String(w.yourAnswer || '').trim().slice(0, 10),
          correctAnswer: String(w.correctAnswer || '').trim().slice(0, 10),
          // 讓學習報告能直接教玩家正解跟原因，不用等下一次被考到同一題才知道
          yourAnswerText: String(w.yourAnswerText || '').trim().slice(0, 120),
          correctAnswerText: String(w.correctAnswerText || '').trim().slice(0, 120),
          explanation: String(w.explanation || '').trim().slice(0, 400),
        }))
    : [];

  const session = {
    ts: new Date().toISOString(),   // 一律由伺服器產生，不信任 client 傳的時間
    bankFile: String(body && body.bankFile || '').trim().slice(0, 80),
    bankName: String(body && body.bankName || '').trim().slice(0, 80),
    totalAnswered: toCount(body && body.totalAnswered),
    totalCorrect: toCount(body && body.totalCorrect),
    domains,
    wrongQuestions,
  };

  const target = statsPath(slug);
  if (path.dirname(target) !== STATS_DIR) { sendJson(res, 400, { ok: false, error: '暱稱不合法' }); return; }

  try {
    fs.mkdirSync(STATS_DIR, { recursive: true });
    const data = loadStats(slug);
    data.name = name;
    data.sessions.push(session);
    if (data.sessions.length > 200) data.sessions = data.sessions.slice(-200);   // 只留最近 200 場
    fs.writeFileSync(target, JSON.stringify(data, null, 2) + '\n', 'utf8');
    sendJson(res, 200, { ok: true });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
}

function handleGetStats(req, res, query) {
  const name = String((query && query.get('name')) || '').trim();
  const slug = statsSlug(name);
  if (!slug) { sendJson(res, 400, { ok: false, error: '暱稱不合法' }); return; }
  const data = loadStats(slug);
  // 查一個還沒打過的暱稱是正常情境（例如剛上場的新玩家），回空陣列而不是 404。
  sendJson(res, 200, { ok: true, name: data.name || name, sessions: data.sessions });
}

function handleListStatsNames(req, res) {
  let files = [];
  try { files = fs.readdirSync(STATS_DIR); } catch { /* 目錄還不存在，視為沒有任何紀錄 */ }
  const names = files
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const slug = f.slice(0, -5);
      const data = loadStats(slug);
      return { name: data.name || slug, sessions: data.sessions.length };
    })
    .filter((n) => n.sessions > 0)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
  sendJson(res, 200, { ok: true, names });
}

// ── 遊戲設定寫檔 API（POST /api/save-game-settings）─────────────────────────
// host.html 大廳「⚙ 遊戲設定」彈窗按下「套用」時呼叫，把目前套用的參數子集寫進
// multi/game-settings.json（跟 questions/、stats/ 不同，這個檔案**沒有**被 .gitignore
// 排除——設計上就是要讓它進版本控制，換電腦 git clone/pull 時最後套用的遊戲參數會
// 跟著過去，不用每個環境重新調一次）。讀取端不需要另開 API：它是專案裡的一個普通靜態
// JSON 檔，host.html 用 fetch('game-settings.json') 直接讀（見 host.html 的
// GameSettings.load()），Caddy/這支伺服器本來就會當一般靜態檔案伺服。
//
// 只接受白名單裡的欄位（跟 host.html 的 GameSettings.KEYS 對應），並各自夾限在合理
// 範圍——不能假設送進來的 body 是乾淨的（純瀏覽器 fetch，任何人都能自己組 POST），
// 這裡的 min/max 跟 host.html 彈窗 <input min max> 給的一致，屬於防禦性重複，不是
// 唯一防線但也不能沒有。
const GAME_SETTINGS_SCHEMA = {
  PREPARE_TIME:    { type: 'number',  min: 1,    max: 30 },
  ANSWER_TIME:     { type: 'number',  min: 3,    max: 120 },
  LOCK_MS:         { type: 'number',  min: 0,    max: 5000 },
  RESULT_MS:       { type: 'number',  min: 500,  max: 10000 },
  EXPL_MS:         { type: 'number',  min: 500,  max: 20000 },
  MAX_SCORE:       { type: 'number',  min: 1,    max: 100 },
  MIN_SCORE:       { type: 'number',  min: 0,    max: 100 },
  MAX_PENALTY:     { type: 'number',  min: 0,    max: 100 },
  MIN_PENALTY:     { type: 'number',  min: 0,    max: 100 },
  enableLive2D:    { type: 'boolean' },
  maxPlayerChars:  { type: 'number',  min: 2,    max: 4 },
  IDLE_MOTION_MS:  { type: 'number',  min: 1000, max: 30000 },
  TOAST_MS:        { type: 'number',  min: 300,  max: 6000 },
};

async function handleSaveGameSettings(req, res) {
  let body;
  try { body = await readJsonBody(req, 4 * 1024); }
  catch (e) { sendJson(res, e.code || 400, { ok: false, error: e.error || String(e) }); return; }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendJson(res, 400, { ok: false, error: '格式錯誤，需為物件' });
    return;
  }

  // 讀現有檔案當底，逐欄位夾限後蓋上去，不認得的 key 直接忽略——host.html 目前一律
  // 送完整的 13 個欄位，但這裡故意允許只送部分子集，之後要單獨調某幾項也不用改後端；
  // 用「讀底 + merge」而不是整包覆蓋，partial body 才不會把沒送到的既有欄位噴掉。
  let out = {};
  try { out = JSON.parse(fs.readFileSync(GAME_SETTINGS_PATH, 'utf8')) || {}; } catch {}
  if (typeof out !== 'object' || Array.isArray(out)) out = {};

  for (const [key, rule] of Object.entries(GAME_SETTINGS_SCHEMA)) {
    if (!(key in body)) continue;
    if (rule.type === 'boolean') {
      out[key] = !!body[key];
    } else {
      const n = Number(body[key]);
      if (!Number.isFinite(n)) continue;
      out[key] = Math.min(rule.max, Math.max(rule.min, n));
    }
  }

  try {
    fs.mkdirSync(MULTI_DIR, { recursive: true });
    fs.writeFileSync(GAME_SETTINGS_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8');
    console.log('[serve-lan] 已更新 multi/game-settings.json');
    sendJson(res, 200, { ok: true, settings: out });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
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

  // 題庫管理 API（見檔案上方 handleListBanks／handleUpdateBankMeta／handleDeleteBank 說明）
  if (urlPath === '/api/banks') {
    if (req.method !== 'GET') { res.writeHead(405); res.end('Method Not Allowed'); return; }
    handleListBanks(req, res);
    return;
  }
  if (urlPath === '/api/update-bank-meta') {
    if (req.method !== 'POST') { res.writeHead(405); res.end('Method Not Allowed'); return; }
    handleUpdateBankMeta(req, res);
    return;
  }
  if (urlPath === '/api/delete-bank') {
    if (req.method !== 'POST') { res.writeHead(405); res.end('Method Not Allowed'); return; }
    handleDeleteBank(req, res);
    return;
  }

  // 學習報告 API（見檔案上方 handleRecordSession／handleGetStats／handleListStatsNames 說明）
  if (urlPath === '/api/record-session') {
    if (req.method !== 'POST') { res.writeHead(405); res.end('Method Not Allowed'); return; }
    handleRecordSession(req, res);
    return;
  }
  if (urlPath === '/api/stats') {
    if (req.method !== 'GET') { res.writeHead(405); res.end('Method Not Allowed'); return; }
    handleGetStats(req, res, new URL(req.url, 'http://localhost').searchParams);
    return;
  }
  if (urlPath === '/api/stats-list') {
    if (req.method !== 'GET') { res.writeHead(405); res.end('Method Not Allowed'); return; }
    handleListStatsNames(req, res);
    return;
  }

  // 遊戲設定寫檔 API（見檔案上方 handleSaveGameSettings 說明）。讀取不需要專屬路由，
  // multi/game-settings.json 落在下方的一般靜態檔案處理分支就會被伺服。
  if (urlPath === '/api/save-game-settings') {
    if (req.method !== 'POST') { res.writeHead(405); res.end('Method Not Allowed'); return; }
    handleSaveGameSettings(req, res);
    return;
  }

  // 公網網址查詢 API（見檔案下方 fetchNgrokTunnels／findPublicTunnel 說明）——
  // host.html 用這條路由自動偵測 ngrok 通道，不用主持人自己開 127.0.0.1:4040 查完再手動貼。
  if (urlPath === '/api/public-url') {
    if (req.method !== 'GET') { res.writeHead(405); res.end('Method Not Allowed'); return; }
    handlePublicUrl(req, res);
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
  // 這支腳本有兩種啟動情境，訊息要對應講清楚，不然容易誤導人：
  //   · 真退路（啟動-網頁遊戲.bat 沒偵測到 caddy.exe 時）：這支就是唯一的網站伺服器，
  //     沒有 /mqtt 外網反代，只能區網內用。
  //   · Caddy 的題庫寫檔小幫手（:start_bank_api，偵測到 caddy.exe 才會啟動、固定 8081
  //     埠——Caddyfile 的 reverse_proxy /api/* localhost:8081 轉進來，8081 本身沒有
  //     對外開放，只有透過 Caddy 的 8080 才連得到）：Caddy 本身正常在服務公網（含
  //     ngrok），這支只是負責寫檔。第一行原本無條件印「區網靜態伺服器」，跟下面判斷
  //     出來的模式矛盾、容易讓人誤以為退回區網——兩行改成同一個判斷式，講法才會一致。
  const caddyPresent = fs.existsSync(path.join(ROOT, 'caddy.exe'));
  if (caddyPresent) {
    console.log(`[serve-lan] 題庫寫檔／學習報告 API 已啟動： http://localhost:${PORT}/（搭配 Caddy 用，非退路模式）`);
    console.log('[serve-lan] 偵測到 caddy.exe：Caddy 本身在另一個視窗服務主要流量（8080 埠，含公網/ngrok），這支只負責寫檔。');
    reportNgrokStatus();
  } else {
    console.log(`[serve-lan] 區網靜態伺服器已啟動： http://localhost:${PORT}/`);
    console.log('[serve-lan] 這是沒偵測到 caddy.exe 時的退路版本，只支援區網內連線，不含 /mqtt 外網反代。');
  }
  console.log('[serve-lan] POST /api/save-bank 可把上傳的題庫寫進 questions/ 並更新 index.json。');
  console.log('[serve-lan] POST /api/record-session 可把玩家這場的作答明細寫進 stats/ 供學習報告查詢。');
  console.log('[serve-lan] POST /api/save-game-settings 可把「⚙ 遊戲設定」套用值寫進 multi/game-settings.json（跟著 git 版本走）。');
  console.log('[serve-lan] 關閉這個視窗即停止伺服器。');
});

// 問 ngrok 本機的檢視 API（127.0.0.1:4040，ngrok 執行中才會開）拿目前所有通道清單，
// 啟動時的主控台訊息（reportNgrokStatus）跟 host.html 自動偵測公網網址用的
// /api/public-url（handlePublicUrl）共用這個查詢，不用兩邊各自寫一次同樣的
// http.get + timeout + 解析邏輯。非阻塞、有 1.5 秒逾時：ngrok 可能比這支腳本晚啟動
// （開啟順序本來就沒有保證），查不到不代表「沒有公網模式」，只代表「現在這一刻還沒
// 查到」——呼叫端的訊息措辭要照實講，不能講成確定的否定結論。
// cb(tunnels)：查到就是陣列（可能是空陣列），查詢失敗（ngrok 沒開/逾時/回應格式異常）
// 一律回 null，讓呼叫端能分辨「查到 0 個通道」跟「根本查不到」。
function fetchNgrokTunnels(cb) {
  // timeout 觸發 req.destroy() 之後，底層 socket 常常會再補發一次 'error'（例如
  // ECONNRESET）——用這個旗標擋掉，不然 cb 會被呼叫兩次。
  let done = false;
  const req = http.get({ host: '127.0.0.1', port: 4040, path: '/api/tunnels', timeout: 1500 }, (res) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      if (done) return;
      done = true;
      try {
        const data = JSON.parse(body);
        cb(Array.isArray(data.tunnels) ? data.tunnels : []);
      } catch {
        cb(null);
      }
    });
  });
  req.on('timeout', () => { req.destroy(); });
  req.on('error', () => {
    if (done) return;
    done = true;
    cb(null);
  });
}

// 通道清單裡挑出「轉發到本機 8080（Caddy）的 https 通道」——這台機器可能同時開著別的
// ngrok 通道轉發別的埠，不能隨便拿清單第一個。
function findPublicTunnel(tunnels) {
  return (tunnels || []).find(
    (t) => t.proto === 'https' && /:8080$/.test((t.config && t.config.addr) || ''),
  ) || null;
}

function reportNgrokStatus() {
  fetchNgrokTunnels((tunnels) => {
    if (tunnels === null) {
      console.log('[serve-lan] 目前還沒偵測到 ngrok 通道（可能還沒啟動，晚一點開也可以）——開了之後公網網址可到 http://127.0.0.1:4040 查。');
      return;
    }
    const tunnel = findPublicTunnel(tunnels);
    if (tunnel) {
      console.log(`[serve-lan] 偵測到 ngrok 通道，目前是公網模式：${tunnel.public_url}`);
    } else {
      console.log('[serve-lan] ngrok 正在跑，但沒看到指向 8080 埠的通道——確認指令是不是下對埠號（ngrok http 8080）。');
    }
  });
}

// GET /api/public-url：host.html 的 detectPublicUrl() 每幾秒問一次，查到就自動把
// 玩家加入網址／QR 換成這個公網網址，不用主持人自己開 127.0.0.1:4040 查完再手動貼進
// 「連線設定」欄位。查不到（ngrok 沒開、還沒起來、或不是 Caddy 模式）就回 publicUrl:
// null，前端會照原本的區網邏輯顯示，不影響現有行為。
function handlePublicUrl(req, res) {
  fetchNgrokTunnels((tunnels) => {
    const tunnel = findPublicTunnel(tunnels);
    sendJson(res, 200, { publicUrl: tunnel ? tunnel.public_url : null });
  });
}
