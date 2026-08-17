# CLI 模式接入 Playwright MCP，讓桌寵能真的操控瀏覽器（系統 Chrome、真實登入狀態）

ADR-0005 明確決定過「網頁摘要」只做貼網址＋後端唯讀 fetch，不做瀏覽器自動操作，並刻意把功能改名避免被誤解成「agent 操控瀏覽器」。這份 ADR 記錄後來為什麼還是在 **CLI 模式**（ADR-0008）底下加了真的瀏覽器操控能力，以及為什麼認為這跟 ADR-0005 的決定不算牴觸。

## 動機

使用者在 CLI 模式下請角色「幫我用瀏覽器查資料」時，Claude 會回覆「我沒有能力操控瀏覽器」——CLI 模式底下的 Claude Agent SDK query 完全沒有接任何瀏覽器相關的 MCP server，不是被權限擋掉，是工具清單裡本來就沒有這個選項。

## 為什麼跟 ADR-0005 不算牴觸

ADR-0005 界定的範圍是**即時聊天模式**（一般對話，隨時可能觸發）的「貼網址自動摘要」——那個情境下唯讀 fetch 已經足夠，真的操控瀏覽器對那個功能而言是不必要的風險升級，所以刻意不做。

CLI 模式是完全不同的風險層級：ADR-0008 已經決定讓它能做「本機任意程式碼執行」（`Bash`／`Write`／`Edit`），需要使用者明確說出觸發短語才會進入，且每個非唯讀操作都要逐一同意。瀏覽器操控只是這個既有執行能力的**其中一種工具類別**，不是把 ADR-0005 否決掉的「聊天中隨時可能發生的瀏覽器自動化」重新加回來。網頁摘要功能（`page-digest.js`）完全沒有變動。

即便如此，這仍然是刻意跟 ADR-0005 記錄的「避免做 agent 操控瀏覽器」精神方向相反的決定——記錄下來，不是含糊帶過。

## 技術選擇：Playwright MCP（`@playwright/mcp`），走 `--extension` 接使用者本來就開著的 Chrome

- 透過 SDK 的 `mcpServers` 選項（`claude-cli.js` 的 `buildPlaywrightMcpServer()`）以 stdio 啟動 Microsoft 官方的 `@playwright/mcp`，工具會以 `mcp__playwright__browser_*`（`browser_navigate`／`browser_click`／`browser_type`／`browser_evaluate`...）出現在 Claude 的工具清單裡。
- **這些工具沒有被加進 `SAFE_TOOLS`**——跟 `Bash`／`Write`／`Edit` 一樣，一律經過既有的 `canUseTool` 確認流程才會執行（見 ADR-0008），本身沒有另外開一條可以跳過確認的路。免確認模式（ADR-0010）開啟時的行為也跟其他風險工具一致（自動放行＋事後 `onNarration` 告知），沒有特別再加一層。
- 使用者明確選擇要接**系統既有的 Chrome、沿用真實登入狀態**，而不是 Playwright 另外下載、完全隔離的乾淨 Chromium。

### 走過的彎路：`--browser chrome` + `--user-data-dir` 會撞上 profile 鎖定

第一版實作用 `--browser chrome`（Chrome channel）＋ `--user-data-dir` 指到 `%LOCALAPPDATA%\Google\Chrome\User Data`，讓 Playwright 自己啟動一個指向使用者真正 Chrome 個人資料夾的新行程。實測發現：使用者平常本來就開著 Chrome 時（這台機器幾乎一定是這樣），新行程會撞上 Chromium 的 single-instance 鎖定機制——跳出一個新視窗、卡在 `about:blank` 不動，因為 Chromium 把這個新行程的請求轉交給既有行程處理，但 Playwright 的 CDP 連線還連著那個新開、實際上沒被 Chromium 真正接手的視窗，導覽指令送不到真正在跑的分頁。

改用 `--extension`：透過 Chrome 的「Playwright Extension」擴充套件，直接連到使用者**本來就開著**的那個 Chrome，完全不另外啟動瀏覽器行程、不需要 `--user-data-dir`，因此不會有 profile 鎖定的問題。代價：
- 使用者要先手動從 Chrome 線上應用程式商店安裝這個擴充套件一次（`chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm`）——沒有辦法用程式自動安裝瀏覽器擴充套件，這是使用者這邊唯一要做的一次性設定。
- 第一次連線時，Chrome 那邊會跳出一個「選擇要把哪個分頁交給 Claude 操控」的畫面，需要使用者手動選一次。
- 如果使用者完全沒開 Chrome（`chrome.exe` 沒有任何行程），`--extension` 模式會連線失敗——跟原本「乾淨獨立 Chromium」的設計不同，這個做法本質上要求使用者的 Chrome 是「已經開著」的狀態，不會自動幫使用者開一個新的。

