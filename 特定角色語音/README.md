# 特定角色語音/

特定 Live2D 角色專屬的閒話語音，被 `live2d_my_like/config/manifest.json` 的 `chatSounds` 欄位、或 `lib/live2d.js` 的全域預設音效池引用。跟 `sound/`（`multi/` 網頁遊戲的通用音效/配樂）是不同用途，不要混在一起。

| 檔案 | 狀態 |
|---|---|
| `cat.mp3` | 使用中——`live2d_my_like/config/manifest.json` 裡 `home_cat` 模型的 `chatSounds` 直接引用 `../特定角色語音/cat.mp3` |
| `zc1y2-bculs.mp3` | 目前未使用——`lib/live2d.js` 的全域預設 `chatSounds` 池裡有這個路徑，但整行被註解掉了（保留作為之後要恢復全域預設音效時的參考） |
| `恩師的叮嚀.mp3` | 目前未使用——整個 repo 找不到任何地方引用這個檔案，來源/用途不明，暫時保留 |

改動或刪除這裡的檔案前，先確認 `live2d_my_like/config/manifest.json` 跟 `lib/live2d.js` 有沒有寫死引用對應路徑。
