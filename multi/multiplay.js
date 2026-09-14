'use strict';

// ── 修改這裡切換伺服器設定 ────────────────────────────────────────────────
const MP_CFG = {
  brokerIP:     window.location.hostname || '192.168.0.171',  // 自動跟隨當前伺服器 IP
  wsPort:       9001,
  QUESTION_BANK:'../questions/business.json',
  GAME_Q_COUNT: 10,
  PREPARE_TIME: 3,
  ANSWER_TIME:  12,
  LOCK_MS:      900,    // 搶答畫面停留時間（ms）
  RESULT_MS:    2500,   // 結果顯示時間（ms）
  EXPL_MS:      4000,   // 解說顯示時間（ms）
  enableLive2D: true,  // 玩家裝置是否啟用 Live2D（true=載入，false=跳過）
  // 玩家端 join 畫面「角色數」選單最多開放到幾個（2~4）。考慮到玩家裝置（尤其手機）
  // 的運算資源，同時渲染越多角色越吃效能，調低這個數字就能讓玩家選單不出現 3/4，
  // 不用去改 player.html 本身；host.html 的角色數選單不受這個值限制（主持端通常用自己電腦）。
  maxPlayerChars: 4,
  MAX_SCORE:    10,     // 立即搶答正確得分（10題滿分100）
  MIN_SCORE:    1,      // 最後一秒正確得分
  MAX_PENALTY:  5,      // 立即搶答答錯扣分
  MIN_PENALTY:  1,      // 最後一秒答錯扣分

  // 以下幾個原本是 host.html / player.html 兩邊各自硬編碼同一個數字，
  // 改一邊很容易忘記改另一邊，統一搬到這裡共同維護：
  // Live2D 答題期間的閒置循環：IDLE_MOTION_MS 是唯一控制動作/表情觸發頻率的地方，
  // startIdleChat（對話泡泡+音效）不再自己觸發動作/表情，職責分開後兩個循環改用同一個間隔對齊節奏。
  IDLE_MOTION_MS:    6000,
  HEARTBEAT_MS:      3000,  // 玩家送出在線心跳的間隔；主持人端也用同一個數字當作輪詢檢查頻率
  OFFLINE_MS:        10000, // 主持人判定玩家離線的門檻：超過這麼久沒收到心跳才算離線，須明顯大於 HEARTBEAT_MS 留緩衝，避免正常網路抖動被誤判離線
  TOAST_MS:          1600,  // 得分飄字（showToast）顯示多久後自動消失
  MQTT_RECONNECT_MS: 3000,  // MQTT 斷線後的自動重連間隔

  // 左下角按鈕直向堆疊（音效/特效開關 + BGM 控制條），host.html 與 player.html
  // 用的是同一套版面（角色拖曳鈕固定佔 bottom:8px 那一格，這幾顆接著往上疊），
  // 兩邊原本各自寫死同一組數字，改版面要同時改兩處，統一搬到這裡：
  SND_BTN_BOTTOM: 61,   // 音效開關按鈕
  VFX_BTN_BOTTOM: 217,  // 特效開關按鈕
  BGM_CTRL_BOTTOM: 114, // BGM 控制條

  // VoiceBroadcastModule 的 WebRTC ICE 設定（STUN server），原本寫死在該模組裡，
  // 跟其他連線設定（brokerIP/wsPort）一樣搬到這裡集中管理：
  VOICE_ICE_SERVERS: [{ urls: 'stun:stun.l.google.com:19302' }],
};
// ─────────────────────────────────────────────────────────────────────────

// MQTT WebSocket URL 自動判斷：
//   http://  → 區網直連  ws://IP:9001         （直接連 Mosquitto）
//   https:// → 公網模式  wss://hostname/mqtt   （經 Caddy 反向代理，路徑 /mqtt）
function mpMqttUrl() {
  if (location.protocol === 'https:')
    return `wss://${MP_CFG.brokerIP}/mqtt`;
  return `ws://${MP_CFG.brokerIP}:${MP_CFG.wsPort}`;
}

