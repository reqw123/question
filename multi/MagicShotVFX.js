'use strict';

/**
 * MagicShotVFX — 角色朝選項發射魔法球的視覺特效模組
 *
 * 公開 API:
 *   MagicShotVFX.fire({ fromX, fromY, toX, toY, letter, streak })
 *   MagicShotVFX.fireAtLetter(letter, streak)  ← 自動取角色位置
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

  // ── MagicCircle（惠惠蓄力魔法陣）────────────────────────────────────────
  class MagicCircle {
    constructor(x, y, { color = COL.RED, onComplete = null, dur = 1300 } = {}) {
      this.x = x; this.y = y; this.color = color;
      this.onComplete = onComplete;
      this.elapsed = 0; this.dur = dur; this.done = false;
      this.rot = 0;
      this.orbitPts = Array.from({ length: 8 }, (_, i) => ({
        angle: (i / 8) * Math.PI * 2,
        speed: 0.038 + Math.random() * 0.018,
        r: 4.5 + Math.random() * 3,
      }));
      this.g = new PIXI.Graphics();
      this.g.blendMode = PIXI.BLEND_MODES.ADD;
      _container.addChild(this.g);
    }
    update(dt) {
      this.elapsed += dt;
      this.rot += dt * 0.0022;
      const p = Math.min(1, this.elapsed / this.dur);
      for (const pt of this.orbitPts) pt.angle += pt.speed * (dt / 16);
      if (p >= 1 && !this.done) { this.done = true; if (this.onComplete) this.onComplete(); }
      this._draw(p);
    }
    _draw(p) {
      const g = this.g; g.clear();
      const outerR = 100 * easeOut(p);
      const starR  =  62 * easeOut(p);
      const baseA  = p < 0.08 ? p / 0.08 : p > 0.88 ? 1 - (p - 0.88) / 0.12 : 1;
      const pulse  = 0.72 + Math.sin(this.elapsed * 0.009) * 0.28;

      // 外環
      g.lineStyle(2.4, this.color, baseA * pulse * 0.92); g.drawCircle(this.x, this.y, outerR); g.lineStyle(0);
      // 中環（反向轉）
      g.lineStyle(1.2, COL.GOLD,  baseA * pulse * 0.58); g.drawCircle(this.x, this.y, starR * 0.92); g.lineStyle(0);

      // 六芒星：兩個等邊三角形，一正一逆轉
      const _tri = (r, rot, col, lw, a) => {
        g.lineStyle(lw, col, a);
        const pts = [0, 1, 2].map(i => [
          this.x + Math.cos(rot + (i / 3) * Math.PI * 2) * r,
          this.y + Math.sin(rot + (i / 3) * Math.PI * 2) * r,
        ]);
        g.moveTo(pts[0][0], pts[0][1]);
        g.lineTo(pts[1][0], pts[1][1]);
        g.lineTo(pts[2][0], pts[2][1]);
        g.closePath();
        g.lineStyle(0);
      };
      _tri(starR,  this.rot,         this.color, 2.0, baseA * pulse * 0.90);
      _tri(starR, -this.rot * 0.70,  COL.GOLD,   1.6, baseA * pulse * 0.72);

      // 外環 6 符文點
      for (let i = 0; i < 6; i++) {
        const a = this.rot + (i / 6) * Math.PI * 2;
        g.beginFill(this.color, baseA * 0.88);
        g.drawCircle(this.x + Math.cos(a) * outerR, this.y + Math.sin(a) * outerR, 3.8);
        g.endFill();
      }

      // 六芒星 6 頂點光點（兩三角各 3 個）
      for (let i = 0; i < 3; i++) {
        const a1 =  this.rot        + (i / 3) * Math.PI * 2;
        const a2 = -this.rot * 0.70 + (i / 3) * Math.PI * 2;
        g.beginFill(this.color, baseA * 0.84); g.drawCircle(this.x + Math.cos(a1) * starR, this.y + Math.sin(a1) * starR, 4.5); g.endFill();
        g.beginFill(COL.GOLD,   baseA * 0.70); g.drawCircle(this.x + Math.cos(a2) * starR, this.y + Math.sin(a2) * starR, 3.5); g.endFill();
      }

      // 軌道能量粒子（隨蓄力縮近中心）
      const orbitR = outerR * (1 - p * 0.52);
      for (const pt of this.orbitPts) {
        g.beginFill(COL.ORANGE, baseA * 0.82);
        g.drawCircle(this.x + Math.cos(pt.angle) * orbitR, this.y + Math.sin(pt.angle) * orbitR, pt.r * (1 - p * 0.45));
        g.endFill();
      }

      // 中心蓄力光核
      if (p > 0.1) {
        const cr = 18 * p;
        g.beginFill(COL.GOLD,  baseA * p * 0.52); g.drawCircle(this.x, this.y, cr * 2.2); g.endFill();
        g.beginFill(COL.WHITE, baseA * p * 0.42); g.drawCircle(this.x, this.y, cr);       g.endFill();
      }
    }
    destroy() { this.g.clear(); this.g.parent?.removeChild(this.g); this.g.destroy(); }
  }

  // ── EnergyAbsorb（粒子向中心吸入）─────────────────────────────────────
  class EnergyAbsorb {
    constructor(tx, ty) {
      this.tx = tx; this.ty = ty;
      this.elapsed = 0; this.dur = 2600; this.done = false;
      this.pts = Array.from({ length: 80 }, () => {
        const sw = window.innerWidth, sh = window.innerHeight;
        return {
          sx: Math.random() * sw, sy: Math.random() * sh,
          col: [COL.RED, COL.ORANGE, COL.GOLD, COL.WHITE][Math.floor(Math.random() * 4)],
          r: 2.5 + Math.random() * 4, delay: Math.random() * 1000,
        };
      });
      this.g = new PIXI.Graphics();
      this.g.blendMode = PIXI.BLEND_MODES.ADD;
      _container.addChild(this.g);
    }
    update(dt) {
      this.elapsed += dt;
      if (this.elapsed >= this.dur) this.done = true;
      this._draw();
    }
    _draw() {
      const g = this.g; g.clear();
      for (const pt of this.pts) {
        const e = this.elapsed - pt.delay; if (e <= 0) continue;
        const avail = this.dur - pt.delay;
        const t  = Math.min(1, e / avail);
        const et = t * t * t; // easeIn — 靠近中心時加速
        const x  = pt.sx + (this.tx - pt.sx) * et;
        const y  = pt.sy + (this.ty - pt.sy) * et;
        const a  = t < 0.92 ? 0.78 : (1 - t) / 0.08 * 0.78;
        const r  = pt.r * (1 - t * 0.75);
        if (a > 0.01 && r > 0.2) {
          g.beginFill(pt.col, a); g.drawCircle(x, y, r); g.endFill();
        }
      }
    }
    destroy() { this.g.clear(); this.g.parent?.removeChild(this.g); this.g.destroy(); }
  }

  // ── FireCore（巨大火球本體，多層脈動）───────────────────────────────────
  class FireCore {
    constructor(x, y) {
      this.x = x; this.y = y;
      this.elapsed = 0; this.dur = 800; this.done = false;
      this.g = new PIXI.Graphics();
      this.g.blendMode = PIXI.BLEND_MODES.ADD;
      _container.addChild(this.g);
    }
    update(dt) {
      this.elapsed += dt;
      if (this.elapsed >= this.dur) this.done = true;
      this._draw();
    }
    _draw() {
      const g = this.g; g.clear();
      const p = Math.min(1, this.elapsed / this.dur);
      const grow = easeOut(p);
      const t = this.elapsed;
      const p1 = 0.78 + Math.sin(t * 0.016) * 0.22;
      const p2 = 0.78 + Math.sin(t * 0.013 + 1.0) * 0.22;
      const p3 = 0.78 + Math.sin(t * 0.011 + 2.1) * 0.22;
      g.beginFill(COL.RED,    0.42 * p); g.drawCircle(this.x, this.y, 140 * grow * p3); g.endFill();
      g.beginFill(COL.ORANGE, 0.58 * p); g.drawCircle(this.x, this.y, 95  * grow * p2); g.endFill();
      g.beginFill(COL.GOLD,   0.74 * p); g.drawCircle(this.x, this.y, 58  * grow * p1); g.endFill();
      g.beginFill(COL.WHITE,  0.92 * p); g.drawCircle(this.x, this.y, 28  * grow);      g.endFill();
    }
    destroy() { this.g.clear(); this.g.parent?.removeChild(this.g); this.g.destroy(); }
  }

  // ── ExplosionBlast（500-800px 毀天滅地爆炸核心）─────────────────────────
  class ExplosionBlast {
    constructor(x, y) {
      this.x = x; this.y = y;
      this.elapsed = 0; this.dur = 1500; this.done = false;
      const sw = _app ? _app.renderer.screen.width  : window.innerWidth;
      const sh = _app ? _app.renderer.screen.height : window.innerHeight;
      this.maxR = Math.max(520, Math.min(sw, sh) * 0.48);
      this.pts = Array.from({ length: 100 }, (_, i) => {
        const a = (i / 100) * Math.PI * 2 + (Math.random() - 0.5) * 0.25;
        const s = 200 + Math.random() * 380;
        return { x, y, vx: Math.cos(a)*s, vy: Math.sin(a)*s,
          r: 5 + Math.random() * 9,
          col: [COL.RED, COL.ORANGE, COL.GOLD, COL.WHITE][Math.floor(Math.random() * 4)],
          grav: 18 + Math.random() * 38 };
      });
      this.g = new PIXI.Graphics();
      this.g.blendMode = PIXI.BLEND_MODES.ADD;
      _container.addChild(this.g);
    }
    update(dt) {
      this.elapsed += dt;
      const ds = dt / 1000, ts = this.elapsed / 1000;
      for (const pt of this.pts) { pt.x += pt.vx * ds; pt.y += pt.vy * ds + pt.grav * ts * ds; }
      if (this.elapsed >= this.dur) this.done = true;
      this._draw();
    }
    _draw() {
      const g = this.g; g.clear();
      const p = Math.min(1, this.elapsed / this.dur);
      const r = this.maxR * easeOut(p);
      if (p < 0.40) {
        const fp = p / 0.40;
        g.beginFill(COL.RED,    (1 - fp) * 0.55); g.drawCircle(this.x, this.y, r);        g.endFill();
        g.beginFill(COL.ORANGE, (1 - fp) * 0.70); g.drawCircle(this.x, this.y, r * 0.65); g.endFill();
        g.beginFill(COL.GOLD,   (1 - fp) * 0.82); g.drawCircle(this.x, this.y, r * 0.38); g.endFill();
        g.beginFill(COL.WHITE,  (1 - fp) * 0.92); g.drawCircle(this.x, this.y, r * 0.18); g.endFill();
      }
      const pa = Math.max(0, 1 - p * 1.15);
      if (pa > 0) for (const pt of this.pts) {
        g.beginFill(pt.col, pa); g.drawCircle(pt.x, pt.y, pt.r * (1 - p * 0.4)); g.endFill();
      }
    }
    destroy() { this.g.clear(); this.g.parent?.removeChild(this.g); this.g.destroy(); }
  }

  // ── ShockWave（5 層火焰衝擊波）──────────────────────────────────────────
  class ShockWave {
    constructor(x, y) {
      this.x = x; this.y = y;
      this.elapsed = 0; this.dur = 1700; this.done = false;
      this.waves = [
        { delay: 0,   spd: 720, lw: 15, col: COL.WHITE,  a: 1.00 },
        { delay: 95,  spd: 590, lw: 12, col: COL.GOLD,   a: 0.90 },
        { delay: 200, spd: 470, lw: 10, col: COL.ORANGE, a: 0.78 },
        { delay: 320, spd: 360, lw:  8, col: COL.RED,    a: 0.64 },
        { delay: 460, spd: 255, lw:  7, col: COL.RED,    a: 0.50 },
      ];
      this.g = new PIXI.Graphics();
      this.g.blendMode = PIXI.BLEND_MODES.ADD;
      _container.addChild(this.g);
    }
    update(dt) {
      this.elapsed += dt;
      if (this.elapsed >= this.dur) this.done = true;
      this._draw();
    }
    _draw() {
      const g = this.g; g.clear();
      for (const w of this.waves) {
        const e = this.elapsed - w.delay; if (e <= 0) continue;
        const wp = Math.min(1, e / (this.dur - w.delay));
        const wa = (1 - wp) * w.a; if (wa <= 0.01) continue;
        g.lineStyle(w.lw * (1 - wp * 0.65), w.col, wa);
        g.drawCircle(this.x, this.y, w.spd * (e / 1000));
        g.lineStyle(0);
      }
    }
    destroy() { this.g.clear(); this.g.parent?.removeChild(this.g); this.g.destroy(); }
  }

  // ── MushroomCloud（蘑菇雲）─────────────────────────────────────────────
  class MushroomCloud {
    constructor(x, y) {
      this.x = x; this.y = y;
      this.elapsed = 0; this.dur = 3200; this.done = false;
      this.stem = Array.from({ length: 30 }, () => ({
        x: x + (Math.random() - 0.5) * 65, y,
        vy: -(75 + Math.random() * 95), vx: (Math.random() - 0.5) * 20,
        r: 10 + Math.random() * 20, delay: Math.random() * 200,
      }));
      this.cap = Array.from({ length: 48 }, (_, i) => {
        const a = (i / 48) * Math.PI * 2;
        const s = 40 + Math.random() * 58;
        return {
          x, y: y - 110,
          vx: Math.cos(a) * s, vy: Math.sin(a) * s * 0.35 - 28,
          r: 12 + Math.random() * 24, delay: 160 + Math.random() * 380,
        };
      });
      this.g = new PIXI.Graphics();
      _container.addChild(this.g);
    }
    update(dt) {
      this.elapsed += dt;
      const ds = dt / 1000;
      for (const pt of [...this.stem, ...this.cap]) {
        if (this.elapsed < pt.delay) continue;
        pt.x += pt.vx * ds; pt.y += pt.vy * ds;
        pt.vy += 9 * ds; pt.r += ds * 10;
      }
      if (this.elapsed >= this.dur) this.done = true;
      this._draw();
    }
    _draw() {
      const g = this.g; g.clear();
      const p    = Math.min(1, this.elapsed / this.dur);
      const fade = p < 0.12 ? p / 0.12 : p > 0.62 ? 1 - (p - 0.62) / 0.38 : 1;
      for (const pt of this.stem) {
        if (this.elapsed < pt.delay) continue;
        g.beginFill(COL.RED,    fade * 0.22); g.drawCircle(pt.x, pt.y, pt.r);       g.endFill();
        g.beginFill(COL.ORANGE, fade * 0.13); g.drawCircle(pt.x, pt.y, pt.r * 0.6); g.endFill();
      }
      for (const pt of this.cap) {
        if (this.elapsed < pt.delay) continue;
        g.beginFill(COL.ORANGE, fade * 0.18); g.drawCircle(pt.x, pt.y, pt.r);       g.endFill();
        g.beginFill(COL.GOLD,   fade * 0.10); g.drawCircle(pt.x, pt.y, pt.r * 0.5); g.endFill();
      }
    }
    destroy() { this.g.clear(); this.g.parent?.removeChild(this.g); this.g.destroy(); }
  }

  // ── EmberParticle（爆炸後 2-3 秒餘燼）──────────────────────────────────
  class EmberParticle {
    constructor(x, y) {
      this.x = x; this.y = y;
      this.elapsed = 0; this.dur = 2800; this.done = false;
      this.pts = Array.from({ length: 72 }, () => {
        const a = Math.random() * Math.PI * 2, d = Math.random() * 300;
        return {
          x: x + Math.cos(a) * d, y: y + Math.sin(a) * d,
          vx: (Math.random() - 0.5) * 30,
          vy: -(8 + Math.random() * 32),
          r: 1.5 + Math.random() * 2.8,
          col: [COL.RED, COL.ORANGE, COL.GOLD][Math.floor(Math.random() * 3)],
          delay: Math.random() * 500,
          fs: 0.014 + Math.random() * 0.018,
          fo: Math.random() * Math.PI * 2,
        };
      });
      this.g = new PIXI.Graphics();
      this.g.blendMode = PIXI.BLEND_MODES.ADD;
      _container.addChild(this.g);
    }
    update(dt) {
      this.elapsed += dt;
      const ds = dt / 1000;
      for (const pt of this.pts) {
        if (this.elapsed < pt.delay) continue;
        pt.x += pt.vx * ds; pt.y += pt.vy * ds; pt.vy += 9 * ds;
      }
      if (this.elapsed >= this.dur) this.done = true;
      this._draw();
    }
    _draw() {
      const g = this.g; g.clear();
      for (const pt of this.pts) {
        if (this.elapsed < pt.delay) continue;
        const e = this.elapsed - pt.delay, avail = this.dur - pt.delay;
        const tp = Math.min(1, e / avail);
        const fl = 0.45 + Math.sin(this.elapsed * pt.fs + pt.fo) * 0.55;
        const a  = (1 - tp) * fl * 0.88; if (a <= 0.01) continue;
        g.beginFill(pt.col, a); g.drawCircle(pt.x, pt.y, pt.r); g.endFill();
      }
    }
    destroy() { this.g.clear(); this.g.parent?.removeChild(this.g); this.g.destroy(); }
  }

  // ── ScreenEffect（全螢幕白閃 + 紅色光暈）───────────────────────────────
  class ScreenEffect {
    constructor() {
      this.elapsed = 0; this.dur = 950; this.done = false;
      this.sw = _app ? _app.renderer.screen.width  : window.innerWidth;
      this.sh = _app ? _app.renderer.screen.height : window.innerHeight;
      this.g = new PIXI.Graphics();
      _container.addChild(this.g);
    }
    update(dt) {
      this.elapsed += dt;
      const p = Math.min(1, this.elapsed / this.dur);
      const g = this.g; g.clear();
      if (p < 0.28) {
        // 白閃
        const fp = p / 0.28;
        const a  = fp < 0.22 ? fp / 0.22 : 1 - (fp - 0.22) / 0.78;
        g.beginFill(COL.WHITE, a * 0.88);
        g.drawRect(0, 0, this.sw, this.sh);
        g.endFill();
      } else if (p < 0.90) {
        // 紅色光暈
        const rp = (p - 0.28) / 0.62;
        const a  = rp < 0.18 ? rp / 0.18 : 1 - (rp - 0.18) / 0.82;
        g.beginFill(COL.RED, a * 0.30);
        g.drawRect(0, 0, this.sw, this.sh);
        g.endFill();
      }
      if (p >= 1) this.done = true;
    }
    destroy() { this.g.clear(); this.g.parent?.removeChild(this.g); this.g.destroy(); }
  }

  // ── ChantText（蓄力中的詠唱字幕）──────────────────────────────────────
  class ChantText {
    constructor() {
      this.elapsed = 0; this.dur = 2300; this.done = false;
      const sw = _app ? _app.renderer.screen.width  : window.innerWidth;
      const sh = _app ? _app.renderer.screen.height : window.innerHeight;
      const cx = sw / 2, baseY = sh * 0.13;
      const style = {
        fontFamily: '"Hiragino Mincho ProN","Yu Mincho","MS PMincho","Noto Serif CJK SC",Georgia,serif',
        fontSize: 20, fontWeight: 'bold',
        fill: 0xffdd66, stroke: 0x330000, strokeThickness: 4,
        align: 'center',
        dropShadow: true, dropShadowColor: 0xff2200, dropShadowBlur: 5, dropShadowDistance: 2,
      };
      this.items = [
        { str: '「吾乃惠惠，爆裂魔法之使者」', delay: 0,    y: baseY },
        { str: '「天地萬物，悉歸灰燼」',       delay: 650,  y: baseY + 34 },
        { str: '— EXPLOSION —',              delay: 1350, y: baseY + 68 },
      ].map(({ str, delay, y }) => {
        const t = new PIXI.Text(str, style);
        t.anchor.set(0.5, 0.5); t.position.set(cx, y); t.alpha = 0;
        _container.addChild(t);
        return { t, delay };
      });
    }
    update(dt) {
      this.elapsed += dt;
      for (const { t, delay } of this.items) {
        const e = this.elapsed - delay; if (e <= 0) { t.alpha = 0; continue; }
        const tp = Math.min(1, e / (this.dur - delay));
        t.alpha = (tp < 0.12 ? tp / 0.12 : tp > 0.72 ? 1 - (tp - 0.72) / 0.28 : 1) * 0.92;
      }
      if (this.elapsed >= this.dur) this.done = true;
    }
    destroy() {
      for (const { t } of this.items) {
        t.parent?.removeChild(t); t.destroy({ texture: true, baseTexture: true });
      }
    }
  }

  // ── ExplosionText（爆炸瞬間「爆裂魔法！」衝擊文字）────────────────────
  class ExplosionText {
    constructor() {
      this.elapsed = 0; this.dur = 2500; this.done = false;
      const sw = _app ? _app.renderer.screen.width  : window.innerWidth;
      const sh = _app ? _app.renderer.screen.height : window.innerHeight;
      const cx = sw / 2, cy = sh * 0.40;
      this.main = new PIXI.Text('爆裂魔法！', {
        fontFamily: '"Hiragino Sans","Yu Gothic","Microsoft JhengHei","PingFang SC",Arial,sans-serif',
        fontSize: 96, fontWeight: '900',
        fill: 0xffffff, stroke: 0xcc0000, strokeThickness: 10,
        align: 'center',
        dropShadow: true, dropShadowColor: 0xff0000, dropShadowBlur: 22, dropShadowDistance: 0,
      });
      this.main.anchor.set(0.5, 0.5); this.main.position.set(cx, cy);
      this.sub = new PIXI.Text('E  X  P  L  O  S  I  O  N', {
        fontFamily: 'Impact,"Arial Black",Arial,sans-serif',
        fontSize: 34, fontWeight: 'bold',
        fill: 0xff3300, stroke: 0x000000, strokeThickness: 4,
        align: 'center',
      });
      this.sub.anchor.set(0.5, 0.5); this.sub.position.set(cx, cy + 72);
      _container.addChild(this.main); _container.addChild(this.sub);
    }
    update(dt) {
      this.elapsed += dt;
      const p = Math.min(1, this.elapsed / this.dur);
      let scale, alpha;
      if      (p < 0.12) { const ep = p / 0.12;        scale = easeOut(ep) * 1.28; alpha = ep; }
      else if (p < 0.26) { const ep = (p - 0.12) / 0.14; scale = 1.28 - ep * 0.30; alpha = 1; }
      else if (p < 0.72) { scale = 0.98; alpha = 1; }
      else               { const ep = (p - 0.72) / 0.28; scale = 0.98 - ep * 0.08; alpha = 1 - ep; }
      this.main.scale.set(scale);    this.main.alpha = alpha;
      this.sub.scale.set(scale * 0.95); this.sub.alpha = alpha * 0.85;
      if (p >= 1) this.done = true;
    }
    destroy() {
      this.main.parent?.removeChild(this.main); this.main.destroy({ texture: true, baseTexture: true });
      this.sub.parent?.removeChild(this.sub);   this.sub.destroy({ texture: true, baseTexture: true });
    }
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

  /** 依連擊數決定魔法球顏色 */
  function _orbColor(streak) {
    if (streak >= 10) return COL.GOLD;
    if (streak >= 5)  return COL.CYAN;
    return streak >= 3 ? COL.ORANGE : COL.RED;
  }
  function _exColor(streak) {
    if (streak >= 10) return COL.GOLD;
    if (streak >= 5)  return COL.CYAN;
    return streak >= 3 ? COL.ORANGE : COL.RED;
  }

  /**
   * 觸發 Live2D 動作
   * skill_01 → 'skill'，skill_02 → 'skill2'，excite_01 → 'excite'（別名表已定義）
   * _go 會先查 mMap，若 _c1 沒有該動作則自然跳過
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
      const color  = _orbColor(streak);
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

  /**
   * 便捷方法：自動從角色位置朝指定選項發射
   * @param {string} letter  'A' | 'B' | 'C' | 'D'
   * @param {number} [streak=1]
   */
  function fireAtLetter(letter, streak = 1) {
    if (!_container) return;
    const opt = _optRect(letter);
    if (!opt) return;
    const orig = _charOrigin();
    fire({ fromX: orig.x, fromY: orig.y, toX: opt.cx, toY: opt.cy, letter, streak });
  }

  /**
   * 組合攻擊：依序發射 1×→3×→5×→10× 四段特效
   * 每段間隔 280 ms，形成連續爆炸的視覺衝擊
   * @param {string} letter  'A' | 'B' | 'C' | 'D'
   */
  function fireCombo(letter) {
    if (!_container) return;
    const opt = _optRect(letter);
    if (!opt) return;
    const orig = _charOrigin();
    const fx = orig.x, fy = orig.y, tx = opt.cx, ty = opt.cy;
    const stages = [1, 3, 5, 10];
    stages.forEach((streak, i) => {
      setTimeout(() => {
        fire({ fromX: fx, fromY: fy, toX: tx, toY: ty, letter, streak });
      }, i * 280);
    });
  }

  /**
   * 惠惠爆裂魔法（Megumin Explosion）
   * 超長蓄力 → 巨大火球形成 → 毀天滅地爆炸 → 衝擊波 → 蘑菇雲 → 餘燼飄散 → 角色魔力耗盡倒地
   * @param {string} letter  'A' | 'B' | 'C' | 'D'
   */
  function fireExplosion(letter) {
    if (!_container || !_enabled) return;
    const opt = _optRect(letter);
    if (!opt) return;

    // ── Phase 1：超長蓄力（0 ms）────────────────────────────────────────
    // 詠唱姿勢
    try { if (typeof L2D !== 'undefined') L2D.play('skill2'); } catch {}
    // 全螢幕粒子向目標吸入
    _effects.push(new EnergyAbsorb(opt.cx, opt.cy));
    // 六芒星魔法陣出現在目標上（持續 2600 ms，與蓄力同步）
    _effects.push(new MagicCircle(opt.cx, opt.cy, { color: COL.RED, dur: 2600 }));
    // 詠唱字幕逐行出現
    _effects.push(new ChantText());
    // 惠惠垂直擺手：下放外擺→停住→回位
    // PointingGesture 移除 — 手勢由 L2DGesturePlayer 統一管理
    _startTick();

    // ── Phase 2：巨大火球形成（1800 ms）─────────────────────────────────
    setTimeout(() => {
      _effects.push(new FireCore(opt.cx, opt.cy));
      _startTick();
    }, 1800);

    // ── Phase 3：毀天滅地爆炸（2600 ms）────────────────────────────────
    setTimeout(() => {
      // 全螢幕白閃 + 紅色光暈
      _effects.push(new ScreenEffect());
      // 500-800px 爆炸本體
      _effects.push(new ExplosionBlast(opt.cx, opt.cy));
      // 5 層火焰衝擊波
      _effects.push(new ShockWave(opt.cx, opt.cy));
      // 蘑菇雲
      _effects.push(new MushroomCloud(opt.cx, opt.cy));
      // 餘燼飄散
      _effects.push(new EmberParticle(opt.cx, opt.cy));
      // 目標選項光暈
      _effects.push(new OptionGlow(opt.x, opt.y, opt.w, opt.h, COL.RED));
      // 「爆裂魔法！EXPLOSION」衝擊文字
      _effects.push(new ExplosionText());
      // 大幅震動 + 後座力
      ScreenShake.shake({ amplitude: 28, duration: 700 });
      _startTick();
    }, 2600);

    // ── Phase 4：角色魔力耗盡倒地（3100 ms）────────────────────────────
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
    fire,
    fireAtLetter,
    fireCombo,
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
