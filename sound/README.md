# sound/

`multi/`（多人搶答網頁遊戲）的通用音效庫，被 `multi/SoundSystem.js` 用寫死的相對路徑直接引用（`../sound/track1.mp3` ~ `track7.mp3`）。跟 `特定角色語音/` 是兩回事——那邊是特定 Live2D 角色專屬的語音，這裡是遊戲本身的音效/配樂，不分角色。

| 檔案 | 用途 |
|---|---|
| `track1.mp3` ~ `track6.mp3` | 通用音效庫（`SFX.TRACK_1` ~ `TRACK_6`），不是各自綁定固定情境（不是「track1=答對」這種一對一關係）——實際哪一段答題/情境播放哪一軌，是由題庫/情境設定（`questions/*.json`、`host.html` 的 `soundTrack` 欄位）決定要用哪個 `TRACK_N`，等於是一個可自由指派的音效池 |
| `track7.mp3` | 背景音樂（`BGM`），遊戲進行中循環播放 |

改動這幾個檔案（換音效、加減軌數）要同步改 `multi/SoundSystem.js` 裡的 `SFX`/`BGM` 定義，不能只換檔案內容或改檔名。
