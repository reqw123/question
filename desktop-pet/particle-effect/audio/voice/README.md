# 序列播放：每站語音（sequenceVoice）

把 1~2 秒的短語音 mp3 放這裡，檔名對應 `sources.js` 各模型 `particle.sequenceVoice` 欄位。

- 序列播放到這個模型、轉場淡入完成、進入停留段那一刻起算，滿 0.3 秒後播放一次。
- 不填或填空字串都跳過，不會出聲。
- 每次序列播放重新繞回這個模型的停留段都會再播一次，不是只有第一次生效。
- 播放走跟桌寵其他音效（index.html 的「閒置閒聊音效」）同一顆靜音鈕，預設靜音，
  要聽得到記得先按開。

見 `sources.js` 開頭欄位說明、`particle-effect.js` 的 `advanceSequencePlayback()`。
