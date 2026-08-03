# desktop-pet

Live2D 桌面透明背景掛件（Electron 原型）。獨立模組，**不修改**專案任何既有檔案，只唯讀引用 `../lib/` 與 `../live2d_model/` 既有資源。

任何未預期的錯誤（包含系統匣建立失敗）都會印到 `npm start` 的終端機視窗，不會讓程式默默中止。

### 永遠拿最新版，不被 Chromium 快取卡住

`createWindow()` 裡對這個視窗的 `session` 做了兩件事：啟動時 `clearCache()` 清掉舊快取、`webRequest.onHeadersReceived` 強制每個回應都蓋成 `Cache-Control: no-store`。專案還在持續開發，`index.html`／`lib/` 隨時會改，這是跟 `launchers/README.md` 裡「為什麼到處都看得到 `Cache-Control: no-store`」同一個決策，不要因為看起來像樣板就砍掉。

### 系統匣圖示（`tray-icon.png`）

`tray-icon.png` 是離線用 Python PIL 從 `multi/default_avatar.png`（那張橘貓照片）裁切、縮放成正規 32×32 PNG 產生的，屬於 `desktop-pet` 自己的產物，不是共用資源。之所以要事先處理好而不是在程式執行期用 `nativeImage` 現場讀檔+resize，是因為 `default_avatar.png` 實際上是 JPEG 資料只是副檔名寫成 `.png`，執行期用錯誤的解碼路徑處理會讓 Windows 系統匣建立直接崩潰（曾經發生過）；程式碼裡仍保留一個內嵌純色小圖當備援，若 `tray-icon.png` 讀取失敗會自動切換過去，不會再讓整個程式崩潰。

想換掉這張貓咪圖示，重新產生指令：
```bash
cd desktop-pet
python -c "
from PIL import Image
im = Image.open('../multi/default_avatar.png').convert('RGBA')
im.crop((240, 430, 760, 950)).resize((32, 32), Image.LANCZOS).save('tray-icon.png', format='PNG')
"
```

## 執行

```bash
cd desktop-pet
npm install   # 已裝過可省略
npm start
```

### 為什麼 `node_modules` 沒有進版本控制

專案根目錄的 `.gitignore` 排除了 `node_modules/`（全專案共用這一條規則，`desktop-pet`／`host-app` 都一樣，不是漏傳）：
```
# 相依套件（可用 npm install 重新產生，不進版本控制）
node_modules/
```

真正需要進版本控制、而且確實有進的是 `package.json`／`package-lock.json`——這兩個檔案記錄「要裝哪些套件、精確到哪個版本」，`node_modules` 是**根據這兩個檔案自動產生**出來的產物：
- 體積大、檔案數量多，不適合塞進 git history
- 內容通常是平台相關的編譯/安裝結果，換一台機器應該重新 `npm install` 出對應當下作業系統/Node 版本的內容，而不是直接複製別台機器裝好的東西過去

所以在新環境（或 `git clone` 下來的專案）想跑起來，一定要先執行：
```bash
cd desktop-pet
npm install   # 讀 package.json/package-lock.json，自動重建 node_modules
```
上面「## 執行」那段指令本身就是完整流程，這裡只是額外說明為什麼那個 `npm install` 是必要步驟、`node_modules` 不見了不代表專案壞掉。

## 操作

預設是「點擊穿透」模式，滑鼠事件會直接穿透視窗到桌面/其他程式，這時候點不到角色是正常的——先切到互動模式才能拖曳／點按鈕。

| 操作方式 | 功能 |
|---|---|
| `F8` | 還原預設位置/縮放（角色被拖曳/縮放亂掉時用，會自動重新整理畫面） |
| `F9` | 切換點擊穿透 / 互動模式（互動模式下可拖曳角色、點左下角按鈕，同 host.html 操作方式） |
| `F10` | 結束程式（無邊框視窗沒有內建關閉鈕） |
| 左下角 `⠿`（bottom:8px / 61px） | 拖曳角色一 / 角色二（`lib/live2d.js` 既有功能） |
| 左下角 `🔇`（bottom:114px） | 開關聲音（**預設靜音**），控制 L2D 閒話家常的隨機音效 |
| 系統匣圖示右鍵選單 | 快捷鍵萬一跟其他軟體衝突而沒反應時的備援：一定能用的切換/結束方式；也是選擇 Live2D 角色、手動觸發動作的地方（見下方） |