const MP_TOPICS = {
  JOIN:      'quiz/multi/join',      // player → host
  STATE:     'quiz/multi/state',     // host → all (retained)
  ANSWER:    'quiz/multi/answer',    // player/host → all（host 處理）
  RESULT:    'quiz/multi/result',    // host → all（本題結果）
  SOUND:     'quiz/sound',           // Node-RED → all（音效指令，純文字）
  L2D:       'quiz/multi/l2d',       // host → all（Live2D 動作/語音同步，qos 0）
  HEARTBEAT: 'quiz/heartbeat',       // player → host（在線心跳，qos 0）
  PROFILE:   'quiz/player/profile',  // player → all（頭像 Base64，加入時送一次，qos 0）
  CHAT:      'quiz/chat',            // player/host → all（聊天泡泡，qos 0）
  DANMAKU:   'quiz/danmaku',         // player/host → all（彈幕，qos 0）
  TYPING:    'quiz/chat/typing',     // player → all（打字指示器，qos 0）
  // 開賽前閒聊：payload { tempName, message }，tempName 是前端隨機產生的匿名代號，
  // 不是 JOIN 流程給的 playerId——這個頻道刻意跟 CHAT 分開，因為 CHAT 的訊息格式
  // 綁著「已加入玩家」的 playerId（給 PlayerBubbleChat 對應頭像泡泡用），還沒加入
  // 房間的訪客沒有這個身分。渲染上一樣借用 DanmakuSystem，只是資料來源分開，
  // 兩邊職責才不會混在一起。只在 phase==='lobby' 時雙方才會收發，見 host.html/player.html。
  LOBBY_MSG: 'quiz/lobby/msg',       // player/host → all（開賽前閒聊，qos 0）
  // 玩家在「📚 有哪些題庫可選？」彈窗點某個題庫時送出，讓主持人知道有人想玩這個題庫。
  // payload { id, name, bankFile, bankName }，單向 player → host（host 沒有訂閱這個
  // topic 以外的任何用途，player 自己也不用收，不像 CHAT/DANMAKU 是廣播給所有人看）。
  BANK_RECOMMEND: 'quiz/bank/recommend', // player → host，qos 0
  // VoiceBroadcastModule 專用：SIGNAL 是「前綴 + 自己的 playerId」動態組出來的訂閱
  // topic（不是單一固定字串，跟上面其他 topic 用法不同，使用端要自己接 + myId），
  // CTRL 是固定的控制頻道（開始/結束廣播通知）。
  VOICE_SIGNAL_PREFIX: 'quiz/voice/signal/',
  VOICE_CTRL:          'quiz/voice/ctrl',
};

const MP_MEDALS        = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
const MP_PLAYER_COLORS = ['#00d4ff', '#ff6b6b', '#00ff88', '#ffd60a', '#ff9f1c', '#a855f7', '#f97316', '#06b6d4', '#84cc16', '#f472b6'];
const MP_EMOJIS        = ['😀', '😂', '😭', '😡', '👍', '👏', '🎉', '❤️', '🔥', '❓'];  // 快速表情反應清單，host.html/player.html 共用

/**
 * 依玩家 ID 決定固定顏色（雜湊 → 偏好索引，collision 時往後找空位）
 * @param {string}   id          玩家 ID（localStorage 持久化，同裝置永遠相同）
 * @param {string[]} usedColors  已被其他玩家佔用的顏色陣列
 */
function mpPlayerColor(id, usedColors = []) {
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) >>> 0;
  const n    = MP_PLAYER_COLORS.length;
  const used = new Set(usedColors);
  for (let i = 0; i < n; i++) {
    const c = MP_PLAYER_COLORS[(h + i) % n];
    if (!used.has(c)) return c;
  }
  return MP_PLAYER_COLORS[h % n];   // 所有顏色都被佔用時允許重色
}

/**
 * 計算得分／扣分（依剩餘秒數線性縮放）
 * 答對：timeLeft=ANSWER_TIME → +MAX_SCORE；timeLeft=0 → +MIN_SCORE
 * 答錯：timeLeft=ANSWER_TIME → -MAX_PENALTY；timeLeft=0 → -MIN_PENALTY
 */
