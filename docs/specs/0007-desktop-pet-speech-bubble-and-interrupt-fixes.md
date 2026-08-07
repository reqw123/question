# desktop-pet：文字泡泡排版修正＋語音播放結束後延遲收泡泡＋中途打斷

> **狀態**：spec 完成，已實作，尚未建立對應的 GitHub issue（這台機器沒有 `gh` CLI，見文末待辦）。
> **打算套用的 triage 標籤**：`ready-for-agent`。
> **依賴**：`docs/adr/0009-desktop-pet-lib-live2d-bubble-fix-exception.md`（為什麼這次破例修改共用檔案 `lib/live2d.js`）、`docs/specs/0002-desktop-pet-live-chat.md`（`speakAndShow()` 原本的文字泡泡+語音播放流程）。
> **待確認**：泡泡底邊超出螢幕這個問題，第一版修正後使用者實測仍有殘留（見下方「實作後再修正」）。已經加大安全邊界，但根因是不是真的是進場動畫過衝、還是有其他成因（例如螢幕縮放比例），還沒有實測確認到底解決了沒有。

## Problem Statement (Goal)

使用者實測發現三個問題：(1) 角色被拖到畫面邊角時，文字泡泡會跑出螢幕外，或文字被擠成一行一個字的直排；(2) 回覆文字比較長時，泡泡沒有正常換行顯示；(3) 泡泡消失的時機（跟文字長度成比例估計）常常跟語音實際講完的時間對不上，字還沒唸完泡泡就先收掉、或話講完了泡泡又留很久。另外，使用者也想在角色講到一半時能主動打斷，不想每次都聽完整段語音。

## Solution

修正 `lib/live2d.js` 的泡泡定位/換行邏輯（見 ADR-0009），改成用實際螢幕邊界做二階段定位，而不是猜測式的安全區；`word-break` 從 `keep-all` 改回 `normal`+`overflow-wrap:break-word`，讓連續中文長句正常換行。`desktop-pet/main.js` 的 `speakAndShow()` 改成真的等語音播放結束（不是估計值）之後再等 1 秒才收掉泡泡。`desktop-pet/index.html` 新增「點角色本體」／`Esc` 中途打斷語音播放的功能。

## User Stories (Requirements)

1. As the desktop-pet 使用者，I want 不管角色被我拖到畫面哪個角落，文字泡泡永遠完整顯示在螢幕範圍內，so that 不會有看不到的內容跑出螢幕外。
2. As the desktop-pet 使用者，I want 文字正常從左到右、由上到下換行顯示，so that 不會因為角色站的位置剛好被擠成一行一個字的直排、變得很難讀。
3. As the desktop-pet 使用者，I want 回覆文字比較長時也能正常完整顯示，so that 不會因為文字長就跑版或被截斷。
4. As the desktop-pet 使用者，I want 文字泡泡在語音講完之後（留 1 秒緩衝）才消失，so that 泡泡顯示的時間跟角色實際講話的時間對得上，不會提早消失或留太久。
5. As the desktop-pet 使用者，I want 角色講話講到一半可以主動打斷，so that 不用每次都聽完整段語音才能做下一件事。

## Implementation Decisions

### 泡泡邊界修正（`lib/live2d.js`，見 ADR-0009）