### 第三個坑：授權對話框每次 spawn 都跳，因為每次都是新的隨機 token

`--extension` 第一次連線時，Chrome 擴充套件會跳出一個對話框：「claude-code 想要連線，這會把整個瀏覽器（含所有分頁的登入狀態/cookie）暴露給這個 client」，要使用者親自按「Allow & select」才會放行。實測發現這個對話框幾乎每次用到瀏覽器工具都會跳出來，不是只跳一次——因為 `mcpServers` 是 `_runLoop()`（CLI 模式的每一句新指令）都重新組一次、重新 spawn 一次 `@playwright/mcp` 行程，而預設情況下每次 spawn 出來的行程都會拿到一組新的隨機 token，擴充套件那邊沒辦法辨認「這其實是同一個已經授權過的 client」，只能每次都重新問一次。

`@playwright/mcp` 支援用 `PLAYWRIGHT_MCP_EXTENSION_TOKEN` 環境變數固定 token：`buildPlaywrightMcpServer()` 如果偵測到父行程（desktop-pet 這個 Electron 主行程）的環境變數有設這個值，會把它連同完整的 `process.env`（不能只塞這一個 key——`npx` 需要 `PATH` 之類的變數才找得到 `node`/`npm`，只塞一個 key 等於清空子行程的環境變數表，會直接啟動失敗）一起傳給子行程的 `env`。使用者拿到對話框顯示的 token、設成這個環境變數、對那個 token 按過一次「Allow」之後，之後每次 spawn 都帶著同一個已授權過的 token，擴充套件就不會再問。

這不是繞過 ADR-0008 那道「風險操作要讓使用者親眼看到、親自同意」的防線——這個對話框本來就是**連線層級**的一次性信任決定（跟安裝擴充套件本身同一類，見上面「代價」那條），不是 CLI 模式裡 `canUseTool` 那種**每個操作**都要問的防線；`canUseTool` 的確認流程完全不受這個 token 影響，該問的操作還是照常問。沒設這個環境變數時行為不變（子行程照常繼承目前的環境變數，只是每次都是新 token、需要重新授權）。

### 第四個坑：沒授權時卡在思考中，卡多久是個查不到的黑盒數字

實測過使用者沒有及時處理 Chrome 那邊跳出的授權對話框（或分頁選擇畫面沒反應）時，desktop-pet 這邊只會停在「思考中」，沒有任何提示告訴使用者「Chrome 那邊有東西在等你」。往下查發現 `buildPlaywrightMcpServer()` 一直沒有設 `timeout`（`McpStdioServerConfig` 支援的「per-server tool-call timeout」欄位）——卡多久取決於 SDK 內建的預設值，而 SDK 是編譯壓縮過的，查不到確切數字。

已補上 `timeout: 120000`（2 分鐘，比 Playwright 自己導覽逾時的預設 60 秒更寬鬆，避免比 Playwright 自己的逾時還早觸發）。這不能讓使用者「更早發現」Chrome 那邊在等他——那是 Chrome 擴充套件自己的 UI，desktop-pet 這邊接觸不到——但至少把「不知道要等多久」變成「已知、會自動結束、附帶清楚錯誤訊息」的等待，逾時後走既有的 `_runLoop` catch 分支，回報成 `error` 而不是永遠卡在思考中。

### 第五個坑：`err.message` 沒防非 Error 物件，是目前唯一找到「連 Esc 都救不回來」的路徑

審查 `_runLoop` 的 catch block 時發現：`` `CLI 任務發生錯誤：${err.message}` `` 假設 `err` 一定是標準 `Error` 物件。如果 SDK 丟出非 Error 值（例如 `reject(null)`），存取 `.message` 會在這個 catch block 裡再丟一次例外——這次沒有人接，`_runLoop()` 的 promise 變成 unhandled rejection，`_settle()` 永遠不會被呼叫，`main.js` 在等的 `waiterPromise` 永遠不會 resolve，畫面卡在「思考中」。更糟的是這行**之前**已經把 `this.busy` 設成 `false`，使用者按 Esc 呼叫 `abort()` 只會看到 `if (!this.busy) return false`——系統認為沒有任務在跑，沒有任何操作救得回來。這是今天審查裡唯一找到「不只是等很久，是真的沒有恢復手段」的案例，雖然觸發條件很窄（SDK 要丟非 Error 值），還是改成 `err?.message ?? String(err)`，避免存取 `.message` 本身再炸一次。這個問題跟瀏覽器工具本身無關（`_runLoop` 是既有的既有邏輯），是這次順手查出來、順手修的既有缺口。