角色會自動閒置動作＋表情＋閒話家常（不用點擊，全自動），見下方「閒置動作／表情／閒聊」說明。

`F8` 底層呼叫的是 `lib/live2d.js` 既有的 `L2D.clearPos()`（清掉存在 localStorage 的拖曳位置/縮放），沒有改動這個共用檔案，只是從桌寵這邊觸發它再自動重新整理。

`🔇` 按鈕不是引入 `multi/SoundSystem.js`（那個是給遊戲 SFX/BGM 用的，會預先載入 `sound/track1~7.mp3`，桌寵用不到）——而是在 `index.html` 自己攔截 `window.Audio` 建構子做靜音控制，手法跟 `SoundSystem.js` 一樣，但只管 L2D 的 `chatSounds`（閒話家常語音），範圍更小、不多載入用不到的檔案。

目前狀態（穿透／互動模式）每次切換都會印在啟動 `npm start` 的終端機視窗上，方便確認。

### 選擇 Live2D 角色（`live2d_my_like/` 收藏庫）

系統匣圖示右鍵選單裡有「角色一」「角色二」兩個子選單，列出 `live2d_my_like/` 收藏庫的所有角色（含「（預設，不覆蓋）」可清掉選擇，恢復成 `lib/live2d.js` 原本寫死的角色）。

- 在子選單裡點選只是**暫存**選擇（選單上的圓點會立刻換位置），要點選單最下面的「✅ 確定套用（重新整理）」才會真的寫入、重新整理視窗套用——沒有變更時這一項會反白不能點
- 只存在這個桌寵視窗自己的 localStorage（`l2d_mylike_d_char1` / `l2d_mylike_d_char2`），跟 `host.html`（無字首）、`player.html`（`_p_`）的選擇彼此獨立，互不影響
- 沒有做成畫面上的按鈕/下拉選單，是刻意的：Electron 原生選單樣式跟著作業系統走，不會有 HTML `<select>` 選項清單在深色主題下變白底看不清楚的問題（`host.html`/`player.html` 那邊就是用額外的 CSS 去補這個坑，桌寵這裡直接繞開）
- `main.js` 用 `fs` 直接讀 `live2d_my_like/config/manifest.json`、`names.json` 來建選單（跟 `host.html`/`player.html` 用 `fetch` 讀的是同一份檔案）；實際會下載的模型資源，仍然只有套用後 `index.html` 載入時指定的那一個路徑，跟收藏庫有幾個角色無關

### 動作測試（系統匣圖示右鍵選單）

系統匣選單裡有「動作測試」子選單，點了會直接觸發動作，不用開 F12：

- 角色一隨機動作（`L2D.playRandom1()`，`lib/live2d.js` 既有方法）
- 角色二隨機動作（`L2D.playRandom2()`，`lib/live2d.js` 既有方法）
- 對角線交叉飛行 / ⏹ 停止飛行（同一個選項，開始/停止合一的切換式按鈕，`index.html` 自訂的位置動畫）

`main.js` 用跟 `resetPosition()` 一樣的手法（`win.webContents.executeJavaScript(...)`）把呼叫送進 renderer 端執行；跟還原位置不一樣的是，這裡單純觸發動作，不會重新整理視窗。角色/L2D 還沒載入完成時點選會安靜跳過、在終端機印警告，不會讓程式出錯（判斷依據是 `window._l2dReady`，`index.html` 裡 `L2D.init().then()` 才會設 `true`，比單純檢查方法存不存在準確）。

想加新的**固定 label、單純觸發一次**的項目，在 `main.js` 的 `MOTION_ACTIONS` 陣列多加一筆 `{ label, call }` 就好，選單跟觸發邏輯都不用改：

