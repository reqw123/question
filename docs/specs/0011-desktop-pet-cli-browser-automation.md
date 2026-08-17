# desktop-pet：CLI 模式接入瀏覽器操控（Playwright MCP，系統 Chrome）

> **狀態**：spec 完成，已實作，尚未建立對應的 GitHub issue（這台機器沒有 `gh` CLI，見文末待辦）。
> **打算套用的 triage 標籤**：`ready-for-agent`。
> **依賴**：`docs/specs/0006-desktop-pet-claude-cli-mode.md`（CLI 模式本體）、`docs/adr/0012-desktop-pet-cli-browser-automation.md`（為什麼願意做、為什麼跟 ADR-0005 不算牴觸、選了系統 Chrome 而不是隔離 Chromium 的取捨）。

## Problem Statement (Goal)

CLI 模式（`docs/specs/0006`）原本只接了 `Read`／`Glob`／`Grep`／`Bash`／`Write`／`Edit` 這些本機檔案系統/程式碼執行工具，沒有任何瀏覽器相關能力。使用者在 CLI 模式下請角色「幫我上網查資料」「幫我開某個網站」時，Claude 會回覆「我沒有能力操控瀏覽器」直接拒絕，即使使用者要的其實是本機也做得到的事——CLI 模式的 Claude Agent SDK query 完全沒有接任何瀏覽器 MCP server。

## Solution

在 `claude-cli.js` 建立 SDK query 的 `options` 加上 `mcpServers: { playwright: buildPlaywrightMcpServer() }`，透過 stdio 啟動 Microsoft 官方的 `@playwright/mcp`，讓 Claude 的工具清單多出 `mcp__playwright__browser_*` 系列工具（開網頁、點擊、輸入、讀取頁面內容、執行頁面內 JS...）。這些工具沒有加進 `SAFE_TOOLS`，走既有的 `canUseTool` 確認流程，跟 `Bash`／`Write`／`Edit` 同等待遇。用 `--extension` 透過 Chrome 的「Playwright Extension」擴充套件連到使用者**本來就開著**的系統 Chrome，讓操作沿用既有登入狀態（見 ADR-0012 記錄過改用這個做法之前，`--browser chrome` + `--user-data-dir` 撞上 Chrome profile 鎖定、卡在 `about:blank` 的實測結果）。

## User Stories (Requirements)

1. As the desktop-pet 使用者，I want 在 CLI 模式下請角色幫我瀏覽/操作某個網站，so that 不用自己切到瀏覽器手動做。
2. As the desktop-pet 使用者，I want 瀏覽器操作跟寫檔案/跑指令一樣，執行前會先問我同意，so that 不會有我沒同意過的瀏覽器操作偷偷被執行（尤其牽涉到我已登入的帳號）。
3. As the desktop-pet 使用者，I want 瀏覽器操控用的是我平常在用、已經登入的 Chrome，so that 查詢需要登入才看得到的內容（例如信箱、已登入的網站）也能用。
4. As the desktop-pet 使用者，I want 確認提示裡看得懂 Claude 要開哪個網址/點什麼/輸入什麼，so that 我知道自己在同意什麼，不是一句看不懂的 JSON。
5. As the desktop-pet 使用者，I want 在執行頁面內程式碼（`browser_evaluate`）這種操作時，TTS 不要逐字念出程式碼，so that 不會聽到一長串聽不懂的內容（但文字泡泡仍完整顯示）；如果是風險等級更高的 `browser_run_code_unsafe`（等同本機任意程式碼執行），我要能從確認文字跟 TTS 就聽出來這跟一般的網頁 JS 不是同一回事。
6. As the desktop-pet 開發者（未來的我），I want 瀏覽器 MCP server 的組態邏輯是一個可以獨立測試的 pure function，so that 不用真的裝 Playwright、真的開瀏覽器就能驗證組態正確。
7. As the desktop-pet 使用者，I want 只要事先安裝好「Playwright Extension」瀏覽器擴充套件、且 Chrome 是開著的，瀏覽器操作就能直接接上我正在用的那個 Chrome，so that 不用每次用之前都先關掉手動開的 Chrome 視窗。
8. As the desktop-pet 使用者，I want 授權過 Chrome 擴充套件的連線之後不用每次用瀏覽器工具都重新授權一次，so that 不會被同一個對話框反覆打斷。
9. As the desktop-pet 使用者，I want 瀏覽器工具在跑的時候能實際看到 Chrome 分頁的畫面內容，so that 不用切成穿透模式再手動點一下才看得到（桌寵主視窗平常蓋滿螢幕又釘在最高置頂等級，見 ADR-0012「第六個坑」）。