### 另一個走過的彎路：`npx @playwright/mcp@latest` 讓 `package.json` 裝的本地版本形同虛設

第一版連 `npx` 指令都寫成 `npx -y @playwright/mcp@latest`——`npx` 遇到明確指定版本/tag（`@latest` 也算）時，一定會先連 npm registry 查一次「latest 現在是哪一版」才決定要不要用，**不會**因為 `package.json` 已經裝了對應版本（`npm install` 進 `node_modules` 那份）就跳過這次查詢。而 `mcpServers` 是 `_runLoop()`（CLI 模式裡每一句新指令）都重新組一次、重新 spawn 一次的，等於每一個 CLI 任務——不只是牽涉瀏覽器的那些——都多一個網路依賴：離線或 npm registry 一時連不上時，連完全不需要瀏覽器工具的任務也可能被拖慢。已改成 `npx -y @playwright/mcp`（不帶版本），讓 `npx` 優先用本地已安裝的版本，不用每次都連網路確認；用 `npx --offline @playwright/mcp --version` 驗證過確實不用連網也能跑。

### 第六個坑：桌寵主視窗蓋滿螢幕＋釘在最高置頂等級，把 Chrome 蓋住了

實測發現：CLI 模式請角色開網頁後，Chrome 分頁**在「互動模式」下完全看不到內容（畫面空白）**，要手動切成「穿透模式」再點一下畫面空白處才會顯示出來。往下查是 `main.js` 主視窗的既有設定造成的：

```js
const { width, height } = screen.getPrimaryDisplay().workAreaSize; // 蓋滿整個螢幕
win.setAlwaysOnTop(true, 'screen-saver'); // Windows 最高置頂等級
```

這個設定是刻意的（見 `main.js:1695-1702` 的既有註解：確保使用者點別的視窗時桌寵不會被蓋住），在瀏覽器自動化這個功能出現之前完全合理——桌寵原本只是個裝飾性覆蓋層，沒有任何情境需要看清楚它底下的東西。但現在 CLI 模式會叫出一個使用者需要親眼確認/觀察的 Chrome 分頁，這個「永遠疊在最上層」的設計就變成擋路的東西：**互動模式**下桌寵這層透明視窗攔截滑鼠事件、Windows 視窗合成沒有正確重繪底下的 Chrome，畫面看起來是空白的；**穿透模式**下桌寵不再攔截滑鼠、點擊事件直接穿透給 Chrome，這個互動剛好逼出一次正確重繪，內容才顯示出來——使用者摸索出「切穿透模式再點一下」這個手動解法，但這不該是使用者每次都要記得做的事。

修法：`main.js` 加了 `setBrowserToolActive(charKey, active)`，用一個 `browserLoweredChars`（`Set<charKey>`）追蹤「目前有哪些角色正在跑瀏覽器工具」；只要這個集合非空，桌寵視窗的置頂等級就從 `'screen-saver'` 降到 `'normal'`，讓 Chrome 能正常疊在上面；全部角色都結束了才恢復 `'screen-saver'`。用 `Set` 而不是單一 boolean，是因為角色一、角色二可能同時各自在 CLI 模式跑瀏覽器工具，任何一個還在跑就該維持降級狀態。

觸發時機接在 `claude-cli.js` 新增的 `onToolUse(toolName)` callback——`canUseTool` 每次被呼叫（不管最後是自動放行還是要暫停問使用者）都會先通知一次，`main.js` 收到 `mcp__playwright__` 開頭的工具名稱就呼叫 `setBrowserToolActive(charKey, true)`；工具呼叫是不是「已經真的執行完」我們沒有能力知道（見 ADR 更早的說明，SDK 沒有給這個粒度的訊號），所以恢復的時機退而求其次，改成「整個 CLI 任務收尾」（`outcome.type !== 'confirm'`）就恢復，不追求「這個瀏覽器工具呼叫本身結束」那麼精細的時機——這個妥協的代價是：如果一個任務裡有好幾輪瀏覽器操作，中間夾雜的非瀏覽器確認也會維持降級狀態直到整個任務結束，不會每個瀏覽器工具呼叫結束就立刻恢復再降級一次；這個副作用可以接受，比起「每個工具呼叫都精準對應」複雜很多但換不到明顯的體驗差異。

