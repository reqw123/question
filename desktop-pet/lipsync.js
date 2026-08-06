'use strict';

// desktop-pet「嘴型同步」的唯一測試 seam：純函式模組，不 import Web Audio API／PIXI／
// Electron，方便測試。對外契約：給一幀時域音訊資料（格式跟 AnalyserNode.
// getByteTimeDomainData() 一致）→ 回傳這一幀該套用的嘴巴開合值（0~1，Cubism 慣例）。
// 見 docs/specs/0003-desktop-pet-lip-sync.md 的 Implementation Decisions。

function computeRms(timeDomainData) {
  let sumSquares = 0;
  for (let i = 0; i < timeDomainData.length; i++) {
    const normalized = (timeDomainData[i] - 128) / 128; // -1~1
    sumSquares += normalized * normalized;
  }
  return Math.sqrt(sumSquares / timeDomainData.length);
}

const DEFAULT_MIN_THRESHOLD = 0.02; // 低於這個 RMS 視為背景噪音，不是有人在講話
const DEFAULT_GAIN = 4; // RMS 值通常偏小，放大到嘴巴看得出開合幅度的範圍
const DEFAULT_SMOOTHING = 0.6; // 跟前一幀的指數平滑權重，避免嘴巴每幀跳動看起來在抖動

function analyzeMouthOpenness({
  timeDomainData,
  previousValue = 0,
  minThreshold = DEFAULT_MIN_THRESHOLD,
  gain = DEFAULT_GAIN,
  smoothing = DEFAULT_SMOOTHING,
}) {
  const rms = computeRms(timeDomainData);
  const raw = rms < minThreshold ? 0 : rms * gain;
  const smoothed = previousValue * smoothing + raw * (1 - smoothing);
  return Math.max(0, Math.min(1, smoothed));
}

// 這個模組要在兩種環境跑：vitest/Node（`require`，`module` 存在）跟桌寵 renderer 端
// （`<script src="lipsync.js">` 直接載入純瀏覽器環境，`contextIsolation:true` 沒有
// Node 整合，`module` 不存在）。用 UMD 風格的判斷分流，測試環境維持 CommonJS 匯出
// 不變，瀏覽器環境改掛到 window.LipSync。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { computeRms, analyzeMouthOpenness };
} else {
  window.LipSync = { computeRms, analyzeMouthOpenness };
}