## Implementation Decisions

### `claude-cli.js` 的新增內容

- `buildPlaywrightMcpServer()`：組出 `@playwright/mcp` 的 stdio MCP server 設定，固定是 `{ type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp', '--extension'] }`——不帶 `--browser`／`--user-data-dir`（見 ADR-0012 記錄過帶這兩個旗標自己啟動新 Chrome 行程時，撞上 profile 鎖定、卡在 `about:blank` 的實測結果），也不帶版本／`@latest`（見 ADR-0012：`npx` 遇到明確版本會每次都連 npm registry 查詢，就算本地已經裝了對應版本也一樣，等於每個 CLI 任務都多一個網路依賴）。
- `_runLoop()` 建立 SDK query `options` 時加上 `mcpServers: { playwright: buildPlaywrightMcpServer() }`——伺服器名稱固定叫 `playwright`，SDK 因此把底下工具取名成 `mcp__playwright__<動作>`。
- `describeToolUse()` 對常見的瀏覽器工具給出人看得懂的摘要：`browser_navigate`（顯示網址）、`browser_click`（顯示元素描述）、`browser_type`（顯示輸入文字＋欄位）、`browser_evaluate`（顯示頁面內 JS 程式碼，截斷到 200 字）；沒有特別處理的工具（`browser_tabs`、`browser_fill_form`...）退回既有的 JSON 摘要 fallback，或 SDK 給的 `opts.title`。
  - `browser_run_code_unsafe` **刻意跟 `browser_evaluate` 分開處理**，不共用文案：Playwright MCP 官方文件把它標記成「executes arbitrary JavaScript in the Playwright server process and is RCE-equivalent」——風險等同（甚至高於）`Bash`，不是頁面內 JS 沙盒那種等級。確認文字明講「⚠️ 在本機執行任意程式碼（風險等同 Bash）」，避免使用者誤以為只是網頁裡的小動作就隨手同意（見 ADR-0012）。
- `spokenToolUseSummary()` 比照 `Bash` 的既有規則：`browser_evaluate` 的 TTS 換成「在網頁裡執行一段 JavaScript」、`browser_run_code_unsafe` 換成「在本機執行一段任意程式碼，風險等同執行系統指令」，兩者都不逐字念程式碼，但用字刻意不同，讓風險等級的差異也反映在念出來的內容上；其餘瀏覽器工具（例如 `browser_navigate` 的網址）維持跟顯示文字一致，念出來聽得懂。
- `CLI_MODE_SYSTEM_PROMPT_APPEND` 加一段提示：告知模型有 `mcp__playwright__` 開頭的瀏覽器工具、操作的是使用者已登入的系統 Chrome、使用者要求瀏覽/查資料時預設可以直接用這些工具完成、不要用「我沒有能力操控瀏覽器」這種說法拒絕——跟既有「幫我打開小算盤」那段提示是同一種問題（模型沒有這句提示時，實測會對自己有能力做到的事直接回絕，不嘗試呼叫任何工具）。同時提醒模型涉及登入帳號／付款／刪除等操作要謹慎描述（但不影響既有的同意流程，每一步仍照常詢問）。
- `buildPlaywrightMcpServer()` 會檢查 `process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN`，有設的話把它連同完整的 `process.env` 一起傳給子行程的 `env`（見 ADR-0012「授權對話框每次 spawn 都跳」）。沒設的話 `env` 直接不設定這個欄位，子行程照常繼承目前的環境變數，行為跟這個功能加進來之前一樣。
- `buildPlaywrightMcpServer()` 固定帶 `timeout: 120000`——沒設的話卡多久是 SDK 內建、查不到確切數字的黑盒值；實測過使用者沒有及時處理 Chrome 授權對話框時 desktop-pet 只會停在「思考中」，沒有任何提示。設一個明確上限，讓最壞情況變成一個已知、會自動結束、附帶清楚錯誤訊息的等待（見 ADR-0012「第四個坑」）。
- `_runLoop` 的 catch block 把 `err.message` 改成 `err?.message ?? String(err)`——原本假設 `err` 一定是標準 `Error` 物件，SDK 丟非 Error 值時會在 catch block 裡再炸一次、`_settle()` 永遠不會被呼叫，是目前唯一找到「連 Esc 都救不回來」的卡死路徑（見 ADR-0012「第五個坑」）。這個修正跟瀏覽器工具本身無關，是既有 `_runLoop` 邏輯的既有缺口，這次審查順手查出來、順手修的。
- `ClaudeCliSession` 建構子新增 `onToolUse(toolName)` callback，`canUseTool` 一開始（在 `SAFE_TOOLS` 判斷之前）就會呼叫一次，不管最後是唯讀自動放行、免確認自動放行、還是要暫停問使用者，純粹通知「有這個工具要跑了」——`claude-cli.js` 本身不知道呼叫端會拿這個通知做什麼，維持模組跟 Electron 無關的既有設計。

