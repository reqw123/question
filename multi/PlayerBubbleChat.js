'use strict';

// ── PlayerBubbleChat ──────────────────────────────────────────────────────────
// 統一管理玩家頭像上方的即時互動 UI：
//   聊天泡泡 · Emoji · 打字指示器 · 漫畫風格 · 泡泡佇列
//
// 架構：
//   Bubble Manager  → 生命週期、佇列、優先權
//   Bubble Renderer → 依 type 建立 DOM 元素
//   Bubble Theme    → 四種視覺風格（default / comic / rounded / minimal）
//   Bubble Animation→ 進場 / 退場 CSS keyframe
//   Typing Indicator→ 獨立元素，優先權最低
//
// API（外部呼叫）：
//   showMessage(playerId, message)
//   showEmoji(playerId, emoji)
//   showTyping(playerId)
//   hideTyping(playerId)
//   remove(playerId)
//   update(playerId)
//   refresh()
//   setTheme('default'|'comic'|'rounded'|'minimal')
//   show(playerId, message)   ← backward-compat alias
//   topic          → 'quiz/chat'
//   topicTyping    → 'quiz/chat/typing'
//
// 完全移除此檔案不影響 MQTT / 題庫 / Live2D / MagicShotVFX / 分數系統。
const PlayerBubbleChat = (() => {

  // ── Topics ─────────────────────────────────────────────────────────────────
  const TOPIC        = 'quiz/chat';
  const TOPIC_TYPING = 'quiz/chat/typing';

  // ── Constants ──────────────────────────────────────────────────────────────
  const CHAT_MS   = 5000;   // 聊天泡泡顯示毫秒
  const EMOJI_MS  = 3000;   // Emoji 泡泡顯示毫秒
  const QUEUE_MAX = 2;      // 每位玩家最大佇列長度
  const MAX_LEN   = 40;     // 聊天文字最大字元

  // ── Bubble Theme ───────────────────────────────────────────────────────────
  const _themes = {
    // 深色光暈（預設）：融入遊戲 UI，青色邊框發光
    default: {
      bg:        'rgba(6,16,32,.93)',
      border:    '1.5px solid rgba(0,212,255,.65)',
      radius:    '10px',
      shadow:    '0 0 16px rgba(0,212,255,.28),0 3px 14px rgba(0,0,0,.75),inset 0 0 10px rgba(0,212,255,.07)',
      color:     '#dff4ff',
      tailColor: 'rgba(0,212,255,.8)',
      tailFill:  'rgba(6,16,32,.93)',
    },
    // 漫畫風：黑邊奶白底（淺色背景場合使用）
    comic: {
      bg:        '#fffef0',
      border:    '2.5px solid #111',
      radius:    '10px',
      shadow:    '3px 3px 0 #111',
      color:     '#111',
      tailColor: '#111',
      tailFill:  '#fffef0',
    },
    rounded: {
      bg:        'rgba(30,40,70,.96)',
      border:    '1px solid rgba(255,255,255,.18)',
      radius:    '22px',
      shadow:    '0 6px 24px rgba(0,0,0,.5)',
      color:     '#fff',
      tailColor: 'rgba(255,255,255,.18)',
      tailFill:  'rgba(30,40,70,.96)',
    },
    minimal: {
      bg:        'rgba(0,0,0,.72)',
      border:    '1px solid rgba(255,255,255,.12)',
      radius:    '8px',
      shadow:    '0 2px 8px rgba(0,0,0,.4)',
      color:     '#ddd',
      tailColor: 'rgba(255,255,255,.12)',
      tailFill:  'rgba(0,0,0,.72)',
    },
  };
  let _theme = 'default';

  // ── Per-player state ────────────────────────────────────────────────────────
  // { el, type, tidDismiss, queue:[], typingEl }
  const _state = {};

  // ── CSS injection (once) ───────────────────────────────────────────────────
  (() => {
    const s = document.createElement('style');
    s.textContent =
      // ── Appear: pop + bounce（漫畫彈跳感）
      '@keyframes _pbcIn{' +
        '0%{opacity:0;transform:translate(-50%,-72%) scale(.8)}' +
        '55%{opacity:1;transform:translate(-50%,-108%) scale(1.1)}' +
        '75%{transform:translate(-50%,-97%) scale(.97)}' +
        '100%{transform:translate(-50%,-100%) scale(1)}' +
      '}' +
      // ── Dismiss: fade + float up
      '@keyframes _pbcOut{' +
        '0%{opacity:1;transform:translate(-50%,-100%)}' +
        '100%{opacity:0;transform:translate(-50%,calc(-100% - 14px))}' +
      '}' +
      // ── Typing dots
      '@keyframes _pbcDot{' +
        '0%,80%,100%{opacity:.25;transform:scale(.7)}' +
        '40%{opacity:1;transform:scale(1)}' +
      '}' +
      // ── Bubble base
      '._pbc{' +
        'position:fixed;z-index:99999;pointer-events:none;' +
        'padding:7px 13px 7px 12px;box-sizing:border-box;' +
        'animation:_pbcIn .28s cubic-bezier(.34,1.56,.64,1) both;' +
        'max-width:230px;min-width:44px;' +
        'display:inline-block;word-break:break-word;' +
        'transition:left .13s ease,top .13s ease;' +
      '}' +
      // ── Emoji container
      '._pbc-emoji{font-size:2em;line-height:1;text-align:center;padding:2px 4px;}' +
      // ── Typing dots container
      '._pbc-typing{display:flex;align-items:center;gap:4px;padding:2px 4px;}' +
      // ── Single dot
      '._pbc-dot{' +
        'width:7px;height:7px;border-radius:50%;background:currentColor;' +
        'display:inline-block;' +
        'animation:_pbcDot 1.2s ease-in-out infinite;' +
      '}' +
      '._pbc-dot:nth-child(2){animation-delay:.2s}' +
      '._pbc-dot:nth-child(3){animation-delay:.4s}';
    document.head.appendChild(s);
  })();

  // ── Bubble Renderer ────────────────────────────────────────────────────────

  function _makeBubble() {
    const el = document.createElement('div');
    el.className = '_pbc';
    return el;
  }

  function _applyTheme(el) {
    const th  = _themes[_theme] || _themes.default;
    el.style.background   = th.bg;
    el.style.border       = th.border;
    el.style.borderRadius = th.radius;
    el.style.boxShadow    = th.shadow;
    el.style.color        = th.color;
  }

  // ── 玩家顏色 helper ─────────────────────────────────────────────────────────
  // 從 data-avid 元素向上找 .p-row，讀取其 border-left 計算色
  function _getPlayerColor(playerId) {
    const anchor = _findAnchor(playerId);
    if (!anchor) return null;
    const row = anchor.closest('[class*="p-row"]') || anchor.parentElement;
    if (!row) return null;
    return getComputedStyle(row).borderLeftColor || null;
  }

  // ── 角落射線放射 ─────────────────────────────────────────────────────────────
  // 泡泡出現時，四角各射出 3 道細光線；先伸長（180ms）再淡出（300ms）
  function _flashCornerRays(el, color) {
    requestAnimationFrame(() => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;

      const PAD = 4;
      const ns  = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      const W   = r.width  + PAD * 2;
      const H   = r.height + PAD * 2;
      svg.style.cssText =
        `position:fixed;top:${r.top - PAD}px;left:${r.left - PAD}px;` +
        `width:${W}px;height:${H}px;` +
        `pointer-events:none;overflow:visible;z-index:99998;` +
        `filter:drop-shadow(0 0 5px ${color});`;
      document.body.appendChild(svg);

      const RAY = 24;   // 最終射線長度 px
      const PI  = Math.PI;
      // 四角 × 三方向（沿對角外側 ±45°）
      const corners = [
        { x: 0, y: 0, angs: [-PI,     -PI * 3/4, -PI / 2] },   // 左上
        { x: W, y: 0, angs: [-PI / 2, -PI / 4,    0      ] },   // 右上
        { x: 0, y: H, angs: [ PI / 2,  PI * 3/4,  PI     ] },   // 左下
        { x: W, y: H, angs: [ 0,        PI / 4,   PI / 2 ] },   // 右下
      ];

      // 建立所有 line 元素（初始長度 0）
      const lines = [];
      corners.forEach(({ x, y, angs }) => {
        angs.forEach(a => {
          const ln = document.createElementNS(ns, 'line');
          ln.setAttribute('x1', x.toFixed(1));
          ln.setAttribute('y1', y.toFixed(1));
          ln.setAttribute('x2', x.toFixed(1));
          ln.setAttribute('y2', y.toFixed(1));
          ln.setAttribute('stroke',         color);
          ln.setAttribute('stroke-width',   '1.8');
          ln.setAttribute('stroke-linecap', 'round');
          svg.appendChild(ln);
          lines.push({ ln, x, y, a });
        });
      });

      const GROW_MS  = 180;
      const FADE_MS  = 320;
      const TOTAL_MS = GROW_MS + FADE_MS;
      const t0 = performance.now();

      (function tick() {
        const e = performance.now() - t0;
        if (e < GROW_MS) {
          // easeOut 伸長
          const p    = e / GROW_MS;
          const ease = 1 - (1 - p) * (1 - p);
          lines.forEach(({ ln, x, y, a }) => {
            ln.setAttribute('x2', (x + Math.cos(a) * RAY * ease).toFixed(1));
            ln.setAttribute('y2', (y + Math.sin(a) * RAY * ease).toFixed(1));
          });
          requestAnimationFrame(tick);
        } else if (e < TOTAL_MS) {
          // 淡出
          svg.style.opacity = (1 - (e - GROW_MS) / FADE_MS).toFixed(3);
          requestAnimationFrame(tick);
        } else {
          svg.remove();
        }
      })();
    });
  }

  // ── Score-row wrap animation ────────────────────────────────────────────────
  // 當玩家發送聊天/emoji 時，在其計分列外框描繪一圈發光邊框動畫
  // 三階段：描邊（draw）→ 光暈脈動（glow）→ 淡出（fade）
  function _flashRow(playerId) {
    const anchor = _findAnchor(playerId);
    if (!anchor) return;

    // 向上找含 'p-row' 的容器
    const target = anchor.closest('[class*="p-row"]') || anchor.parentElement;
    if (!target) return;

    const r = target.getBoundingClientRect();
    if (!r.width || !r.height) return;

    const col = getComputedStyle(target).borderLeftColor || 'rgba(0,212,255,.8)';

    const ns  = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    const PAD = 4;
    svg.style.cssText =
      `position:fixed;top:${r.top - PAD}px;left:${r.left - PAD}px;` +
      `width:${r.width + PAD * 2}px;height:${r.height + PAD * 2}px;` +
      `pointer-events:none;overflow:visible;z-index:99997;`;

    const W  = r.width  + PAD * 2;
    const H  = r.height + PAD * 2;
    const rx = 10;
    // 圓角矩形周長近似：四直邊 + 四圓弧
    const peri = Math.round(2 * (W - 2 * rx) + 2 * (H - 2 * rx) + 2 * Math.PI * rx);

    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('x',              '2');
    rect.setAttribute('y',              '2');
    rect.setAttribute('width',          String(W - 4));
    rect.setAttribute('height',         String(H - 4));
    rect.setAttribute('rx',             String(rx));
    rect.setAttribute('fill',           'none');
    rect.setAttribute('stroke',         col);
    rect.setAttribute('stroke-width',   '2.5');
    rect.setAttribute('stroke-linecap', 'round');
    rect.setAttribute('stroke-dasharray',  String(peri));
    rect.setAttribute('stroke-dashoffset', String(peri));
    svg.appendChild(rect);
    document.body.appendChild(svg);

    const DRAW_MS = 480;
    const HOLD_MS = 700;
    const FADE_MS = 480;
    const t0 = performance.now();

    (function tick() {
      const e = performance.now() - t0;

      if (e < DRAW_MS) {
        const p    = e / DRAW_MS;
        const ease = p < 0.5 ? 2 * p * p : -1 + (4 - 2 * p) * p;
        rect.setAttribute('stroke-dashoffset', String(Math.round(peri * (1 - ease))));
        requestAnimationFrame(tick);
      } else if (e < DRAW_MS + HOLD_MS) {
        rect.setAttribute('stroke-dashoffset', '0');
        const pulse = Math.sin(((e - DRAW_MS) / HOLD_MS) * Math.PI);
        rect.setAttribute('stroke-width', String((2.5 + pulse * 1.5).toFixed(2)));
        svg.style.filter = `drop-shadow(0 0 ${(4 + pulse * 10).toFixed(1)}px ${col})`;
        requestAnimationFrame(tick);
      } else if (e < DRAW_MS + HOLD_MS + FADE_MS) {
        const p = (e - DRAW_MS - HOLD_MS) / FADE_MS;
        svg.style.opacity = (1 - p).toFixed(3);
        requestAnimationFrame(tick);
      } else {
        svg.remove();
      }
    })();
  }

  function _renderMessage(text) {
    const el = _makeBubble();
    const body = document.createElement('div');
    body.style.cssText   = 'font-size:14px;font-weight:700;line-height:1.35;letter-spacing:.02em;';
    body.textContent     = String(text).slice(0, MAX_LEN);
    el.insertBefore(body, el.firstChild);   // before tail
    _applyTheme(el);
    return el;
  }

  function _renderEmoji(emoji) {
    const el = _makeBubble();
    const inner = document.createElement('div');
    inner.className   = '_pbc-emoji';
    inner.textContent = emoji;
    el.insertBefore(inner, el.firstChild);
    _applyTheme(el);
    return el;
  }

  function _renderTyping() {
    const el = _makeBubble();
    const dots = document.createElement('div');
    dots.className = '_pbc-typing';
    dots.innerHTML =
      '<span class="_pbc-dot"></span>' +
      '<span class="_pbc-dot"></span>' +
      '<span class="_pbc-dot"></span>';
    el.insertBefore(dots, el.firstChild);
    _applyTheme(el);
    return el;
  }

  // ── Anchor finder ──────────────────────────────────────────────────────────
  function _findAnchor(playerId) {
    const all = [...document.querySelectorAll(`[data-avid="${CSS.escape(playerId)}"]`)];
    let best = null;
    for (const a of all) {
      const r = a.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      if (r.top < 0 || r.bottom > window.innerHeight) continue;
      if (!best || r.top < best.getBoundingClientRect().top) best = a;
    }
    return best || all[0] || null;
  }

  // ── Placement ──────────────────────────────────────────────────────────────
  function _place(el, playerId) {
    const anc = _findAnchor(playerId);
    if (!anc) {
      // Fallback: top-left corner, no CSS animation (can't use translate-anchor trick)
      el.style.left      = '12px';
      el.style.top       = '64px';
      el.style.transform = 'translate(0,0)';
      el.style.animation = 'none';
      el.style.opacity   = '1';
      return;
    }
    const r = anc.getBoundingClientRect();
    el.style.left  = `${r.left + r.width / 2}px`;
    el.style.top   = `${r.top - 6}px`;
    el.style.transform = '';   // let CSS animation control transform
  }

  // ── Animation: dismiss ─────────────────────────────────────────────────────
  function _animateOut(el, onDone) {
    el.style.animation = '_pbcOut .3s ease forwards';
    setTimeout(() => { el.remove(); if (onDone) onDone(); }, 310);
  }

  // ── Bubble Manager ─────────────────────────────────────────────────────────
  function _st(playerId) {
    if (!_state[playerId])
      _state[playerId] = { el: null, type: null, tidDismiss: null, queue: [], typingEl: null };
    return _state[playerId];
  }

  const _prio = { chat: 3, emoji: 2, typing: 1 };

  // Show a bubble immediately, replacing any current one
  function _showNow(playerId, el, ms, type) {
    const st = _st(playerId);

    // Cancel + animate-out existing main bubble
    if (st.el) {
      clearTimeout(st.tidDismiss);
      _animateOut(st.el, null);
    }

    // Hide typing indicator when a chat/emoji bubble appears
    if (type !== 'typing' && st.typingEl) {
      _animateOut(st.typingEl, null);
      st.typingEl = null;
    }

    st.el   = el;
    st.type = type;

    // Position first (avoids one-frame flash at 0,0)
    _place(el, playerId);
    document.body.appendChild(el);

    // 角落射線 + 分數列發光邊框動畫
    if (type === 'chat' || type === 'emoji') {
      const col = _getPlayerColor(playerId) || (_themes[_theme] || _themes.default).tailColor;
      try { _flashCornerRays(el, col); } catch {}
      try { _flashRow(playerId); } catch {}
    }

    st.tidDismiss = setTimeout(() => {
      if (st.el !== el) return;           // was already replaced
      _animateOut(el, () => {
        if (st.el === el) { st.el = null; st.type = null; }
        _drainQueue(playerId);
      });
    }, ms);
  }

  // Pull next item from per-player queue
  function _drainQueue(playerId) {
    const st = _st(playerId);
    if (!st.queue.length) return;
    const next = st.queue.shift();
    _showNow(playerId, next.el, next.ms, next.type);
  }

  // Route a new bubble through priority / queue logic
  function _schedule(playerId, el, ms, type) {
    const st   = _st(playerId);
    const pNew = _prio[type]     || 0;
    const pCur = _prio[st.type]  || 0;

    if (!st.el || pNew >= pCur) {
      // Show immediately; drop queued items of equal-or-lower priority
      st.queue = st.queue.filter(q => (_prio[q.type] || 0) > pNew);
      _showNow(playerId, el, ms, type);
    } else if (st.queue.length < QUEUE_MAX) {
      st.queue.push({ el, ms, type });
    }
    // else: queue full, silently drop
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** 顯示聊天文字泡泡，5 秒後自動消除（可佇列最多 2 則）*/
  function showMessage(playerId, message) {
    _schedule(playerId, _renderMessage(message), CHAT_MS, 'chat');
  }

  /** 顯示 Emoji 泡泡，3 秒後自動消除（可佇列）*/
  function showEmoji(playerId, emoji) {
    _schedule(playerId, _renderEmoji(emoji), EMOJI_MS, 'emoji');
  }

  /** 顯示打字指示器（... 動畫）；有聊天/Emoji 時忽略 */
  function showTyping(playerId) {
    const st = _st(playerId);
    if (st.type === 'chat' || st.type === 'emoji') return;
    if (st.queue.some(q => q.type === 'chat' || q.type === 'emoji')) return;
    if (st.typingEl) return;

    const el = _renderTyping();
    st.typingEl = el;
    _place(el, playerId);
    document.body.appendChild(el);
  }

  /** 隱藏打字指示器 */
  function hideTyping(playerId) {
    const st = _st(playerId);
    if (!st.typingEl) return;
    _animateOut(st.typingEl, null);
    st.typingEl = null;
  }

  /** 立即移除指定玩家的所有泡泡並清空其佇列 */
  function remove(playerId) {
    const st = _state[playerId];
    if (!st) return;
    clearTimeout(st.tidDismiss);
    st.el?.remove();
    st.typingEl?.remove();
    delete _state[playerId];
  }

  /** 重新定位單一玩家的所有泡泡（計分板重繪後呼叫）*/
  function update(playerId) {
    const st = _state[playerId];
    if (!st) return;
    if (st.el)       _place(st.el,       playerId);
    if (st.typingEl) _place(st.typingEl, playerId);
  }

  /** 重新定位所有玩家的泡泡 */
  function refresh() { Object.keys(_state).forEach(update); }

  /** 切換泡泡視覺風格：'default' | 'comic' | 'rounded' | 'minimal' */
  function setTheme(name) { if (_themes[name]) _theme = name; }

  return {
    showMessage, showEmoji, showTyping, hideTyping,
    remove, update, refresh, setTheme,
    show:         showMessage,   // backward-compat
    topic:        TOPIC,
    topicTyping:  TOPIC_TYPING,
  };
})();