`claude-cli.js` 這個模組本身刻意不知道 Electron/視窗這些概念——`onToolUse` 只是單純的「有工具要跑了」通知，怎麼用完全是 `main.js` 這層glue的責任，維持這個模組「不用裝 SDK、不用碰 Electron 就能測」的既有設計（見 `docs/specs/0006`）。

### 第七個坑：Esc 兩個獨立的問題——CLI 模式底下從來沒真的中止過，而且穿透模式下按不到

使用者直接問「不管 F9 模式都能讓 Esc 提早打斷輸入和輸出嗎」，查證後發現答案是否定的，而且是兩個獨立疊加的問題：

**問題一（更嚴重，跟 F9 模式無關）：`chat-cancel` 的判斷順序讓 CLI 模式的 Esc 從來沒有真的生效過。** `chatAbortControllers.set(charKey, controller)` 在 `chat-send` 一開頭就無條件執行（早於任何 CLI 模式判斷），要到整個 handler 函式收尾（含 CLI 分支跑完）的 `finally` 才 `delete`——但這個 `controller` 從來沒有被傳進 `ClaudeCliSession` 或 `canUseTool` 的任何地方。舊版 `chat-cancel` 的判斷順序是先查 `chatAbortControllers`、找到就直接 `controller.abort()` 然後 `return { ok: true }`，靠著一行舊註解「兩者互斥（同一個 charKey 不會同時有 chatAbortControllers 的 entry 又在 CLI 模式）」自我說服這樣沒問題——這個假設是錯的，CLI 任務執行期間這個 map 裡一樣有一筆（沒被用到的）entry。結果是：**即使桌寵視窗當下確實有鍵盤焦點**，CLI 模式下按 Esc 也只是對一個沒人在聽的 `AbortController` 呼叫 `abort()`，回報 `{ok:true}` 但實際上 `ClaudeCliSession.abort()` 從來沒被呼叫過。修法：`chat-cancel` 改成先查 `cliModeActive` 判斷目前是不是 CLI 模式，是的話直接找 `claudeCliSessions` 處理，不會被這個一直存在卻沒有實際作用的 controller 攔截。

**問題二（使用者原本問的那個）：即使問題一修好了，穿透模式下 Esc 還是可能傳不到桌寵。** Esc 的攔截完全是 `index.html` 裡視窗內的按鍵監聽（`document`／`chatInput` 的 `keydown`），不是像 F9/F10 那種註冊在 OS 層級的 `globalShortcut`，只有桌寵視窗真的有 OS 鍵盤焦點時才收得到事件。`setClickThrough()` 只做 `win.setIgnoreMouseEvents(clickThrough, { forward: true })`，沒有任何機制把鍵盤焦點釘住——穿透模式下使用者點擊桌寵背後的其他視窗（例如「第六個坑」提到的、為了看清楚而點擊的 Chrome）時，那次點擊會 forward 給 Chrome，Chrome 因此拿到 OS 焦點，這之後 Esc 只會傳給 Chrome，桌寵完全收不到。修法：新增動態註冊的全域 `Escape`（`main.js` 的 `updateGlobalEscapeRegistration()`）——**只在真的有東西可以取消時才註冊**（`chatAbortControllers` 非空或 `voiceTranscribeController` 存在），沒有任何任務在跑時立刻取消註冊。不能像 F9/F10 那樣永遠註冊：`globalShortcut` 是整個作業系統層級攔截，Esc 是各種程式都在用的常見按鍵，如果桌寵永遠搶走全系統的 Esc，會讓使用者在其他程式（例如正在看的 Chrome）也按不出 Esc 該有的效果，副作用比「偶爾按 Esc 沒反應」更大——這是使用者在被問到「要接受全域搶鍵的副作用」時明確選的取捨。全域版本的處理邏輯（`handleGlobalEscape()`）跟 `chat-cancel` 共用同一套判斷順序，但一次處理所有角色（全域快捷鍵沒有「使用者按 Esc 時是針對哪個聊天框」這個上下文），多中斷到一個沒打算取消的任務，後果比「該中斷的中斷不了」小很多。