function mpCalcPoints(timeLeft, isCorrect) {
  const r = Math.max(0, Math.min(1, timeLeft / MP_CFG.ANSWER_TIME));
  if (isCorrect) return  Math.max(MP_CFG.MIN_SCORE,   Math.round(MP_CFG.MAX_SCORE   * r));
  return                -Math.max(MP_CFG.MIN_PENALTY, Math.round(MP_CFG.MAX_PENALTY * r));
}

// 實作在 ../lib/shuffle.js（single/ 與 multi/ 共用）
function mpShuffle(arr) {
  return shuffleArray(arr);
}

// 回傳依分數降冪排序的玩家陣列，附上 rank（1-based）
function mpRankPlayers(players) {
  return Object.entries(players)
    .map(([id, p]) => ({ id, ...p }))
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ ...p, rank: i + 1 }));
}

// ── 學習報告彈窗（host.html／player.html 共用）───────────────────────────
// 依暱稱查詢跨場次的答題紀錄（launchers/serve-lan.js 的 GET /api/stats、/api/stats-list），
// 在前端把 sessions 陣列算成「常錯範圍」「常錯題目」「歷次表現」三個區塊——伺服器端只管
// append 原始紀錄，聚合邏輯統一放這裡，之後要改算法不用動後端。這整段本來在 host.html
// 跟 player.html 各自維護一份（複製貼上），改一邊很容易忘記改另一邊，統一搬來這裡共同維護。
//
// 分類篩選：題庫本身可以在「🗂️ 管理題庫」設定 category（questions/index.json 的
// category 欄位），跟每題的 domain 是兩層不同粒度（domain 是題庫「裡面」再細分，
// category 是題庫「之間」怎麼分群，例如把 資產負債/綜合損益/機會成本 都歸進「會計學」）。
// 這裡抓 index.json 做 bankFile → category 的對照表，查完某暱稱的所有場次後，讓使用者
// 選一個分類，三個區塊（含歷次表現）都只算落在該分類題庫的場次——只篩「常錯」兩塊、
// 歷次表現卻還混著別分類的場次，畫面看起來會很怪。
//
// 兩邊僅有的差異都用「呼叫端是否定義了某個全域函式」這個既有慣例處理，不用另外設計參數：
//   · _statsDefaultName()：開窗時要預填的暱稱。host.html 填 HS.myName，player.html 填
//     PS.myName（退回 localStorage 記住的上次暱稱）——兩邊各自在自己的 <script> 定義這個
//     一行小函式，這裡用 typeof 判斷是否存在，不存在就不預填。
//   · recommendBank(bankFile, bankName)：只有 player.html 定義（點一下「推薦主持人多出
//     這個範圍」），host.html 沒有這個函式，_renderDomainSection() 裡的 typeof 判斷會讓
//     那顆推薦按鈕在 host.html 端自然不渲染，不用另外分兩份函式。
//
// 這裡用到的 el()/show()/hide() 是 host.html/player.html 各自在自己的 <script> 裡定義的
// DOM 小工具（在 <script src="multiplay.js"> 之後才賦值）——函式本體要到使用者實際點擊
// 「學習報告」按鈕才會被呼叫，那時候兩邊都早就定義好了，所以這裡直接引用沒有時序問題；
// 但幫這些按鈕接上 addEventListener 的「立即執行」那幾行不能搬過來（multiplay.js 載入時
// el 可能還沒賦值），繼續留在 host.html/player.html 自己的 <script> 裡。
let _statsSessions    = [];    // 目前查詢到、未篩選的原始場次；換暱稱/重新查詢會整包換掉
let _bankCategoryMap  = null;  // bankFile → category，惰性抓一次、快取著，不用每次查詢都重抓

function openStatsModal() {
  show('stats-modal');
  _loadStatsNameOptions();
  const input = el('stats-name-input');
  if (!input.value) {
    const defaultName = typeof _statsDefaultName === 'function' ? _statsDefaultName() : '';
    if (defaultName) input.value = defaultName;
  }
  if (input.value) queryStatsReport(input.value);
}
function closeStatsModal() {
  hide('stats-modal');
}

