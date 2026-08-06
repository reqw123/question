'use strict';

// ── DanmakuSystem ─────────────────────────────────────────────────────────────
// 彈幕系統：文字從右向左橫向捲動，4 個車道防止重疊
// API: receive(mqttData)
//      isEnabled() / setEnabled(bool)
//      setSafeArea({ top, bottom, left, right })  topic
const DanmakuSystem = (() => {
  const TOPIC     = MP_TOPICS.DANMAKU;
  const SPEED     = 120;     // px/s
  const LANES     = 4;
  const MAX_ITEMS = 30;
  const MAX_CHARS = 30;

  let _enabled   = true;
  let _container = null;
  let _colorIdx  = 0;

  // 每個車道下次可發射的時間戳
  const _laneAt = new Array(LANES).fill(0);

  // 跟 multiplay.js 的 MP_PLAYER_COLORS 共用同一份玩家識別色，避免兩份調色盤不同步
  const _palette = MP_PLAYER_COLORS;

  // 安全區域（避開 UI 元件）
  const _safe = { top: 60, bottom: 80, left: 0, right: 0 };

  // ── 顏色工具：hex → 'r,g,b' 字串（供 CSS rgba() 使用）
  function _hexToRgb(hex) {
    const c = hex.replace('#', '');
    return `${parseInt(c.slice(0,2),16)},${parseInt(c.slice(2,4),16)},${parseInt(c.slice(4,6),16)}`;
  }

  // 注入樣式（僅一次）
  const _s = document.createElement('style');
  _s.textContent =
    '#_dmk{position:fixed;inset:0;pointer-events:none;z-index:300;overflow:hidden;}' +

    // 滑動 + 進場淡入 + 出場淡出
    '@keyframes _dmkSlide{' +
      '0%  {transform:translateX(0);opacity:0}' +
      '5%  {opacity:1}' +
      '85% {opacity:1}' +
      '100%{transform:translateX(var(--_de));opacity:0}' +
    '}' +

    // 彈幕主體：漸層背景 + 色光邊框 + 外發光
    '._di{' +
      'position:absolute;white-space:nowrap;pointer-events:none;' +
      'display:inline-flex;align-items:center;gap:7px;' +
      'padding:5px 18px 5px 12px;border-radius:100px;' +
      'font-size:21px;font-weight:700;color:#fff;' +
      'border:1.5px solid var(--_dc);' +
      'background:linear-gradient(120deg,rgba(var(--_drgb),.22) 0%,rgba(0,0,0,.65) 100%);' +
      'box-shadow:0 0 16px rgba(var(--_drgb),.38),0 2px 6px rgba(0,0,0,.7),' +
                 'inset 0 0 12px rgba(var(--_drgb),.1);' +
      'text-shadow:0 0 10px var(--_dc),0 1px 5px rgba(0,0,0,.95);' +
    '}' +

    // 名字標籤：彩色底色小徽章
    '._di-name{' +
      'font-size:.68em;font-weight:800;letter-spacing:.06em;' +
      'color:var(--_dc);' +
      'background:rgba(var(--_drgb),.28);' +
      'border:1px solid rgba(var(--_drgb),.5);' +
      'border-radius:6px;padding:1px 7px;' +
      'text-shadow:none;' +
    '}' +

    // 訊息文字
    '._di-msg{letter-spacing:.03em;}';
  document.head.appendChild(_s);

  function _ensure() {
    if (_container) return;
    _container = document.createElement('div');
    _container.id = '_dmk';
    document.body.appendChild(_container);
  }

  function _fire(text, player, color) {
    if (!_enabled) return;
    const t = String(text || '').trim();
    if (!t) return;

    _ensure();
    if (_container.children.length >= MAX_ITEMS) _container.firstChild?.remove();

    const truncated = t.length > MAX_CHARS ? t.slice(0, MAX_CHARS) + '…' : t;
    const label     = player ? `${player}: ${truncated}` : truncated;

    // 選最早空閒的車道
    let lane = 0;
    for (let i = 1; i < LANES; i++) {
      if (_laneAt[i] < _laneAt[lane]) lane = i;
    }

    const safeH = window.innerHeight - _safe.top - _safe.bottom;
    const laneH = safeH / LANES;
    const topPx = _safe.top + lane * laneH + (laneH - 22) / 2;

    const col = color || _palette[_colorIdx++ % _palette.length];

    const el = document.createElement('div');
    el.className = '_di';
    el.style.top  = Math.round(topPx) + 'px';
    el.style.left = (window.innerWidth + _safe.right) + 'px';
    // CSS 變數：主色 + RGB 分量（供漸層 / 發光使用）
    el.style.setProperty('--_dc',   col);
    el.style.setProperty('--_drgb', _hexToRgb(col));

    // 名字徽章 + 訊息文字分開渲染
    if (player) {
      const nameEl = document.createElement('span');
      nameEl.className   = '_di-name';
      nameEl.textContent = player;
      el.appendChild(nameEl);
    }
    const msgEl = document.createElement('span');
    msgEl.className   = '_di-msg';
    msgEl.textContent = truncated;
    el.appendChild(msgEl);

    _container.appendChild(el);

    // 量測寬度以精確計算時間；速度加 ±10% 隨機擾動
    const elW      = el.offsetWidth;
    const travel   = window.innerWidth + elW + _safe.right;
    const speed    = SPEED * (0.92 + Math.random() * 0.16);
    const duration = travel / speed;
    el.style.setProperty('--_de', `-${travel}px`);
    el.style.animation = `_dmkSlide ${duration.toFixed(2)}s linear both`;

    // 標記車道再次空閒的時間（文字尾部離開起始點）
    _laneAt[lane] = Date.now() + (elW / SPEED) * 1000 + 150;

    el.addEventListener('animationend', () => el.remove(), { once: true });
  }

  return {
    // 收到 MQTT 彈幕訊息時呼叫
    // payload: { player, text, color? }
    receive({ player, text, color } = {}) {
      _fire(text, player, color);
    },

    // 設定安全區域（呼叫一次即可，不需重複設定）
    setSafeArea(s) { Object.assign(_safe, s); },

    isEnabled() { return _enabled; },
    setEnabled(v) { _enabled = !!v; },

    topic: TOPIC,
  };
})();