### `main.js` 的新增內容（解決「瀏覽器工具在跑，Chrome 畫面卻是空白」）

- 桌寵主視窗 `win` 蓋滿整個螢幕、釘在 `'screen-saver'`（Windows 最高置頂等級，既有設計，見 `main.js:1695` 附近註解），CLI 模式叫出來的 Chrome 分頁因此永遠疊在底下——實測「互動模式」下完全看不到 Chrome 內容，要切「穿透模式」再點一下畫面空白處逼出重繪才會顯示（見 ADR-0012「第六個坑」）。
- 新增 `browserLoweredChars`（`Set<charKey>`）＋ `setBrowserToolActive(charKey, active)`：建立 `ClaudeCliSession` 時傳入 `onToolUse`，工具名稱以 `mcp__playwright__` 開頭就呼叫 `setBrowserToolActive(charKey, true)`，把 `win` 的置頂等級從 `'screen-saver'` 降到 `'normal'`；等到整個 CLI 任務收尾（`outcome.type !== 'confirm'`）才呼叫 `setBrowserToolActive(charKey, false)`，全部角色都恢復了才把 `win` 的置頂等級調回 `'screen-saver'`。用 `Set` 而不是單一 boolean，是因為角色一、角色二可能同時各自在跑瀏覽器工具。
- 恢復的時機是「整個任務收尾」而不是「這個瀏覽器工具呼叫本身執行完」——SDK 沒有給「單一工具呼叫執行完」這個粒度的訊號（`canUseTool` 只在執行**前**被呼叫），這是刻意接受的精細度妥協，見 ADR-0012「第六個坑」的說明。
- 退出 CLI 模式（`CLI_MODE_EXIT_PHRASES`）時也呼叫一次 `setBrowserToolActive(charKey, false)`，避免使用者卡在瀏覽器工具的待確認操作時直接退出，留下降級狀態沒有恢復的殘留。

### Esc 在 CLI 模式底下實際上從來沒生效過，加上穿透模式按不到（`main.js`／`preload.js`／`index.html`）

見 ADR-0012「第七個坑」及其修正版，前後三個問題：