async function _loadStatsNameOptions() {
  const sel = el('stats-name-select');
  sel.innerHTML = '<option value="">（選擇已有紀錄的暱稱）</option>';
  try {
    const r = await fetch('/api/stats-list');
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) return;
    (j.names || []).forEach(({ name, sessions }) => {
      const opt = document.createElement('option');
      opt.value = name; opt.textContent = `${name}（${sessions} 場）`;
      sel.appendChild(opt);
    });
  } catch { /* 沒有後端 API 時，選單就只留預設選項，仍可用輸入框直接查 */ }
}

// bankFile（例如「資產負債.json」）→ category 對照表，來源跟大廳題庫下拉選單同一份
// questions/index.json。抓不到（後端沒開等）就退化成空表，分類選單只剩「全部分類」，
// 不影響原本沒有分類篩選時的查詢行為。
async function _ensureBankCategoryMap() {
  if (_bankCategoryMap) return _bankCategoryMap;
  const map = {};
  try {
    const r = await fetch('../questions/index.json');
    if (r.ok) (await r.json()).forEach((b) => { if (b.category) map[b.file] = b.category; });
  } catch { /* 見上方註解 */ }
  _bankCategoryMap = map;
  return map;
}

async function queryStatsReport(name) {
  const statusEl = el('stats-status'), reportEl = el('stats-report');
  statusEl.textContent = '查詢中…'; statusEl.style.color = 'var(--text2)';
  reportEl.innerHTML = '';
  await _ensureBankCategoryMap();
  let sessions;
  try {
    const r = await fetch('/api/stats?name=' + encodeURIComponent(name));
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || `後端回應 ${r.status}`);
    sessions = j.sessions || [];
  } catch (e) {
    statusEl.textContent = '✗ 無法查詢（' + ((e && e.message) || '連線失敗') +
      '）。學習報告需要後端 API（埠 8081）才能使用。';
    statusEl.style.color = 'var(--red)';
    _statsSessions = [];
    _renderStatsCategoryOptions();
    return;
  }
  _statsSessions = sessions;
  _renderStatsCategoryOptions();
  if (!sessions.length) {
    statusEl.textContent = '';
    const hint = document.createElement('div');
    hint.className = 'stats-empty-hint';
    hint.textContent = `「${name}」目前還沒有任何遊戲紀錄。`;
    reportEl.appendChild(hint);
    return;
  }
  renderStatsReport();
}

// 依「目前查到的場次」列出實際出現過的分類——沒分類的題庫、或這個人根本沒打過的分類
// 都不列，避免選單裡一堆選了也是空白的選項。保留使用者原本選的分類（換暱稱查詢後，
// 如果新的人也有玩過同一個分類，篩選狀態不用重選）。
function _renderStatsCategoryOptions() {
  const sel = el('stats-category-select');
  if (!sel) return;
  const prevValue = sel.value;
  const cats = new Set();
  _statsSessions.forEach((s) => {
    const cat = _bankCategoryMap[s.bankFile];
    if (cat) cats.add(cat);
  });
  sel.innerHTML = '<option value="">全部分類</option>';
  [...cats].sort((a, b) => a.localeCompare(b, 'zh-Hant')).forEach((cat) => {
    const opt = document.createElement('option');
    opt.value = cat; opt.textContent = cat;
    sel.appendChild(opt);
  });
  sel.value = cats.has(prevValue) ? prevValue : '';
}

// 依目前選的分類重畫三個區塊。切換分類選單、或查詢到新的一批 sessions 之後都會呼叫這個。
function renderStatsReport() {
  const statusEl = el('stats-status'), reportEl = el('stats-report');
  if (!_statsSessions.length) return;   // 這個人完全沒紀錄的情況在 queryStatsReport() 已經處理過
  reportEl.innerHTML = '';

  const category = el('stats-category-select')?.value || '';
  const sessions = category
    ? _statsSessions.filter((s) => _bankCategoryMap[s.bankFile] === category)
    : _statsSessions;

  statusEl.textContent = category
    ? `「${category}」共 ${sessions.length} 場紀錄（全部分類共 ${_statsSessions.length} 場）`
    : `共 ${sessions.length} 場紀錄`;
  statusEl.style.color = 'var(--text2)';

  if (!sessions.length) {
    const hint = document.createElement('div');
    hint.className = 'stats-empty-hint';
    hint.textContent = `「${category}」分類目前還沒有紀錄。`;
    reportEl.appendChild(hint);
    return;
  }
  const domainColorMap = _buildDomainColorMap(sessions);
  reportEl.appendChild(_renderDomainSection(sessions, domainColorMap));
  reportEl.appendChild(_renderWrongQuestionsSection(sessions));
  reportEl.appendChild(_renderSessionHistorySection(sessions));
}

