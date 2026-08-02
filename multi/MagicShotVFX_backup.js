'use strict';

/**
 * MagicShotVFX — 角色朝選項發射魔法球的視覺特效模組
 *
 * 公開 API:
 *   MagicShotVFX.fireExplosion(letter)  ← 唯一實際被呼叫的攻擊特效（內部會呼叫 fire()）
 *   MagicShotVFX.updateStreak(playerId, correct) → 新連續正解數
 *   MagicShotVFX.getStreak(playerId)
 *   MagicShotVFX.init()  ← 掛載到 L2D.app.stage（也會自動延遲嘗試）
 *
 * 掛載方式：本模組啟動時自動每 500 ms 嘗試 init()，直到成功為止。
 * 完全不修改 live2d.js、MQTT、問答系統、計分邏輯。
 */
const MagicShotVFX = (() => {

  // ── 顏色常數 ──────────────────────────────────────────────────────────────
  const COL = {
    RED:    0xff3300,
    ORANGE: 0xff8800,
    CYAN:   0x06b6d4,
    GOLD:   0xffd60a,
    WHITE:  0xffffff,
    PURPLE: 0xa855f7,
  };

  // ── 模組狀態 ──────────────────────────────────────────────────────────────
  let _container = null;   // PIXI.Container — 所有 VFX 的父容器
  let _app       = null;   // PIXI.Application 參考
  let _ticker    = null;   // requestAnimationFrame handle
  let _lastTs    = 0;
  let _enabled   = true;   // 特效總開關（false = 靜默忽略所有 fire 呼叫）
  const _effects = [];     // 目前活躍的特效物件陣列
  const _streaks = {};     // { playerId: 連續正解數 }

  // ── easing ────────────────────────────────────────────────────────────────
  const easeIO  = t => t < .5 ? 2*t*t : -1 + (4 - 2*t)*t;
  const easeOut = t => 1 - (1-t)*(1-t);

  // ── ScreenShake ───────────────────────────────────────────────────────────
  const ScreenShake = {
    _on: false, _elapsed: 0, _dur: 0, _amp: 0,
    shake({ amplitude = 5, duration = 150 }) {
      this._amp = amplitude; this._dur = duration; this._elapsed = 0; this._on = true;
    },
    update(dt) {
      if (!this._on || !_app) return;
      this._elapsed += dt;
      if (this._elapsed >= this._dur) {
        this._on = false; _app.stage.position.set(0, 0); return;
      }
      const k = this._amp * (1 - this._elapsed / this._dur);
      _app.stage.x = (Math.random() * 2 - 1) * k;
      _app.stage.y = (Math.random() * 2 - 1) * k;
    },
  };

  // ── Trail helper ──────────────────────────────────────────────────────────
  function _drawTrail(g, trail, baseR, color) {
    for (let i = 0; i < trail.length; i++) {
      const { x, y } = trail[i];
      const frac = (i + 1) / trail.length;
      const r = baseR * frac * 0.62;
      if (r < 0.4) continue;
      g.beginFill(color, frac * 0.52);
      g.drawCircle(x, y, r);
      g.endFill();
    }
  }

  // ── MagicOrb ──────────────────────────────────────────────────────────────
  class MagicOrb {
    constructor(fx, fy, tx, ty, { color = COL.PURPLE, radius = 9, ft = null } = {}) {
      this.fx = fx; this.fy = fy; this.tx = tx; this.ty = ty;
      this.x = fx; this.y = fy;
      this.color = color;
      this.radius = radius;
      this.ft = ft || (500 + Math.random() * 300);   // flight time ms
      this.elapsed = 0;
      this.done = false;
      this.trail = [];
      this.g = new PIXI.Graphics();
      this.g.blendMode = PIXI.BLEND_MODES.ADD;
      _container.addChild(this.g);
    }

    update(dt) {
      this.elapsed = Math.min(this.elapsed + dt, this.ft);
      const t  = this.elapsed / this.ft;
      const et = easeIO(t);
      this.x = this.fx + (this.tx - this.fx) * et;
      this.y = this.fy + (this.ty - this.fy) * et;
      this.trail.push({ x: this.x, y: this.y });
      if (this.trail.length > 18) this.trail.shift();
      if (t >= 1) this.done = true;
      this._draw();
    }

    _draw() {
      const g = this.g; g.clear();
      _drawTrail(g, this.trail, this.radius, this.color);
      if (!this.done) {
        g.beginFill(this.color, 0.14); g.drawCircle(this.x, this.y, this.radius * 3.0); g.endFill();
        g.beginFill(this.color, 0.85); g.drawCircle(this.x, this.y, this.radius);       g.endFill();
        g.beginFill(COL.ORANGE, 0.70); g.drawCircle(this.x, this.y, this.radius * 0.6); g.endFill();
        g.beginFill(COL.GOLD,   0.60); g.drawCircle(this.x, this.y, this.radius * 0.3); g.endFill();
      }
    }

    destroy() { this.g.clear(); this.g.parent?.removeChild(this.g); this.g.destroy(); }
  }

  // ── MagicExplosion ────────────────────────────────────────────────────────
  class MagicExplosion {
    constructor(x, y, { color = COL.PURPLE, size = 28, type = 'normal' } = {}) {
      this.x = x; this.y = y; this.color = color; this.size = size;
      this.dur = type === 'laser' ? 680 : type === 'ultimate' ? 1100 : 460;
      this.elapsed = 0; this.done = false;
      const n = type === 'ultimate' ? 28 : type === 'laser' ? 18 : 11;
      this.pts = Array.from({ length: n }, (_, i) => {
        const a = (i / n) * Math.PI * 2 + Math.random() * 0.45;
        const s = (40 + Math.random() * 85) * (size / 32);
        return {
          x, y,
          vx: Math.cos(a) * s, vy: Math.sin(a) * s,
          r: 2.2 + Math.random() * 4.2,
          col: Math.random() < 0.28 ? COL.WHITE : color,
          grav: 55 + Math.random() * 50,
        };
      });
      this.g = new PIXI.Graphics();
      this.g.blendMode = PIXI.BLEND_MODES.ADD;
      _container.addChild(this.g);
    }

    update(dt) {
      this.elapsed += dt;
      const p  = Math.min(1, this.elapsed / this.dur);
      const ds = dt / 1000;
      const ts = this.elapsed / 1000;
      for (const pt of this.pts) {
        pt.x += pt.vx * ds;
        pt.y += pt.vy * ds + pt.grav * ts * ds;
      }
      if (p >= 1) this.done = true;
      this._draw(p);
    }

    _draw(p) {
      const g = this.g; g.clear();
      // Shockwave ring
      const sw = this.size * 3.0 * easeOut(p);
      const sa = (1 - p) * 0.82;
      if (sa > 0.01) {
        g.lineStyle(2.5, this.color, sa);    g.drawCircle(this.x, this.y, sw);
        g.lineStyle(1.2, COL.WHITE,  sa*.3); g.drawCircle(this.x, this.y, sw * .65);
        g.lineStyle(0);
      }
      // Particles
      const pa = Math.max(0, 1 - p * 1.45);
      if (pa > 0) {
        for (const pt of this.pts) {
          g.beginFill(pt.col, pa);
          g.drawCircle(pt.x, pt.y, pt.r * (1 - p * .4));
          g.endFill();
        }
      }
      // Initial flash (first 18% of lifetime)
      const fp = Math.min(1, this.elapsed / (this.dur * .18));
      if (fp < 1) {
        const fa = 1 - fp;
        g.beginFill(COL.WHITE,    fa * .52); g.drawCircle(this.x, this.y, this.size * fa);       g.endFill();
        g.beginFill(this.color,   fa * .36); g.drawCircle(this.x, this.y, this.size * 1.5 * fa); g.endFill();
      }
    }

    destroy() { this.g.clear(); this.g.parent?.removeChild(this.g); this.g.destroy(); }
  }

  // ── OptionGlow ────────────────────────────────────────────────────────────
  class OptionGlow {
    constructor(x, y, w, h, color) {
      this.x = x; this.y = y; this.w = w; this.h = h; this.color = color;
      this.elapsed = 0; this.dur = 520; this.done = false;
      this.g = new PIXI.Graphics();
      this.g.blendMode = PIXI.BLEND_MODES.ADD;
      _container.addChild(this.g);
    }
    update(dt) {
      this.elapsed += dt;
      const t = Math.min(1, this.elapsed / this.dur);
      const a = Math.sin(t * Math.PI) * 0.42;
      const g = this.g; g.clear();
      if (a > 0.01) { g.beginFill(this.color, a); g.drawRoundedRect(this.x, this.y, this.w, this.h, 8); g.endFill(); }
      if (t >= 1) this.done = true;
    }
    destroy() { this.g.clear(); this.g.parent?.removeChild(this.g); this.g.destroy(); }
  }

  // ── LaserBeam ─────────────────────────────────────────────────────────────
  class LaserBeam {
    constructor(fx, fy, tx, ty, color = COL.CYAN) {
      this.fx = fx; this.fy = fy; this.tx = tx; this.ty = ty; this.color = color;
      this.elapsed = 0; this.dur = 370; this.done = false;
      this.g = new PIXI.Graphics();
      this.g.blendMode = PIXI.BLEND_MODES.ADD;
      _container.addChild(this.g);
    }
    update(dt) {
      this.elapsed += dt;
      const t = Math.min(1, this.elapsed / this.dur);
      const g = this.g; g.clear();
      if (t < 0.22) {
        const ct = t / 0.22;
        g.beginFill(this.color, ct * .72); g.drawCircle(this.fx, this.fy, 26 * ct); g.endFill();
        g.beginFill(COL.WHITE,  ct * .45); g.drawCircle(this.fx, this.fy, 12 * ct); g.endFill();
      } else {
        const bt  = Math.min(1, (t - 0.22) / 0.48);
        const efa = t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1;
        const ex  = this.fx + (this.tx - this.fx) * bt;
        const ey  = this.fy + (this.ty - this.fy) * bt;
        g.lineStyle(16, this.color, efa * .26); g.moveTo(this.fx, this.fy); g.lineTo(ex, ey);
        g.lineStyle(4,  this.color, efa * .9);  g.moveTo(this.fx, this.fy); g.lineTo(ex, ey);
        g.lineStyle(1.5, COL.WHITE, efa * .65); g.moveTo(this.fx, this.fy); g.lineTo(ex, ey);
        g.lineStyle(0);
        if (bt >= 1) { g.beginFill(COL.WHITE, efa * .52); g.drawCircle(this.tx, this.ty, 10); g.endFill(); }
      }
      if (t >= 1) this.done = true;
    }
    destroy() { this.g.clear(); this.g.parent?.removeChild(this.g); this.g.destroy(); }
  }

  // ── 動畫主迴圈 ────────────────────────────────────────────────────────────
  function _tick(ts) {
    const dt = _lastTs ? Math.min(ts - _lastTs, 80) : 16;
    _lastTs = ts;
    ScreenShake.update(dt);
    for (let i = _effects.length - 1; i >= 0; i--) {
      _effects[i].update(dt);
      if (_effects[i].done) { _effects[i].destroy(); _effects.splice(i, 1); }
    }
    if (_effects.length > 0 || ScreenShake._on) {
      _ticker = requestAnimationFrame(_tick);
    } else {
      _ticker = null; _lastTs = 0;
      if (_app) _app.stage.position.set(0, 0);
    }
  }

  function _startTick() {
    if (!_ticker) { _lastTs = 0; _ticker = requestAnimationFrame(_tick); }
  }

  // ── 輔助函式 ──────────────────────────────────────────────────────────────
  /** 取得選項元素的畫面中心與邊界（相容 host 的 opt-X 與 player 的 popt-X）*/
  function _optRect(letter) {
    const el = document.getElementById('opt-' + letter) || document.getElementById('popt-' + letter);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, x: r.left, y: r.top, w: r.width, h: r.height };
  }

  /**
   * 推算角色的上半身位置（PIXI 座標 ≡ CSS 邏輯像素，autoDensity:true 已對齊）
   * 優先取 _c2（1024100，有 Skill 動作），其次 _c1，最後用螢幕右側備用點
   */
  function _charOrigin() {
    if (typeof L2D !== 'undefined') {
      for (const sk of [L2D._c2, L2D._c1]) {
        if (sk && sk.ready && sk.model && sk._mw !== undefined) {
          const m  = sk.model;
          const θ  = m.rotation || 0;
          const cx = m.x + (sk._mw / 2) * Math.cos(θ) - (sk._mh / 2) * Math.sin(θ);
          const cy = m.y + (sk._mw / 2) * Math.sin(θ) + (sk._mh / 2) * Math.cos(θ);
          return { x: cx, y: cy - sk._mh * 0.22 };
        }
      }
    }
    return { x: window.innerWidth * 0.82, y: window.innerHeight * 0.45 };
  }

  /** 依連擊數決定魔法球／爆炸特效顏色 */
  function _exColor(streak) {
    if (streak >= 10) return COL.GOLD;
    if (streak >= 5)  return COL.CYAN;
    return streak >= 3 ? COL.ORANGE : COL.RED;
  }

  /**
   * 觸發 Live2D 動作
   * skill_01 → 'skill'，skill_02 → 'skill2'，excite_01 → 'excite'（別名表已定義）
   * 若 _c1 沒有該動作，_go() 會自然跳過
   */
  function _l2dMotion(streak) {
    try {
      if (typeof L2D === 'undefined') return;
      L2D.play(streak >= 10 ? 'excite' : streak >= 5 ? 'skill2' : 'skill');
    } catch {}
  }

  // ── fire ──────────────────────────────────────────────────────────────────
  /**
   * 主要 API：從 (fromX, fromY) 朝 (toX, toY) 發射特效
   * @param {object} opts
   * @param {number} opts.fromX
   * @param {number} opts.fromY
   * @param {number} opts.toX
   * @param {number} opts.toY
   * @param {string} [opts.letter]   選項字母 A/B/C/D，用於選項光暈
   * @param {number} [opts.streak=1] 連續正解數，決定特效等級
   */
  function fire({ fromX, fromY, toX, toY, letter = null, streak = 1 } = {}) {
    if (!_container || !_enabled) return;

    const type    = streak >= 10 ? 'laser' : streak >= 5 ? 'double' : streak >= 3 ? 'fireball' : 'orb';
    const exColor = _exColor(streak);
    const size    = streak >= 10 ? 56 : streak >= 5 ? 40 : streak >= 3 ? 30 : 20;

    _l2dMotion(streak);

    const _optGlow = () => {
      if (!letter) return;
      const r = _optRect(letter);
      if (r) _effects.push(new OptionGlow(r.x, r.y, r.w, r.h, exColor));
    };

    if (type === 'laser') {
      // 10× 連擊：雷射光束 + 強震動
      _effects.push(new LaserBeam(fromX, fromY, toX, toY, COL.CYAN));
      setTimeout(() => {
        _effects.push(new MagicExplosion(toX, toY, { color: exColor, size, type: 'laser' }));
        ScreenShake.shake({ amplitude: 12, duration: 270 });
        _optGlow();
        _startTick();
      }, 210);

    } else if (type === 'double') {
      // 5× 連擊：雙魔法球
      const offsets = [-13, 13];
      offsets.forEach((dy, i) => {
        const col = i === 0 ? COL.CYAN : COL.PURPLE;
        setTimeout(() => {
          const orb = new MagicOrb(fromX, fromY + dy, toX, toY + dy, { color: col, radius: 11 });
          _effects.push(orb);
          setTimeout(() => {
            _effects.push(new MagicExplosion(toX, toY + dy, { color: col, size: size * .75 }));
            if (i === 1) { ScreenShake.shake({ amplitude: 8, duration: 190 }); _optGlow(); }
            _startTick();
          }, orb.ft);
          _startTick();
        }, i * 78);
      });

    } else {
      // 1–4×：單顆魔法球（3× 升級為 fireball）
      const color  = _exColor(streak);
      const radius = type === 'fireball' ? 18 : 14;
      const orb    = new MagicOrb(fromX, fromY, toX, toY, { color, radius });
      _effects.push(orb);
      setTimeout(() => {
        _effects.push(new MagicExplosion(toX, toY, { color: exColor, size }));
        ScreenShake.shake({ amplitude: type === 'fireball' ? 6 : 4, duration: 145 });
        _optGlow();
        _startTick();
      }, orb.ft);
    }

    _startTick();
  }

  function fireExplosion(letter) {
    if (!_container || !_enabled) return;
    const opt = _optRect(letter);
    if (!opt) return;
    const orig = _charOrigin();
    const fx = orig.x, fy = orig.y, tx = opt.cx, ty = opt.cy;

    // L2D 詠唱動作（手勢由 L2DGesturePlayer 統一管理，不在此 hook coreModel）
    try { if (typeof L2D !== 'undefined') L2D.play('skill2'); } catch {}

    // 原本的 combo 魔法球特效（四段）
    const stages = [1, 3, 5, 10];
    stages.forEach((streak, i) => {
      setTimeout(() => {
        fire({ fromX: fx, fromY: fy, toX: tx, toY: ty, letter, streak });
      }, i * 280);
    });

    _startTick();

    // L2D 魔力耗盡
    setTimeout(() => {
      try { if (typeof L2D !== 'undefined') L2D.play('cry'); } catch {}
    }, 3100);
  }

  // ── 連擊追蹤 ──────────────────────────────────────────────────────────────
  function updateStreak(id, correct) {
    if (!correct) { _streaks[id] = 0; return 0; }
    _streaks[id] = (_streaks[id] || 0) + 1;
    return _streaks[id];
  }
  function getStreak(id) { return _streaks[id] || 0; }

  // ── 初始化 ────────────────────────────────────────────────────────────────
  /**
   * 掛載 VFX 容器到 L2D.app.stage。
   * @returns {boolean} 成功回傳 true，L2D 尚未就緒回傳 false
   */
  function init() {
    if (_container) return true;
    if (typeof PIXI === 'undefined' || typeof L2D === 'undefined' || !L2D.app) return false;
    _app       = L2D.app;
    _container = new PIXI.Container();
    _app.stage.addChild(_container);
    return true;
  }

  // 自動延遲初始化（每 500 ms 重試，直到成功）
  (function _lazyInit() {
    if (!init()) setTimeout(_lazyInit, 500);
  })();

  // ── 公開介面 ──────────────────────────────────────────────────────────────
  return {
    get container() { return _container; },
    fireExplosion,
    init,
    updateStreak,
    getStreak,
    ScreenShake,
    // 特效總開關 — setEnabled(false) 靜默跳過所有攻擊特效，不影響已在播放的效果
    setEnabled(v) { _enabled = !!v; },
    isEnabled()   { return _enabled; },
  };
})();