兩個問題都跟瀏覽器工具本身無關（`chat-cancel`／Esc 攔截是既有邏輯），是這次被使用者的問題逼出來、順手查出來順手修的既有缺口——跟「第五個坑」的 `err.message` 是同一種性質。

### 第七個坑的修正版：第一版全域 Escape 漏掉了「錄音」「TTS 播放」「聊天框」這幾個純 renderer 端的狀態

第一版 `handleGlobalEscape()` 只直接操作 main process 看得到的東西（`chatAbortControllers`／`claudeCliSessions`／`voiceTranscribeController`）——使用者實測後指出感覺不像有全域監聽，追查後發現這版確實不完整：`index.html` 的本地 Esc 監聽實際上處理五種狀態（依序判斷）：

1. `isRecording`（MediaRecorder 正在錄音）→ `stopRecording(true)`
2. `transcribing`（Whisper 請求進行中）→ 呼叫 `cancelTranscription`
3. `isTtsPlaying()`（回覆已經在播）→ `interruptTtsPlayback()`
4. `chatRequestPending`（等 main process 回覆）→ 呼叫 `cancelChatMessage`
5. `voiceInputActive`（點🎤後、MediaRecorder 真的開始前的空檔）→ 重置麥克風按鈕外觀

其中 1、3、5 完全活在 renderer（`MediaRecorder`、TTS 音訊播放、DOM 按鈕外觀），main process 的 `globalShortcut` handler 不管怎麼寫都碰不到——這幾個狀態的真正歸屬本來就不在主行程，不是「main.js 沒寫全」可以解決的，是原本的設計方向就不對：main process 應該負責「觸發訊號」，而不是自己重新實作一份跟 renderer 平行、遲早會兩邊不同步的判斷邏輯。

改成主行程／renderer 各司其職：

- **main process 端**：保留直接中止 `chatAbortControllers`／`claudeCliSessions`／`voiceTranscribeController` 的邏輯（涵蓋上面的狀態 2、4，而且不受「目前開著哪個聊天框」這個 renderer 概念限制，任何角色的任務都會一起中斷），同時新增 `win.webContents.send('global-escape')` 把「Escape 被按下」這件事轉送給 renderer。
- **renderer 端**：把 `document` 層級 Escape 監聽的處理邏輯抽成獨立函式 `runEscapeInterruptAction()`，本地 `keydown` 事件跟 `window.petBridge.onGlobalEscape()`（main process 轉送過來的全域事件）都呼叫同一份函式——單一事實來源，不會兩邊判斷順序（1~5 那個優先序）寫成兩份、之後改一邊忘記改另一邊。
- **`recordingActive` 狀態同步**：`hasAnyAbortableOperation()`（決定要不要保持全域 `Escape` 註冊）原本完全看不到「正在錄音」這件事——錄音期間沒有任何送到 main process 的網路請求，`chatAbortControllers`／`voiceTranscribeController` 都是空的，導致純錄音狀態下全域 Escape 根本不會被註冊。新增 `recording-active` IPC（`preload.js` 的 `notifyRecordingActive`），`index.html` 在 `isRecording` 的兩個切換點（`startRecording()`／`stopRecording()`）主動回報，main process 存成 `recordingActive` 這個變數併入判斷。
- **main process 端跟 renderer 端可能重複中止同一件事，這是刻意接受、無害的**：例如 `chatRequestPending` 的情況，main process 直接 `abort()` 了 controller，`runEscapeInterruptAction()` 之後可能又透過 `cancelChatMessage` 呼叫到 `chat-cancel`，對同一個已經中止過的 `AbortController`／`ClaudeCliSession` 再呼叫一次 `abort()`——兩者都是重複呼叫安全的（`AbortController.abort()` 本身冪等；`ClaudeCliSession.abort()` 對已經不是 `busy` 的 session 直接回傳 `false`，不會拋錯），沒有必要為了避免這個重複而加額外的協調機制。
- **沒有涵蓋的窄縫**：`voiceInputActive` 從點🎤到 `MediaRecorder` 真的開始錄音之間那段（只有 `hasApiKey`／`getMicSettings`／`getUserMedia` 這幾個本機非同步檢查）沒有對應的 main process 狀態同步——這段時間全域 Escape 可能沒有註冊。這段窗口通常只有一瞬間、使用者也還在跟麥克風按鈕互動中（不太可能這個當下已經切走焦點），先不特別處理。

## 選了「真實系統 Chrome」而不是隔離 Chromium，多出來的風險（明確記錄，不是忽略）

