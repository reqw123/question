'use strict';

// ── SoundSystem ───────────────────────────────────────────────────────────────
// 唯一責任：遊戲音效（SFX）與背景音樂（BGM）
//
// 公開 API（全域函式，與現有呼叫端相容）：
//   toggleSound()        → bool（目前是否開啟）
//   playSound(track)     → 播放 SFX（'TRACK_1' … 'TRACK_6'）
//   playBeep(freq, dur, vol)
//   startBGM() / stopBGM()
//   setBGMVolume(0~1)
//   createBGMControl(bottomPx)  → 建立滑桿 UI 並掛載到 body
//
// 全域狀態：
//   soundEnabled         → boolean，供外部模組讀取（VoiceBroadcastModule 等）

var soundEnabled = false;  // var 確保掛上 window，跨 <script> tag 可見

// 攔截 Audio 建構子，讓 Live2D 動態建立的音訊元素也受靜音控制。
// 同時記錄所有建立過的音訊元素（含 L2D 的 _chatAudio），讓 toggleSound() 切靜音時
// 能立刻停掉「當下正在播放」的音效，而不是只影響之後新建立的。
const _allAudio = new Set();
(function () {
  const _Orig = window.Audio;
  window.Audio = function (...args) {
    const a = new _Orig(...args);
    a.muted = !soundEnabled;
    _allAudio.add(a);
    a.addEventListener('ended', () => _allAudio.delete(a));
    return a;
  };
  window.Audio.prototype = _Orig.prototype;
})();

const SFX = {
  TRACK_1: new Audio('../sound/track1.mp3'),
  TRACK_2: new Audio('../sound/track2.mp3'),
  TRACK_3: new Audio('../sound/track3.mp3'),
  TRACK_4: new Audio('../sound/track4.mp3'),
  TRACK_5: new Audio('../sound/track5.mp3'),
  TRACK_6: new Audio('../sound/track6.mp3'),
};
Object.values(SFX).forEach(a => { a.preload = 'auto'; });

const BGM = new Audio('../sound/track7.mp3');
BGM.loop    = true;
BGM.preload = 'auto';
BGM.volume  = Math.max(0, Math.min(1,
  parseFloat((() => { try { return localStorage.getItem('bgm_volume'); } catch { return null; } })() || '0.3')
));

let _bgmActive  = false;
let _currentSfx = null;
let _beepCtx    = null;

function toggleSound() {
  soundEnabled = !soundEnabled;
  const mute = !soundEnabled;
  Object.values(SFX).forEach(a => {
    a.muted = mute;
    if (mute) { a.pause(); a.currentTime = 0; }
  });
  BGM.muted = mute;
  if (mute) BGM.pause();
  else if (_bgmActive) BGM.play().catch(() => {});

  // 立刻套用到所有動態建立的音訊元素（例如 L2D 閒話家常語音 _chatAudio），
  // 避免切靜音當下正在播的聲音沒有立即停止
  _allAudio.forEach(a => {
    if (a.ended) { _allAudio.delete(a); return; }
    a.muted = mute;
    if (mute) a.pause();
  });
  return soundEnabled;
}

function playSound(track) {
  if (!soundEnabled) return;
  const a = SFX[track];
  if (!a) return;
  if (_currentSfx && _currentSfx !== a) { _currentSfx.pause(); _currentSfx.currentTime = 0; }
  _currentSfx = a;
  a.play().catch(() => {});
}

function playBeep(freq = 880, duration = 0.1, vol = 0.4) {
  if (!soundEnabled) return;
  try {
    if (!_beepCtx) _beepCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc  = _beepCtx.createOscillator();
    const gain = _beepCtx.createGain();
    osc.connect(gain);
    gain.connect(_beepCtx.destination);
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol, _beepCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, _beepCtx.currentTime + duration);
    osc.start(_beepCtx.currentTime);
    osc.stop(_beepCtx.currentTime + duration);
  } catch {}
}

function startBGM() {
  _bgmActive = true;
  if (!soundEnabled || !BGM.paused) return;
  BGM.play().catch(() => {});
}

function stopBGM() {
  _bgmActive = false;
  BGM.pause();
  BGM.currentTime = 0;
}

function setBGMVolume(v) {
  BGM.volume = Math.max(0, Math.min(1, v));
  localStorage.setItem('bgm_volume', BGM.volume.toFixed(2));
}

function createBGMControl(bottomPx) {
  const vol  = Math.round(BGM.volume * 100);
  const wrap = document.createElement('div');
  wrap.title = '背景音樂音量';
  wrap.style.cssText =
    `position:fixed;bottom:${bottomPx}px;left:6px;z-index:200;` +
    'width:45px;padding:5px 0 4px;border-radius:9px;' +
    'border:1px solid rgba(255,255,255,.18);background:rgba(0,0,0,.5);' +
    'display:flex;flex-direction:column;align-items:center;gap:2px;';

  const icon = document.createElement('div');
  icon.textContent = '🎵';
  icon.style.cssText = 'font-size:15px;line-height:1.5;';

  const inp = document.createElement('input');
  inp.type = 'range'; inp.min = '0'; inp.max = '100'; inp.value = vol;
  inp.style.cssText =
    'writing-mode:vertical-lr;direction:rtl;' +
    'height:48px;width:18px;cursor:pointer;accent-color:#0d4;';

  const lbl = document.createElement('div');
  lbl.textContent = vol + '%';
  lbl.style.cssText =
    'font-size:9px;font-family:monospace;' +
    'color:' + (vol > 0 ? '#0d4' : '#888') + ';';

  inp.addEventListener('input', () => {
    const v = parseInt(inp.value) / 100;
    setBGMVolume(v);
    lbl.textContent = inp.value + '%';
    lbl.style.color = v > 0 ? '#0d4' : '#888';
  });

  wrap.append(icon, inp, lbl);
  document.body.appendChild(wrap);
}