```js
const MOTION_ACTIONS = [
  { label: '角色一隨機動作（playRandom1）', call: 'L2D.playRandom1()' },
  { label: '角色二隨機動作（playRandom2）', call: 'L2D.playRandom2()' },
  // { label: '...', call: 'L2D.playEmotion("correct")' },  // 之後照這個格式繼續加
];
```

對角線交叉飛行因為需要「開始/停止合一、label 動態變化」，不適合放進上面這種固定 label 的陣列，是另外用 `isFlying` 狀態變數 + `toggleFly()` 處理的（`buildMotionSubmenu()` 裡 `MOTION_ACTIONS` 陣列之外多加的那一項）。

**飛幾趟的設定只存在一個地方**——`index.html` 的 `flyLoop(charKey, legs = 20, ...)` 預設值。`main.js` 的 `toggleFly()` 特意呼叫 `flyLoop()` 不帶 `legs` 參數，讓這個預設值說了算：

```js
// index.html：改這裡的 20 決定不帶參數呼叫時飛幾趟
// 改成 null → 沒有次數限制，一直飛到按「⏹ 停止飛行」（main.js 的 toggleFly() 用的就是這個機制）
function flyLoop(charKey, legs = 20, durationMs = 1500) { ... }
```

`main.js`／`index.html` 是 Electron 的兩個獨立行程（main process／renderer process），沒辦法直接共用一個變數，`main.js` 只能透過 `executeJavaScript()` 送一段字串過去執行——所以次數設定刻意只放 `index.html` 一份，不要兩邊各存一次、兩套數字要對齊維護。

### 閒置動作／表情／閒聊（跟網頁模式共用同一套機制）

`index.html` 載入完成後呼叫：

```js
const IDLE_MOTION_MS = 15000;
L2D.startIdleChat(IDLE_MOTION_MS);
L2D.startIdleMotion(IDLE_MOTION_MS);
```

底層機制（`startIdleMotion`/`startIdleChat`）跟 `multi/host.html`、`multi/player.html` 完全共用同一套 `lib/live2d.js`，但**間隔刻意跟網頁模式（`multi/multiplay.js` 的 `MP_CFG.IDLE_MOTION_MS = 6000`）不一樣**：

- `startIdleMotion`：唯一負責觸發動作＋表情的地方；表情另外交錯播放避免同步感。角色一（`playRandom1`）現在改成**依序輪流播放**（不是隨機洗牌），角色二（`playRandom2`）維持原本隨機洗牌
- `startIdleChat`：只負責閒話家常泡泡＋隨機音效，職責分開後不會再重複觸發動作
- **為什麼桌寵是 15000 而不是 6000**：076 納茲現在有兩顆動作輪流播放——原本的 idle，跟一顆長達 12 秒的技能動作 `skill_02`。如果沿用網頁模式的 6 秒 tick，`skill_02` 播到一半就會被下一輪 FORCE 優先度打斷，看不到完整的爆發/淡出。拉長到 15 秒，確保 12 秒的技能動作有機會完整播完，之後還留 3 秒緩衝。這是兩邊刻意分開調整的字面值，不是共用同一個變數，網頁模式若也想避免這個問題，`MP_CFG.IDLE_MOTION_MS` 要另外調整
- 網頁模式是每題「開始作答／結果揭曉」時才開關這個循環（跟著遊戲階段走）；桌寵沒有這種事件可以掛，直接忽略事件觸發的部分，`L2D.init()` 完成後就常駐開著，維持桌寵原本「一開就持續動」的行為
- 原本桌寵自己那份 `MOTION_SEQUENCE`／`MOTION_INTERVAL_MS`（依序播放固定 16 個動作、3 秒一次）已經拿掉，改成跟網頁模式一樣用隨機洗牌播放

## 已知待調整項目

- `../lib/live2d.js` 內的 `L2D_CFG`（角色位置/大小）是為了搭配問答遊戲畫面的 `40vw` 版面調校的，直接套用在桌面掛件上位置可能不理想，需要另外調整（可考慮加一份桌面專用設定，不動共用檔案）。
- 目前是雙角色一起顯示；若只想要單一桌面掛件，可在 `index.html` 載入前用 `L2D_CFG.char2.enabled = false` 關閉其中一個（不需要改 `lib/live2d.js`）。