// domain（範圍）→ 顏色：用文字雜湊挑一個固定調色盤裡的顏色，同一個 domain 字串永遠拿到
// 同一個顏色、不用手動維護對照表，之後題庫、domain 再怎麼新增都自動套用（超過調色盤數量
// 就循環使用，數十種 domain 內都還分得清楚）。「常錯範圍」的色點、「常錯題目」的長條都靠
// 這個函式配色，同一個 domain 在兩區塊顏色一致。
const _DOMAIN_COLOR_PALETTE = [
  '#00d4ff', '#ff3355', '#ffcc00', '#7c4dff', '#00e676', '#ff6ec7',
  '#ff8a3d', '#ba68c8', '#c6ff00', '#40c4ff', '#ffab40', '#4dd0e1',
];
function _domainColor(domain) {
  const s = String(domain || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return _DOMAIN_COLOR_PALETTE[h % _DOMAIN_COLOR_PALETTE.length];
}

// 單次渲染範圍內（目前篩選出來的 sessions）出現過的 domain，依字母序排好後依序從調色盤
// 發色——比單純雜湊更能保證「這次畫面上看到的 domain 彼此顏色不重複」（domain 數只要不超過
// 調色盤大小 12 個，同一畫面內絕不撞色；雜湊法在 domain 數一多就容易撞色）。不在這份地圖裡
// 的 domain（理論上不會發生，保險用）退回 _domainColor() 雜湊值。
function _buildDomainColorMap(sessions) {
  const domains = new Set();
  sessions.forEach((s) => Object.keys(s.domains || {}).forEach((d) => domains.add(d)));
  const sorted = [...domains].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
  const map = new Map();
  sorted.forEach((d, i) => map.set(d, _DOMAIN_COLOR_PALETTE[i % _DOMAIN_COLOR_PALETTE.length]));
  return map;
}

// 單一 domain 依場次先後排列的準確率數列（sessions 本身已經是舊→新排序，append-only 資料
// append 的順序就是時間順序，不用另外排序）。只算「這場有考到這個 domain」的場次，沒考到
// 的場次不算一筆（不然會被沒作答的 0% 拉低，失真）。
function _domainTrendPoints(sessions, domain) {
  const points = [];
  sessions.forEach((s) => {
    const d = s.domains && s.domains[domain];
    if (!d) return;
    const t = (d.correct || 0) + (d.wrong || 0);
    if (t > 0) points.push({ v: d.correct / t, n: t });
  });
  return points;
}
// 把數列畫成一個小折線（SVG polyline）。少於兩筆資料畫不出「趨勢」，回傳 null（呼叫端補一個
// 等寬的空白，維持每列版面對齊）。線的顏色依「最後一場 vs 第一場」判斷：進步超過 8 個百分點
// 畫綠色、退步超過 8 個百分點畫紅色，介於中間（看不出明顯趨勢）就用 domain 自己的識別色。
// 8% 這個門檻只是「看得出差異、又不會太敏感」的經驗值，不是統計上嚴謹的顯著性檢定。
function _renderTrendSpark(points, fallbackColor) {
  if (points.length < 2) return null;
  const w = 60, h = 20, pad = 2;
  const stepX = (w - pad * 2) / (points.length - 1);
  const coords = points.map((p, i) => {
    const x = pad + i * stepX;
    const y = pad + (1 - p.v) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  // 每局最低題數已從 3 改成 1（見 q-count-input），單題場次的某個 domain 準確率只會是
  // 0% 或 100%，拿它跟另一筆資料比較來判斷「進步／退步」太武斷、容易誤導。只挑樣本數
  // >= MIN_TREND_SAMPLE 的頭尾兩筆資料判斷趨勢色，兩者不足時（例如全部都是單題場次）
  // 維持 domain 自己的識別色，不做進步/退步的顏色宣稱；折線本身仍畫出全部資料點，
  // 不因此少畫、失真形狀，滑鼠移上去的 tooltip 也仍顯示完整頭尾百分比供參考。
  const MIN_TREND_SAMPLE = 2;
  const qualified = points.filter((p) => p.n >= MIN_TREND_SAMPLE);
  const first = points[0], last = points[points.length - 1];
  let stroke = fallbackColor;
  if (qualified.length >= 2) {
    const qFirst = qualified[0], qLast = qualified[qualified.length - 1];
    const diff = qLast.v - qFirst.v;
    stroke = diff > 0.08 ? 'var(--green)' : diff < -0.08 ? 'var(--red)' : fallbackColor;
  }

  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('width', w); svg.setAttribute('height', h); svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  const titleEl = document.createElementNS(svgNS, 'title');
  titleEl.textContent = `近 ${points.length} 場：${Math.round(first.v * 100)}% → ${Math.round(last.v * 100)}%`;
  svg.appendChild(titleEl);
  const poly = document.createElementNS(svgNS, 'polyline');
  poly.setAttribute('points', coords);
  poly.setAttribute('fill', 'none');
  poly.setAttribute('stroke', stroke);
  poly.setAttribute('stroke-width', '2');
  poly.setAttribute('stroke-linecap', 'round');
  poly.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(poly);
  return svg;
}

// 「常錯範圍」：跨所有場次把每個 domain 的 correct/wrong 加總，依準確率由低到高排序，
// 用橫向色塊呈現——準確率越低（容易答錯）排越前面，最直接對應使用者想看的「弱點在哪」。
// 長條本身維持紅→黃→青的準確率漸層（顏色代表「這個範圍多差」），額外在名稱前加一個
// _domainColor() 色點做「範圍識別」，跟常錯題目的長條顏色對照；名稱後面再加一個小折線
// 顯示這個範圍「有沒有在進步」（只看總平均看不出趨勢，見 _renderTrendSpark()）。
// 題庫／範圍之後只會愈養愈多，rows 不設上限，改用固定高度的 .stats-domain-list 內部
// 捲動裝下，不會把整張卡片越撐越高。
function _renderDomainSection(sessions, domainColorMap) {
  const totals = {};
  sessions.forEach((s) => {
    Object.entries(s.domains || {}).forEach(([domain, v]) => {
      if (!totals[domain]) totals[domain] = { correct: 0, wrong: 0 };
      totals[domain].correct += v.correct || 0;
      totals[domain].wrong += v.wrong || 0;
    });
  });
  const rows = Object.entries(totals)
    .map(([domain, v]) => ({ domain, ...v, total: v.correct + v.wrong, pct: v.correct + v.wrong ? v.correct / (v.correct + v.wrong) : 0 }))
    .filter((r) => r.total > 0)
    .sort((a, b) => a.pct - b.pct);

  const wrap = document.createElement('div');
  wrap.className = 'stats-card';
  const title = document.createElement('div');
  title.className = 'stats-section-title'; title.textContent = '📉 常錯範圍（依準確率排序）';
  wrap.appendChild(title);
  if (!rows.length) {
    const hint = document.createElement('div');
    hint.className = 'stats-empty-hint'; hint.textContent = '這幾場題目都沒有標記範圍（domain），無法統計。';
    wrap.appendChild(hint);
    return wrap;
  }
  const list = document.createElement('div');
  list.className = 'stats-domain-list';
  rows.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'stats-domain-row';
    const dotEl = document.createElement('span');
    dotEl.className = 'stats-domain-dot'; dotEl.style.background = domainColorMap.get(r.domain) || _domainColor(r.domain);
    const nameEl = document.createElement('span');
    nameEl.className = 'stats-domain-name'; nameEl.title = r.domain; nameEl.textContent = r.domain;
    const sparkWrap = document.createElement('span');
    sparkWrap.className = 'stats-domain-spark-wrap';
    const spark = _renderTrendSpark(_domainTrendPoints(sessions, r.domain), domainColorMap.get(r.domain) || _domainColor(r.domain));
    if (spark) sparkWrap.appendChild(spark);
    const barWrap = document.createElement('span');
    barWrap.className = 'stats-domain-bar-wrap';
    const bar = document.createElement('span');
    bar.className = 'stats-domain-bar'; bar.style.width = Math.round(r.pct * 100) + '%';
    barWrap.appendChild(bar);
    const pctEl = document.createElement('span');
    pctEl.className = 'stats-domain-pct';
    pctEl.textContent = `${Math.round(r.pct * 100)}%（${r.correct}/${r.total}）`;
    row.append(dotEl, nameEl, sparkWrap, barWrap, pctEl);
    list.appendChild(row);
  });
  wrap.appendChild(list);

  // 最弱的範圍（rows[0]，因為已經依準確率由低到高排序）額外加一顆推薦按鈕，讓玩家發現
  // 弱點後可以直接一鍵推薦主持人多出這個範圍，不用再手動切去「有哪些題庫可選」彈窗找。
  // 從 sessions 找「最近一場包含這個 domain」的場次，拿它的 bankFile/bankName 當推薦目標
  // （domain 通常只會出現在同一個題庫裡，用最近一場最保險）。recommendBank() 是玩家端才有
  // 的函式，host.html 沒有定義這個函式——下面的 typeof 判斷會讓這顆按鈕在 host.html 端
  // 自然不渲染，那邊自己看報告用，沒有「推薦給誰」的對象。
  const worst = rows[0];
  const worstSession = [...sessions].reverse().find((s) => s.domains && s.domains[worst.domain]);
  if (worstSession && worstSession.bankFile && typeof recommendBank === 'function') {
    const cta = document.createElement('button');
    cta.type = 'button';
    cta.className = 'stats-recommend-cta';
    cta.textContent = `🎯 推薦主持人多出「${worst.domain}」`;
    cta.addEventListener('click', () => recommendBank(worstSession.bankFile, worstSession.bankName || worstSession.bankFile));
    wrap.appendChild(cta);
  }
  return wrap;
}

// 「常錯題目」：跨所有場次把 wrongQuestions 依題目文字分組計數，錯最多次的排最上面。
// 不需要百分比長條（跟「常錯範圍」不同，那邊要看準確率高低；這裡單純列出出現次數，
// 數字本身已經夠直觀，加長條反而多餘）。
// 有記到正解／解說的題目（sendStatsReports() 這個功能上線後新錄的場次才有，見
// host.html 的 onAnswer()）可以點開看「正解是什麼、為什麼」，不用等下一次被考到同一題
// 才知道；舊資料沒有這幾個欄位的題目就只顯示標頭列，不能展開。同一題可能好幾場都錯，
// 正解/解說理論上每場都一樣，任一筆有值就補齊，避免因為第一次剛好是舊資料而整題都顯示不出來。
// 不設題數上限（以前砍在前 15 題，題庫一多就看不到其他錯題），改用固定高度的
// .stats-wrong-list 內部捲動裝下全部。
function _renderWrongQuestionsSection(sessions) {
  const counts = new Map();   // question text → {domain, count, correctAnswer, correctAnswerText, explanation}
  sessions.forEach((s) => {
    (s.wrongQuestions || []).forEach((w) => {
      const cur = counts.get(w.question) || {
        domain: w.domain, count: 0, correctAnswer: '', correctAnswerText: '', explanation: '',
      };
      cur.count++;
      if (!cur.correctAnswer && w.correctAnswer) cur.correctAnswer = w.correctAnswer;
      if (!cur.correctAnswerText && w.correctAnswerText) cur.correctAnswerText = w.correctAnswerText;
      if (!cur.explanation && w.explanation) cur.explanation = w.explanation;
      counts.set(w.question, cur);
    });
  });
  const rows = [...counts.entries()]
    .map(([question, v]) => ({ question, ...v }))
    .sort((a, b) => b.count - a.count);

  const wrap = document.createElement('div');
  wrap.className = 'stats-card';
  const title = document.createElement('div');
  title.className = 'stats-section-title'; title.textContent = '❌ 常錯題目';
  wrap.appendChild(title);
  if (!rows.length) {
    const hint = document.createElement('div');
    hint.className = 'stats-empty-hint'; hint.textContent = '目前沒有錯題紀錄，繼續保持！';
    wrap.appendChild(hint);
    return wrap;
  }
  const list = document.createElement('div');
  list.className = 'stats-wrong-list';
  rows.forEach((r) => {
    const hasDetail = !!(r.correctAnswer || r.correctAnswerText || r.explanation);
    const item = document.createElement('div');
    item.className = 'stats-wrong-item';

    const row = document.createElement('div');
    row.className = 'stats-wrong-row';
    const qEl = document.createElement('span');
    qEl.className = 'stats-wrong-q'; qEl.textContent = r.question;
    const domainEl = document.createElement('span');
    domainEl.className = 'stats-wrong-domain'; domainEl.textContent = r.domain || '(未分類)';
    const countEl = document.createElement('span');
    countEl.className = 'stats-wrong-count'; countEl.textContent = `錯 ${r.count} 次`;
    row.append(qEl, domainEl, countEl);

    if (hasDetail) {
      row.classList.add('clickable');
      const caret = document.createElement('span');
      caret.className = 'stats-wrong-caret'; caret.textContent = '▸';
      row.appendChild(caret);

      const detail = document.createElement('div');
      detail.className = 'stats-wrong-detail hidden';
      if (r.correctAnswer) {
        const ansEl = document.createElement('div');
        ansEl.className = 'stats-wrong-answer';
        ansEl.textContent = `✅ 正解：${r.correctAnswer}` + (r.correctAnswerText ? `．${r.correctAnswerText}` : '');
        detail.appendChild(ansEl);
      }
      if (r.explanation) {
        const expEl = document.createElement('div');
        expEl.textContent = r.explanation;
        detail.appendChild(expEl);
      }
      row.addEventListener('click', () => {
        const expanded = item.classList.toggle('expanded');
        detail.classList.toggle('hidden', !expanded);
        caret.textContent = expanded ? '▾' : '▸';
      });
      item.append(row, detail);
    } else {
      item.appendChild(row);
    }
    list.appendChild(item);
  });
  wrap.appendChild(list);
  return wrap;
}

// 「歷次表現」：逐場列出日期/題庫/正確率，讓使用者用肉眼看出趨勢——最新一場放最上面。
// 場次只會愈玩愈多，表格包在固定高度的 .stats-session-scroll 內部捲動，標頭不用做
// sticky（複雜度換不到什麼好處，固定高度捲動框本身已經夠用）。
function _renderSessionHistorySection(sessions) {
  const wrap = document.createElement('div');
  wrap.className = 'stats-card';
  const title = document.createElement('div');
  title.className = 'stats-section-title'; title.textContent = '📅 歷次表現';
  wrap.appendChild(title);

  const table = document.createElement('table');
  table.className = 'stats-session-table';
  const thead = document.createElement('tr');
  ['時間', '題庫', '正確率'].forEach((t) => {
    const th = document.createElement('th'); th.textContent = t; thead.appendChild(th);
  });
  table.appendChild(thead);

  [...sessions].reverse().forEach((s) => {
    const tr = document.createElement('tr');
    const tdTime = document.createElement('td');
    tdTime.textContent = new Date(s.ts).toLocaleString('zh-TW', { hour12: false });
    const tdBank = document.createElement('td');
    tdBank.textContent = s.bankName || s.bankFile || '—';
    const tdPct = document.createElement('td');
    const pct = s.totalAnswered ? Math.round((s.totalCorrect / s.totalAnswered) * 100) : 0;
    tdPct.textContent = `${pct}%（${s.totalCorrect}/${s.totalAnswered}）`;
    tr.append(tdTime, tdBank, tdPct);
    table.appendChild(tr);
  });
  const scroll = document.createElement('div');
  scroll.className = 'stats-session-scroll';
  scroll.appendChild(table);
  wrap.appendChild(scroll);
  return wrap;
}