> **實作後再修正：寬度不看角色錨點到邊緣的距離，避免犧牲可讀性換取不超出螢幕**
>
> 第一版把 maxWidth 算成「角色錨點到螢幕邊緣的剩餘距離」，角色站到邊角時剩餘距離變小，
> 泡泡會被硬擠成很窄的欄位（實測最窄可以到 80px，長文字讀起來很痛苦）——等於用犧牲
> 可讀性的方式去換「不超出螢幕」，但其實兩者不衝突。改成寬度固定跟螢幕總寬度掛勾
> （`Math.max(READABLE_MIN_WIDTH, Math.min(PREFERRED_MAX_WIDTH, window.innerWidth - MARGIN*2))`，
> 完全不看角色錨點位置），「不超出螢幕」這件事全部交給下面第二階段的位置校正處理
> （角色站在邊角時，固定寬度的泡泡本來就可能比剩餘空間寬，這時候位移就是負責把它拉回
> 螢幕內的主要機制，不再是縮寬度）。這樣不管角色站在畫面哪裡，泡泡都維持一致、好讀的
> 寬度，同時仍然保證整個框完整留在螢幕內。數字後來又依使用者回報再調過一次：
> `READABLE_MIN_WIDTH` 200→260、`PREFERRED_MAX_WIDTH` 420→600（使用者反映原本的寬度
> 上限看起來還是不夠寬），角色一/二共用同一組數字、同一條公式，容器設計完全對稱。

- `_updateSpeechPosFor()` 改成二階段定位：第一階段跟原本一樣用角色錨點算初始 `left`/`right`/`top`，寬度固定跟螢幕總寬度掛勾（見上面「實作後再修正」）；第二階段等這一幀排版完成後，用 `getBoundingClientRect()` 量泡泡實際佔用的螢幕範圍，超出視窗邊界的話整塊平移拉回來。一般情況（角色沒有站在邊角）這個平移量是 0，不影響任何原本正確的顯示結果。
- `speakFor()` 的泡泡文字樣式 `word-break` 從 `keep-all` 改成 `normal`，加上 `overflow-wrap:break-word`——`keep-all` 對沒有空白分隔的連續中文句子會讓瀏覽器找不到斷行點，整句橫向撐破 `maxWidth`；改回 `normal` 讓 CJK 逐字斷行的內建行為生效，`overflow-wrap:break-word` 兜底處理超長的連續非 CJK 字串（例如網址）。

> **實作後再修正：邊界緩衝（`MARGIN`）從 8px 加大到 16px**
>
> 使用者實測回報泡泡底邊「好像」還是會超出螢幕。逐行審過 `_updateSpeechPosFor()` 的邊界
> 校正邏輯沒找到持續性的計算錯誤，但找到一個會造成短暫、幾像素等級誤差的成因：進場動畫
> （`_l2dSpeakIn`／`_l2dSpeakIn2`）在 70% 那格會 `scale(1.04)` 短暫過衝再彈回 1，
> `getBoundingClientRect()` 量到的是版面尺寸，transform 造成的視覺過衝不會反映在量測結果
> 裡——那段時間（進場動畫播放中，约 350ms）的實際視覺大小會比量到的大一點。把 `MARGIN`
> 加大到 16px 讓這段過衝也留在安全範圍內。如果加大 MARGIN 之後問題仍然存在，代表根源
> 不是這個過衝動畫，需要更多細節（例如是不是每次都會發生、螢幕縮放比例是否為
> 100%）才能進一步定位，見 spec 開頭的待確認事項。

### 閒置聊天迴圈會蓋掉正在顯示的真實回覆（`desktop-pet/main.js`）

使用者後來自己抓到真正的根因：`index.html` 載入完就常駐開著的 `L2D.startIdleChat()`
（每 `PET_CFG.idleMotionMs`＝15 秒跳出來講一句閒話）跟真正的對話回覆共用同一個文字泡泡
DOM——`speakFor()` 內部一律 `box.replaceChildren(bubble)` 整個換掉，閒聊計時器完全不管
當下是不是正在顯示/播放一輪真正的回覆，時間一到就直接蓋掉。這其實才是「泡泡看起來突然
消失」這個現象最主要的成因（上面「桌寵主視窗改用最高置頂等級」那條修正是真的 bug、也
值得修，但可能不是使用者最初回報那個現象的主因）——回覆播放時間越長（例如 CLI 模式的
長任務回覆），跟 15 秒閒聊週期撞期的機率就越高。