這是使用者在權衡「方便（能用到已登入的網站）」跟「風險（一個透過對話觸發的 agent，能操控一個帶著使用者真實身分的瀏覽器）」之後做的選擇，不是預設值、也不是圖方便帶過：

- **提示詞注入的攻擊面從「使用者自己貼的網址」擴大成「Claude 自己導覽到的任何頁面」**：ADR-0008 原本記錄的風險是「使用者貼的網址可能包含提示詞注入」；現在 Claude 可能因為完成任務而自己點連結、跳轉到使用者沒有事先看過的頁面，理論上惡意頁面的內容可能試圖影響 Claude 接下來的行為。跟 ADR-0008 的結論一致：最後一道防線仍然是「每個非唯讀操作都要經過使用者同意」，但這道防線一樣依賴使用者真的有看清楚在同意什麼。
- **操作的是使用者真實登入的帳號**：如果同意執行的操作牽涉到已登入網站的實際動作（送出表單、修改設定、刪除內容...），影響的是使用者真實帳號的狀態，不是一個用完即丟的乾淨環境。
- **`browser_evaluate` 在頁面內執行任意 JavaScript**：等同於在使用者已登入的網站上下文裡跑任意程式碼。`describeToolUse()`／`spokenToolUseSummary()` 有對這個工具做特別處理（文字泡泡完整顯示程式碼內容、TTS 不逐字念出），但沒有額外的執行限制——一樣是「使用者同意就會真的執行」。
- **`browser_run_code_unsafe` 風險等級跟 `browser_evaluate`完全不同，一開始被誤當成同一等級處理過**：Playwright MCP 官方文件對這個工具的原話是「executes arbitrary JavaScript in the Playwright server process and is RCE-equivalent」——不是跑在網頁的 JS 沙盒裡，是跑在 MCP server 的 Node.js 行程裡，風險等同（甚至可能高於）`Bash`。程式碼審查時發現第一版的 `describeToolUse()`／`spokenToolUseSummary()` 把它跟 `browser_evaluate` 用同一句「在瀏覽器裡執行程式碼」帶過，使用者可能因此低估風險、輕易同意——已修正成兩個工具各自獨立處理，`browser_run_code_unsafe` 的確認文字明講「⚠️ 在本機執行任意程式碼（風險等同 Bash）」，TTS 也明確講出「風險等同執行系統指令」，不再跟 `browser_evaluate` 共用文案。

## 沒有做的事

- 沒有幫瀏覽器操控加一個獨立的、比其他風險工具更嚴格的確認機制（例如額外的二次警告）——刻意跟現有的 `Bash`／`Write`／`Edit` 待遇一致，避免規則分散、難以維護心智模型。
- 沒有處理「使用者完全沒開 Chrome」時 `--extension` 連線失敗的情況——目前 SDK 呼叫失敗會被 `_runLoop` 的 try/catch 接住、分類成 `error` 訊息（見 `docs/specs/0006`），不會讓角色卡住，但沒有給使用者更具體的「請先打開 Chrome」提示。
- 沒有動 `page-digest.js` 或即時聊天模式的任何行為——ADR-0005 的決定原封不動。
- **`PLAYWRIGHT_MCP_EXTENSION_TOKEN` 是讀原始 OS 環境變數，沒有走 ADR-0006 定下的「機密設定存在應用程式內建設定畫面」慣例**——這台機器上這個 token 嚴格說不算「機密」（它只是拿來讓 Chrome 擴充套件辨認出是同一個已授權過的 client，外洩了頂多是別的行程也能免對話框連上這個擴充套件，前提是還要能操控這台機器上的 desktop-pet），但性質上更接近 ADR-0006 說的那種東西，之後如果要做，比較一致的做法是搬進 `settings.html`／本機設定檔，而不是留在環境變數。這次先用環境變數是因為改動範圍小、使用者當下就是要解決「對話框一直跳」這個立即問題，沒有另外開一個設定 UI。

## 相關文件

`docs/adr/0005-page-digest-scope-no-browser-automation.md`（範圍界定的原始決定，這份 ADR 記錄為什麼在 CLI 模式底下不算牴觸）、`docs/adr/0008-desktop-pet-claude-cli-mode-local-execution.md`（CLI 模式整體安全設計，務必先讀）、`docs/adr/0010-desktop-pet-cli-free-permission-mode.md`、`docs/specs/0006-desktop-pet-claude-cli-mode.md`、`docs/specs/0011-desktop-pet-cli-browser-automation.md`（這個功能的規格）。