- **`chat-cancel` 判斷順序修正**（`main.js`）：原本先查 `chatAbortControllers`（一律先命中、直接 `abort()` 一個沒接到任何東西的 controller），CLI 模式的 Esc 因此從來沒有真的呼叫過 `ClaudeCliSession.abort()`——即使桌寵視窗當下有鍵盤焦點也一樣。改成先查 `cliModeActive` 判斷是不是 CLI 模式，是的話直接找 `claudeCliSessions` 處理。
- **新增動態註冊的全域 `Escape`**（`main.js`）：`hasAnyAbortableOperation()`（`chatAbortControllers` 非空、`voiceTranscribeController` 存在、或 `recordingActive`）為真時才 `globalShortcut.register('Escape', handleGlobalEscape)`，任務結束立刻 `unregister`——在 `chatAbortControllers.set`／`.delete`、`voiceTranscribeController` 賦值/清空、`recording-active` IPC 收到通知的每個地方都呼叫 `updateGlobalEscapeRegistration()` 保持同步。**刻意不永遠註冊**：`globalShortcut` 是 OS 層級攔截，Esc 是各種程式都在用的常見按鍵，永遠註冊會讓使用者在其他程式也按不出 Esc——只在真的有任務在跑的時間窗才搶，是使用者在確認要接受「全域搶鍵」這個副作用時明確選的做法。
- **主行程／renderer 各司其職，不是全部塞進 main.js**（見 ADR-0012 修正版的說明）：`handleGlobalEscape()` 只直接處理 main process 管得到的東西（CLI 任務、一般聊天請求、語音轉錄請求），同時 `win.webContents.send('global-escape')` 通知 renderer；`preload.js` 新增 `onGlobalEscape`（main → renderer 收這個事件）跟 `notifyRecordingActive`（renderer → main 回報錄音狀態）。`index.html` 把 `document` keydown Escape 的判斷邏輯抽成 `runEscapeInterruptAction()`，本地鍵盤事件跟 `window.petBridge.onGlobalEscape()` 都呼叫同一份函式，涵蓋錄音（`MediaRecorder`）、轉錄中止、TTS 播放中斷、聊天請求取消、麥克風按鈕外觀重置這五種 renderer 端狀態；並在 `startRecording()`／`stopRecording()` 呼叫 `notifyRecordingActive()`，讓 main process 的 `hasAnyAbortableOperation()` 也能看見「純錄音、還沒有任何網路請求」這個 renderer-only 的狀態。

### 沒有改動的部分

- `SAFE_TOOLS` 維持 `['Read', 'Glob', 'Grep']`，瀏覽器工具不在其中。
- `canUseTool`／`freePermissionMode`／`interpretYesNo` 的邏輯完全沒變——瀏覽器工具只是多了一種會經過既有流程的工具類型，不是新的分支。
- `page-digest.js`、即時聊天模式的網址摘要行為不受影響（見 ADR-0012 對 ADR-0005 的範圍釐清）。
- `raiseAboveDesktopPets()`（設定畫面等小視窗用的置頂輔助函式）完全沒變——那些小視窗各自獨立呼叫 `setAlwaysOnTop('screen-saver')`，不受 `win` 本身置頂等級調整的影響。

## Testing Decisions