修法：`speakAndShow()` 用一個進行中計數器包住每一輪對話——開始時（計數從 0 變 1）呼叫
`L2D.stopIdleChat()` 暫停閒聊迴圈，所有進行中的輪次都結束時（計數歸零）才呼叫
`L2D.startIdleChat(PET_CFG.idleMotionMs)` 重新啟動。用計數器而不是單純的
stop-before/start-after，是因為角色一/二可能同時各自在進行一輪對話：先結束的那一輪不能
直接重啟閒置聊天，否則會蓋掉另一個角色還在進行中的回覆。`stopIdleChat()`/`startIdleChat()`
都是 `lib/live2d.js` 既有的公開方法，這個修正完全在 `desktop-pet/main.js` 這邊完成，
沒有再碰共用檔案。

### 桌寵主視窗改用最高置頂等級（`desktop-pet/main.js`）

使用者回報：下完指令後點別的視窗（想去做別的事），文字泡泡就看不見了。根因是桌寵主視窗
`win` 建立時只用建構子的 `alwaysOnTop:true`（Electron 預設置頂等級）——這個 repo 自己在
`raiseAboveDesktopPets()`（設定視窗等小視窗共用）的註解裡就已經記錄過同一種坑：
「Windows/Mac 不保證兩個『置頂視窗』誰疊在誰上面」，小視窗那邊用 `'screen-saver'`
（Electron 支援的最高置頂等級）解決，但桌寵主視窗本身當初沒有套用同一個修正。改成
`win.setAlwaysOnTop(true, 'screen-saver')`，只在視窗建立時設一次——不像小視窗每次開啟都
呼叫 `moveTop()+focus()`：桌寵主視窗全程開著不需要重複搶置頂，`focus()` 更是不能加，
否則會變成每次都搶走使用者剛點的其他視窗的焦點，反而干擾他去做別的事（這正是這次要
解決的使用情境：使用者要能自由切去別的視窗，桌寵只要維持視覺上留在最上層可見即可，
不需要也不應該搶焦點）。

### 文字泡泡跟聊天輸入框的疊放順序（`desktop-pet/index.html`）

使用者回報：文字泡泡有時會被聊天輸入框擋住。原因是聊天輸入框（`0002` spec 就設計成
送出後刻意保持開著、方便連續聊天，不自動關閉）用 `z-index:10002`，比文字泡泡的
`z-index:100`（`lib/live2d.js` 的 `_Z_BUBBLE`）高很多——只要輸入框還開著（正常情況下
它會一直開到使用者手動關閉），角色講話的泡泡永遠會被疊在輸入框下面，完全看不到。改成
把輸入框的 `z-index` 降到 90（低於泡泡的 100，仍然高於點角色開輸入框的觸發 overlay
`z-index:50`）——泡泡本身 `pointer-events:none`，疊在輸入框上面不影響輸入框照常可以
點擊/打字，純粹是視覺疊放順序的調整。

### 泡泡消失時機改成對齊實際播放結束（`desktop-pet/main.js`）

- `speakAndShow()` 原本用 `bubbleDurationFor(text)`（跟文字長度成比例的估計值，180ms/字）當 `L2D.speak()` 的 `duration`，現在只有語音合成**失敗**（沒有音檔可以對齊播放時間）時才用這個估計值當退回方案。
- 有音檔的正常情況：呼叫 `L2D.speak()` 時給一個很大的 `duration`（`BUBBLE_NO_AUTO_DISMISS_MS`＝10 分鐘，實務上不可能真的等到這裡），確保 `lib/live2d.js` 內建的自動消失計時器不會搶先觸發；等 `waitForTtsPlaybackFinished()` 真的收到 renderer 回報播放結束，再等 `BUBBLE_DISMISS_DELAY_AFTER_SPEECH_MS`（1000ms）才呼叫 `L2D.dismissFor(charKey)`（`lib/live2d.js` 既有的公開方法，見下方 Further Notes）主動收掉泡泡。

### 中途打斷（`desktop-pet/index.html`）

