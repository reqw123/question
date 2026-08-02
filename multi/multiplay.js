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
};

const MP_MEDALS        = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
const MP_PLAYER_COLORS = ['#00d4ff', '#ff6b6b', '#00ff88', '#ffd60a', '#ff9f1c', '#a855f7', '#f97316', '#06b6d4', '#84cc16', '#f472b6'];

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
