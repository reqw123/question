# 序列播放：背景音樂（sequenceBgm）

把背景音樂 mp3 放這裡，檔名對應 `sources.js` 的 `export const sequenceBgm`。

- 整個「模型序列播放」session 期間唯一的一首背景音樂，跟哪個模型正在顯示無關，
  不會因為換到下一個模型就跟著換曲或重播。
- 自動 loop 播放，直到使用者關掉「模型序列播放」才停止。
- 不填或填空字串都跳過，序列播放期間完全靜音（不會播放任何背景音樂）。
- 播放走跟桌寵其他音效（index.html 的「閒置閒聊音效」）同一顆靜音鈕，預設靜音，
  要聽得到記得先按開。

見 `sources.js` 檔案最下面 `sequenceBgm` 欄位說明、`particle-effect.js` 的
`window.setParticleSequencePlayback()`/`stopSequenceMode()`。