- `window.isTtsPlaying(charKey?)`／`window.interruptTtsPlayback(charKey?)`：暴露在 `playTtsAudio()` 同一段閉包裡，`charKey` 可省略（不分是哪個角色，只要有語音在播就算）。打斷的實作是 `audio.pause()` + 手動觸發跟自然播完/播放失敗同一個 `reportFinished()`——main process 完全不用知道這輪播放是自然結束還是被打斷的，都走 `tts-playback-finished` 同一條回報路徑，`speakAndShow()` 的「播放結束後等 1 秒收泡泡」邏輯自動適用，不用另外處理。
- 觸發方式一：**點角色本體**——原本點角色本體是開聊天輸入框（`0002` spec），現在改成先檢查角色是不是正在講話，是的話點擊變成打斷，不開輸入框（想聊天的話，打斷之後再點一次就會照原本行為開輸入框）。角色沒在講話時行為完全不變。
- 觸發方式二：**Esc 鍵**——沿用既有的 `document` 層級 `keydown` 監聽（跟錄音取消共用同一個監聽器，接在錄音取消/清空麥克風待命狀態兩個分支之後），錄音相關的兩個情況都不成立時才輪到「有語音在播就打斷」，不會跟既有的 Esc 行為（取消錄音、關聊天框）互相搶。
- overlay 的 `title`（滑鼠停留提示）依目前是不是在講話動態顯示「點我打斷說話」或「點我跟角色說話」，跟每 400ms 重算 overlay 位置的既有輪詢一起更新，不用另外開一個計時器。

## Testing Decisions

- **刻意不寫自動測試**：這一批修正全部是 DOM 排版計算（`getBoundingClientRect()`）、Electron IPC 時序、`<audio>` 播放狀態這幾類需要真實瀏覽器/Electron 環境的邏輯，跟這幾個檔案原本的測試策略一致（`lib/live2d.js`、`index.html`、`main.js` 裡跟畫面/播放直接綁定的部分本來就沒有 vitest 覆蓋，可測試的邏輯已經抽到 `chat.js`／`tts.js`／`stt.js`／`ollama.js`／`claude-cli.js` 這些純函式模組）。用跑起來手動驗證取代：拖角色到四個邊角個別測泡泡顯示、餵一段長回覆測換行、測語音播完後泡泡消失的時間點、測點角色本體/Esc 中途打斷。

## Acceptance Criteria

1. 把角色拖到畫面左上/右上/左下/右下四個角落分別觸發一次泡泡 → 泡泡整個框（不只是文字）都完整留在螢幕範圍內，沒有任何部分被裁切或跑出視窗。
2. 觸發一段較長的中文回覆（沒有空白、連續好幾句） → 文字正常換行成多行，不會被擠成一行一個字的直排，也不會橫向撐出泡泡框。
2a. 把角色拖到緊貼螢幕邊緣（角色錨點離邊緣不到 260px）再觸發泡泡 → 泡泡寬度維持在可讀的 260px 以上（不會因為角色貼邊就被壓得更窄），改用整體位置平移的方式留在螢幕內；角色一/二用同一組寬度規則，容器大小、換行行為完全一致。
3. 有設定 OpenAI key、語音正常播放的情況下 → 泡泡在語音播完之後大約 1 秒才消失，不會語音還在播就先消失、也不會播完之後留超過 1 秒左右才消失。
4. 語音合成失敗（例如 key 無效）→ 泡泡照舊用跟文字長度成比例的時間顯示後消失，不受這次修改影響。
5. 角色講話講到一半點擊角色本體 → 語音立刻停止，泡泡照樣走「停止後等 1 秒消失」的流程；再點一次角色本體 → 開啟聊天輸入框（跟角色沒講話時的原本行為一致）。
6. 角色講話講到一半按 Esc（沒有在錄音、麥克風也不是待命中狀態）→ 語音立刻停止，行為跟點角色本體打斷一致。
7. 角色沒有在講話時點角色本體／按 Esc → 行為完全不受這次修改影響（開輸入框／原本的 Esc 行為）。
8. 觸發角色講話後，立刻點桌面上其他應用程式的視窗（瀏覽器、檔案總管等）→ 文字泡泡（跟角色本體）仍然維持可見，不會被剛點的那個視窗蓋住。
9. 送出一則訊息、等角色開始講話，聊天輸入框保持開著（沒有手動關閉）→ 文字泡泡顯示在輸入框上面，看得到完整內容，不會被輸入框擋住；輸入框本身照常可以點擊/打字。
10. 觸發一輪播放時間超過 15 秒的回覆（例如很長的 CLI 模式任務結果）→ 回覆泡泡全程顯示到播放結束＋1 秒才消失，中途不會被閒置聊天蓋掉；回覆結束、閒置一段時間之後 → 閒置聊天照常會跳出來（沒有被永久關掉）。