- `buildPlaywrightMcpServer()`：測試組出的 `command`／`args`，並明確斷言不含 `--browser`／`--user-data-dir`（鎖住「不會另外啟動新 Chrome 行程」這個決定，避免之後被改回去又踩到同一個 profile 鎖定的坑），不用真的裝 `@playwright/mcp`。額外測試 `PLAYWRIGHT_MCP_EXTENSION_TOKEN` 的 pass-through：沒設時 `env` 不存在、有設時傳進子行程的 `env`，且 `env` 是完整 `process.env` 的合併結果（不是只有那一個 key，避免 `npx` 因為缺 `PATH` 啟動失敗）——每個測試前後用 `afterEach` 還原這個環境變數，不污染其他測試。
- `ClaudeCliSession`：新增一個測試比照既有 `Bash` 暫停確認的測試案例，改用 `mcp__playwright__browser_navigate`，驗證瀏覽器工具跟其他風險工具一樣會暫停等確認、`describeToolUse` 給出的文字含網址；另一個測試驗證 `_runLoop` 傳給 `queryImpl` 的 `options.mcpServers.playwright` 等於 `buildPlaywrightMcpServer()` 的結果；另一個測試驗證 system prompt 的 append 內容含 `mcp__playwright__` 相關提示。
- `describeToolUse`／`spokenToolUseSummary`：分別對 `browser_navigate`／`browser_click`／`browser_type`／`browser_evaluate` 補單元測試，包含「TTS 不逐字念程式碼、但網址正常念」這條規則。
- `buildPlaywrightMcpServer().timeout` 斷言等於 `120000`，鎖住「一定要有明確逾時」這個決定。
- `_runLoop` 丟非 Error 值（`throw null`）時，斷言 `session.start()` 真的會 resolve（不會卡住）、`busy` 回到 `false`、`abort()` 回傳 `false`（代表狀態一致，沒有殘留）——這個測試本身如果卡住不動，vitest 逾時失敗就是防護退化的訊號。
- `onToolUse`：測試每個工具呼叫（包含自動放行的 `SAFE_TOOLS`）都會收到一次通知，順序正確；省略這個 callback 時不能拋錯（預設 no-op）。
- **`main.js` 的 `setBrowserToolActive()`／視窗置頂邏輯、全域 Escape 註冊/取消註冊、`chat-cancel` 判斷順序、`index.html` 的 `runEscapeInterruptAction()`／`recording-active` 通知，都刻意不寫自動測試**——跟既有「`main.js` 的觸發短語比對／CLI 模式狀態切換是薄膠水層，用跑起來手動驗證取代」的慣例一致（見 `docs/specs/0006`），這些都需要真的有 Electron `BrowserWindow`／`globalShortcut`／`MediaRecorder` 才能驗證，用手動測試取代。這也是這次 Esc 兩輪問題（`chat-cancel` 判斷順序、全域 Escape 漏掉 renderer 狀態）都沒有自動測試能攔住、得靠使用者實測回報才發現的原因——記錄下來，不是忽略這塊測試缺口，只是跟既有慣例一致的已知取捨。
- **刻意不寫的測試**：真的啟動 `@playwright/mcp`、真的開瀏覽器的端對端測試——跟 `queryImpl` mock 整體測試哲學一致，這塊只驗證組態/邏輯正確，不驗證 Playwright MCP 本身的行為（那是它自己的套件責任）。

## Acceptance Criteria

1. CLI 模式下請角色「幫我開某個網址／查資料」→ 角色描述要開哪個網址、問同意/拒絕，不會回覆「我沒有能力操控瀏覽器」。
2. 事先裝好「Playwright Extension」且 Chrome 開著時，回覆「同意」→ 使用者本來就開著的 Chrome 真的開啟該網址（沿用既有登入狀態），任務繼續。
3. 牽涉到點擊、輸入、執行頁面程式碼的操作，一律先問過使用者才執行，跟 `Bash`／`Write` 待遇一致。
4. 確認提示的文字泡泡看得懂在做什麼（網址／點擊目標／輸入內容），不是原始 JSON。
5. `browser_evaluate`／`browser_run_code_unsafe`：文字泡泡顯示完整程式碼，TTS 不逐字念；`browser_run_code_unsafe` 的文字泡泡與 TTS 都明確講出「風險等同 Bash／執行系統指令」，不會跟 `browser_evaluate` 用同一句話帶過。
6. 設好 `PLAYWRIGHT_MCP_EXTENSION_TOKEN` 環境變數並對該 token 授權過一次之後，同一次桌寵啟動期間再用瀏覽器工具，Chrome 不會重新跳出授權對話框。
7. CLI 模式跑瀏覽器工具期間，不管桌寵目前是互動模式還是穿透模式，Chrome 分頁的畫面內容都看得到，不用切換模式或手動點擊才顯示；任務結束後桌寵視窗恢復原本「點別的視窗也不會被蓋住」的置頂行為。
8. CLI 任務執行中（含暫停等確認）按 Esc → 任務真的被中止（`ClaudeCliSession.abort()` 有被呼叫到，不是對一個沒人接的 controller 呼叫），不管桌寵視窗當下有沒有 OS 鍵盤焦點都一樣有效；沒有任何任務在跑時，Esc 在其他程式（例如 Chrome）裡的行為不受影響。
9. 錄音中／轉錄中／回覆播放中（文字泡泡＋TTS）這三種情境，即使桌寵視窗當下沒有 OS 鍵盤焦點（例如穿透模式點擊到其他視窗之後），按 Esc 都能正確中斷，行為跟桌寵視窗有焦點時一致。

## Edge Cases

