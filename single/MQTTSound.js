'use strict';

// ===== MQTT 音效模組設定（只需改這裡）=====
const MQTTS_CFG = {

  // ── 連線設定 ──────────────────────────────
  brokerIP:    '192.168.0.171', // Broker 的 IP 位址（與 ESP32 相同）
  wsPort:      9001,            // Broker 的 WebSocket 埠號（瀏覽器專用，非 1883）
  topic:       'quiz/sound',    // 發布給 ESP32 的 MQTT 主題
  initTimeout: 2000,            // 連線等待上限（毫秒），超過後遊戲照常進行

  // ── 連續答題門檻 ──────────────────────────
  streakCount: 3,               // 連續答對／答錯幾題後觸發循環音效

  // ── 答題中音效規則 ────────────────────────
  // 對應 SD 卡檔名：0001.mp3 / 0002.mp3 / 0003.mp3 / 0004.mp3
  rules: {
    correct:       'TRACK_1',  // 答對一題（連對未達門檻）→ 播放第 1 首
    wrong:         'TRACK_2',  // 答錯一題（連錯未達門檻）→ 播放第 2 首
    streakCorrect: 'TRACK_3',  // 連對達門檻 → 第 3 首播放一次
    streakWrong:   'TRACK_4',  // 連錯達門檻 → 第 4 首播放一次
  },

  // ── 結算音效規則 ──────────────────────────
  // 對應 SD 卡檔名：0005.mp3 / 0006.mp3
  finish: {
    passThreshold: 50,          // 通過門檻（%）：高於此值播 pass，否則播 fail
    pass:          'TRACK_6',   // 正確率 > 門檻 → 播放第 6 首（通過）
    fail:          'TRACK_5',   // 正確率 ≤ 門檻 → 播放第 5 首（未通過）
  },

};
// ==========================================

const mqttSound = (() => {
  let _client        = null;
  let _connected     = false;
  let _correctStreak = 0;
  let _wrongStreak   = 0;
  let _streakMode    = null;   // null | 'correct' | 'wrong'

  const _url         = `ws://${MQTTS_CFG.brokerIP}:${MQTTS_CFG.wsPort}`;
  const _statusTopic = `home/quiz_sound/status`;

  function _setStatus(state, text) {
    const el = document.getElementById('mqtt-status');
    if (!el) return;
    el.className = `s-${state}`;
    el.querySelector('#mqtt-status-text').textContent = text;
  }

  function _publish(payload) {
    if (!_client || !_connected) {
      console.log(`[MQTTSound] 未連線，略過 "${payload}"`);
      return;
    }
    _client.publish(MQTTS_CFG.topic, payload, { qos: 0 }, err => {
      if (err) console.warn('[MQTTSound] 發布失敗:', err);
      else     console.log(`[MQTTSound] ▶ ${MQTTS_CFG.topic} : ${payload}`);
    });
  }

  return {

    /** 初始化 MQTT 連線（非阻塞，失敗不影響遊戲） */
    async init() {
      if (typeof window.mqtt === 'undefined') {
        console.warn('[MQTTSound] mqtt.js 未載入，音效 MQTT 停用');
        return;
      }
      return new Promise(resolve => {
        const timer = setTimeout(() => {
          console.warn(`[MQTTSound] 連線逾時（${MQTTS_CFG.initTimeout}ms），遊戲繼續`);
          resolve();
        }, MQTTS_CFG.initTimeout);

        _client = window.mqtt.connect(_url, {
          clientId:        'quiz_sound_' + Math.random().toString(16).slice(2, 8),
          reconnectPeriod: 5000,
          keepalive:       30,
          clean:           true,
        });

        _client.on('connect', () => {
          clearTimeout(timer);
          _connected = true;
          _setStatus('broker', 'Broker 已連');
          console.log('[MQTTSound] ✓ Connected →', _url);
          // 訂閱 ESP32 上線通知
          _client.subscribe(_statusTopic);
          resolve();
        });

        _client.on('message', (topic, message) => {
          if (topic === _statusTopic) {
            const msg = message.toString();
            if      (msg === 'online')  _setStatus('esp32', 'ESP32 上線');
            else if (msg === 'offline') _setStatus('broker', 'ESP32 離線');
          }
        });

        _client.on('offline', () => {
          clearTimeout(timer);
          _connected = false;
          _setStatus('off', 'MQTT 離線');
          console.warn(`[MQTTSound] Broker 不可達 (${_url})`);
          resolve();
        });

        _client.on('error',      err  => { console.warn('[MQTTSound] 錯誤:', err.message ?? err); _setStatus('error', '連線失敗'); });
        _client.on('reconnect',  ()   => { console.log('[MQTTSound] 重新連線中...'); _setStatus('broker', '重新連線...'); });
        _client.on('disconnect', ()   => { _connected = false; _setStatus('off', 'MQTT 離線'); });
      });
    },

    /**
     * 每題作答後呼叫
     * @param {boolean} isCorrect - 是否答對（timeout 算答錯）
     */
    onResult(isCorrect) {
      let payload = null;

      if (isCorrect) {
        _wrongStreak = 0;
        _correctStreak++;

        if (_streakMode === 'wrong') {
          // 連錯 streak 被中斷 → 回到正常答對音效
          _streakMode = null;
          payload = MQTTS_CFG.rules.correct;
        } else if (_correctStreak >= MQTTS_CFG.streakCount) {
          // 達到或持續連對門檻 → 每題都重播 streakCorrect
          _streakMode = 'correct';
          payload = MQTTS_CFG.rules.streakCorrect;
        } else {
          // 未達門檻，正常答對音效
          payload = MQTTS_CFG.rules.correct;
        }
      } else {
        _correctStreak = 0;
        _wrongStreak++;

        if (_streakMode === 'correct') {
          // 連對 streak 被中斷 → 回到正常答錯音效
          _streakMode = null;
          payload = MQTTS_CFG.rules.wrong;
        } else if (_wrongStreak >= MQTTS_CFG.streakCount) {
          // 達到或持續連錯門檻 → 每題都重播 streakWrong
          _streakMode = 'wrong';
          payload = MQTTS_CFG.rules.streakWrong;
        } else {
          // 未達門檻，正常答錯音效
          payload = MQTTS_CFG.rules.wrong;
        }
      }

      if (payload) _publish(payload);
    },

    /**
     * 遊戲結算時呼叫
     * @param {number} correct - 答對題數
     * @param {number} total   - 總題數
     */
    onFinish(correct, total) {
      const rate = total > 0 ? (correct / total) * 100 : 0;
      const payload = rate > MQTTS_CFG.finish.passThreshold
        ? MQTTS_CFG.finish.pass
        : MQTTS_CFG.finish.fail;
      _publish(payload);
    },

    /** 遊戲重新開始時重置連勝/連敗計數 */
    resetStreak() {
      _correctStreak = 0;
      _wrongStreak   = 0;
      _streakMode    = null;
    },

    dispose() {
      if (_client) { _client.end(true); _client = null; }
      _connected = false;
    },
  };
})();