## Edge Cases

- **角色被拖曳到極端位置（例如視窗最邊緣 1px）**：`_updateSpeechPosFor()` 的第二階段平移在極端情況下仍然只保證 `MARGIN`（8px）的最小邊界，不會讓泡泡完全消失或縮成負寬度——`Math.max(80, ...)` 保底一個最小可讀寬度。
- **播放結束的 1 秒緩衝期間，使用者又觸發了新的一輪對話**：新一輪的 `speakAndShow()` 呼叫 `L2D.speak()` 時本來就會用新內容整個換掉泡泡（`box.replaceChildren(bubble)`），舊的 `dismissFor()` 就算稍後才觸發也只是對著已經被換掉的內容做淡出動畫，不會誤刪新內容——`dismissFor()` 本身也會先 `clearTimeout(box._tid)` 才動作，行為上是安全的。
- **中途打斷發生在音檔還沒真的開始播放（`play()` 的 Promise 還沒 resolve）之前**：`interruptTtsPlayback()` 呼叫 `audio.pause()` 對還沒開始播放的 `<audio>` 元素一樣合法（等同取消），`reportFinished()` 照樣會被觸發，不會卡住。
- **兩個角色都在講話（理論上不會發生，`playTtsAudio()` 一次只播一個，見既有的「新語音播放前先停掉還在播的舊語音」邏輯）**：`isTtsPlaying()`/`interruptTtsPlayback()` 帶 `charKey` 時只認目前真正在播放的那一個，跟傳入的 `charKey` 對不上就視為「這個角色沒在講話」，不會誤打斷。

## Out of Scope

- **`multi/host.html`／`multi/player.html` 的手動迴歸測試**——`lib/live2d.js` 的修改理論上只修 bug、不改變任何原本正常運作的顯示結果（見 ADR-0009），但沒有在這兩個頁面實際跑過完整迴歸測試，日後如果這兩個頁面出現泡泡相關的異常，第一個該懷疑的就是這次修改。
- **中途打斷時的視覺/音效回饋**（例如打斷瞬間的提示音）——目前只是單純停止播放，沒有額外的回饋效果。
- **打斷後保留已經唸出的部分文字、只清掉還沒唸的部分**——泡泡文字本來就是一次顯示全部，沒有跟音檔進度同步顯示文字進度，這次也不新增這個能力。

## Further Notes

- `L2D.dismissFor(key)` 是 `lib/live2d.js` 既有就有的公開方法（用在問答遊戲手動收泡泡的情境），這次沒有新增或修改這個方法本身，只是 desktop-pet 這邊第一次主動呼叫它。
- 相關文件：`docs/adr/0009-desktop-pet-lib-live2d-bubble-fix-exception.md`（務必先讀這份，理解這次為什麼破例修改共用檔案）。

## 待辦：補建 GitHub Issue

跟前幾份 spec 一樣，這台機器沒有 `gh` CLI。日後裝好並登入後：

```bash
gh issue create \
  --repo reqw123/question \
  --title "desktop-pet：文字泡泡排版修正＋語音播放結束後延遲收泡泡＋中途打斷" \
  --body-file docs/specs/0007-desktop-pet-speech-bubble-and-interrupt-fixes.md \
  --label ready-for-agent
```