- **使用者完全沒開 Chrome（`chrome.exe` 沒有任何行程）**：`--extension` 模式連不到任何瀏覽器，SDK 呼叫會失敗，`_runLoop` 的既有 try/catch 分類成 `error` 訊息回報給使用者，不會卡在「思考中」（見 `docs/specs/0006`），但目前沒有更具體的「請先打開 Chrome」提示——使用者要自己從錯誤訊息推斷。
- **使用者還沒安裝「Playwright Extension」擴充套件**：`--extension` 連線失敗，行為跟上一條一樣分類成 `error`。
- **Claude 自己導覽到使用者沒看過的頁面，頁面內容可能是提示詞注入**：跟 ADR-0008 對 `page-digest.js` 的既有結論一致，最後防線是每個非唯讀操作都要經過確認，不做額外的內容過濾。
- **沒有設定 `PLAYWRIGHT_MCP_EXTENSION_TOKEN` 時**：每次 spawn `@playwright/mcp` 都是新的隨機 token，Chrome 的授權對話框會每次用瀏覽器工具都跳出來一次——這是預期行為，不是 bug，只是不方便；要避免的話使用者要自己設定固定 token（見 ADR-0012）。
- **使用者沒有及時處理 Chrome 那邊跳出的授權對話框／分頁選擇畫面**：desktop-pet 停在「思考中」，最多等到 `timeout`（120 秒）就會自動變成一則 `error` 訊息，不會卡住不回應；但 desktop-pet 這邊沒有辦法主動提示「Chrome 那邊有東西在等你」（那是 Chrome 擴充套件自己的 UI，接觸不到）。
- **角色一、角色二同時在 CLI 模式跑瀏覽器工具**：`browserLoweredChars` 是共用的 `Set`，任一角色還在跑，桌寵視窗就維持降級狀態；兩個角色都結束才恢復——不會出現一個角色的任務結束就提早把置頂等級調回去、蓋住另一個角色還在用的 Chrome 分頁的情況。
- **同一個 CLI 任務裡連續好幾輪瀏覽器操作，中間夾雜非瀏覽器工具的確認**：桌寵視窗會維持降級狀態直到整個任務收尾，不會每個瀏覽器工具呼叫結束就恢復、下一個瀏覽器工具呼叫又重新降級一次——見 ADR-0012「第六個坑」對這個精細度取捨的說明。

## Out of Scope

- **獨立於既有 `Bash`／`Write` 的、更嚴格的瀏覽器操作確認機制**——刻意跟現有風險工具同等待遇。
- **偵測「Chrome 沒開」或「擴充套件沒裝」並給出對應的清楚錯誤訊息**——目前統一走既有的通用 `error` 分類，沒有針對這兩種情況客製化文字。
- **即時聊天模式／`page-digest.js` 的任何變動**——這個功能只接在 CLI 模式底下。
- **免確認模式（ADR-0010）針對瀏覽器工具的額外處理**——沿用既有規則（自動放行＋事後 `onNarration` 告知），不特別加碼。
- **`PLAYWRIGHT_MCP_EXTENSION_TOKEN` 的設定 UI**——目前要使用者自己去 Windows 環境變數設定，沒有做成 `settings.html` 裡的欄位（ADR-0006 定的慣例是機密設定走應用程式內建設定畫面，這裡先不做，見 ADR-0012「沒有做的事」）。

## Further Notes

- 相關文件：`docs/adr/0012-desktop-pet-cli-browser-automation.md`（安全設計理由與取捨，務必先讀這份再改這塊邏輯）、`docs/adr/0005-page-digest-scope-no-browser-automation.md`、`docs/specs/0006-desktop-pet-claude-cli-mode.md`。

## 待辦：補建 GitHub Issue

跟前幾份 spec 一樣，這台機器沒有 `gh` CLI。日後裝好並登入後：

```bash
gh issue create \
  --repo reqw123/question \
  --title "desktop-pet：CLI 模式接入瀏覽器操控（Playwright MCP，系統 Chrome）" \
  --body-file docs/specs/0011-desktop-pet-cli-browser-automation.md \
  --label ready-for-agent
```
