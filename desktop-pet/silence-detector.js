'use strict';

// desktop-pet「語音輸入」的測試 seam之二：純函式模組，不 import Web Audio API／PIXI／
// Electron，方便測試。狀態不自己保存——呼叫端每幀把上一次的 silenceStartedAt 餵回來，
// 跟 lipsync.js 的 previousValue 是同一種設計。對外契約：給這一幀的音量/時間戳 →
// 回傳「這一幀該不該停止錄音」+ 更新後的靜音起算時間。
// 見 docs/specs/0004-desktop-pet-voice-input.md 的 Implementation Decisions。

// 低於這個 RMS 視為「安靜」。原本是 0.02，跟 lipsync.js 判斷嘴巴該不該動的門檻沿用同一個
// 數字，但那是給「動畫好不好看」用的低標準，麥克風輸入這邊要判斷「有沒有真的講話」，
// 標準要嚴一點——使用者反映調高後幻覺還是差不多，所以加倍到 0.04，濾掉更多本底噪音/
// 環境雜音誤判成「有講話」的情況。如果之後還是誤判，可以再往上調；但調太高會讓正常說話
// 音量偏小、離麥克風較遠的情境被誤判成「安靜」而提早自動停止或整段被當作沒講話。
const DEFAULT_RMS_THRESHOLD = 0.04;
const DEFAULT_SILENCE_DURATION_MS = 1500; // 安靜持續多久才算「講完了」
// 整段錄音裡，音量達到 DEFAULT_RMS_THRESHOLD 的時間累計要達到多少 ms，才當作「使用者真的
// 有講話」。曾經用過「錄音期間只要出現過一次超過門檻的音框就永遠算數」的旗標判斷法，但
// 那等於一次滑鼠喀嚓聲、椅子聲、麥克風本底噪音的瞬間波動就能讓整段錄音（就算後面完全沒
// 講話）被判定成「有講話」而照樣送去 Whisper——幾乎攔不到真實環境裡的幻覺。改成累計時長，
// 只有「達到門檻」的音框合計超過這個值才算數，單一個音框的瞬間噪音不會再讓整段錄音蒙混過關。
// 見 docs/specs/0004-desktop-pet-voice-input.md「開麥克風不說話會幻覺出文字」後續修正。
const DEFAULT_MIN_SPEECH_DURATION_MS = 400;

function checkSilence({
  rms,
  silenceStartedAt,
  now,
  rmsThreshold = DEFAULT_RMS_THRESHOLD,
  silenceDurationMs = DEFAULT_SILENCE_DURATION_MS,
}) {
  const isLoud = rms >= rmsThreshold;
  if (isLoud) {
    return { shouldStop: false, silenceStartedAt: null };
  }
  const startedAt = silenceStartedAt == null ? now : silenceStartedAt;
  const elapsed = now - startedAt;
  return { shouldStop: elapsed >= silenceDurationMs, silenceStartedAt: startedAt };
}

// 匯出預設門檻，讓呼叫端（index.html）能用同一個門檻判斷「這整段錄音有沒有真的
// 出現過大於門檻的聲音」，藉此在完全沒講話時直接跳過呼叫 Whisper（見 stt.js 呼叫端
// 的靜音幻覺防呆：Whisper 對純靜音音檔不保證回傳空字串，有機率幻覺出「Thanks for
// watching」之類的字幕片語，最可靠的防法是「根本不要把純靜音送進去」）。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { checkSilence, DEFAULT_RMS_THRESHOLD, DEFAULT_MIN_SPEECH_DURATION_MS };
} else {
  window.SilenceDetector = { checkSilence, DEFAULT_RMS_THRESHOLD, DEFAULT_MIN_SPEECH_DURATION_MS };
}
