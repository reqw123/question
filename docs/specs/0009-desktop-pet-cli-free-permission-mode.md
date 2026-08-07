# desktop-pet：CLI 模式免確認模式（設定畫面 opt-in 開關，跳過逐步確認）

> **狀態**：spec 完成，已實作，尚未建立對應的 GitHub issue（這台機器沒有 `gh` CLI，見文末待辦）。
> **打算套用的 triage 標籤**：`ready-for-agent`。
> **依賴**：`docs/specs/0006-desktop-pet-claude-cli-mode.md`（CLI 模式本體）、`docs/adr/0008-desktop-pet-claude-cli-mode-local-execution.md`（原始安全設計理由）、`docs/adr/0010-desktop-pet-cli-free-permission-mode.md`（為什麼願意加這個開關、取捨理由，務必先讀）。

## Problem Statement (Goal)

CLI 模式（`docs/specs/0006`）每個寫檔／執行指令等風險操作都要使用者逐句回覆「同意」才會繼續，中斷任務節奏。使用者想要一個可以跳過逐步確認的模式，但不想完全喪失「事後知道 Claude 做了什麼」的能力，也不想不小心誤開。

## Solution

在桌寵設定畫面新增一個獨立區塊「CLI 模式免確認」，提供開/關兩顆互斥按鈕：

- **關閉（預設）**：行為跟 `docs/specs/0006` 完全一樣，風險操作逐一暫停等確認。
- **開啟**：點擊後 main process 先跳原生警告對話框（`dialog.showMessageBox`），文字講清楚會拿掉哪道防線，使用者按「我了解風險，啟用」才真的存檔生效；按「取消」則維持原狀。開啟後，同一個 CLI 模式 session 裡遇到風險操作不再暫停等回覆，`canUseTool` 直接放行，但放行前會先把「做了什麼」透過角色的文字泡泡＋語音告知使用者（`onNarration`），維持事後可稽核。

設定值存在 `settings.json`（`cliFreePermissionMode`），全域共用（角色一/二不分開設定）。進入 CLI 模式時如果免確認模式是開啟的，歡迎詞會提前講清楚這件事，不用等第一個風險操作自動執行完才發現。

## User Stories (Requirements)

1. As the desktop-pet 使用者，I want 在設定畫面找到「免確認模式」開關，so that 不用改程式碼、也不用每次進 CLI 模式重講一次規則。
2. As the desktop-pet 使用者，I want 開啟前跳出清楚的警告、需要我明確點擊才生效，so that 不會手滑點到就把安全防線拿掉。
3. As the desktop-pet 使用者，I want 開啟後 Claude 還是會在文字泡泡告訴我它做了什麼，so that 就算不用逐句確認，我事後還是能知道它做過哪些操作。
4. As the desktop-pet 使用者，I want 關閉這個選項不用額外確認，so that 想收回這個風險時可以立刻退回安全預設值。
5. As the desktop-pet 使用者，I want 進入 CLI 模式時如果免確認模式是開的，角色會先提醒我，so that 不會忘記自己開著這個模式在跟角色互動。
6. As the desktop-pet 開發者（未來的我），I want 免確認模式的核心邏輯（`ClaudeCliSession` 的 `freePermissionMode`/`onNarration`）可以獨立測試，so that 這塊安全相關邏輯的正確性有自動測試把關。

## Implementation Decisions

### 為什麼不是真正的 `bypassPermissions`

見 `docs/adr/0010`。`canUseTool` callback 繼續掛著、繼續被 SDK 呼叫，只是免確認模式下不再建立 `pendingResolve` 暫停等待，而是呼叫 `onNarration(description)` 告知後直接回傳 `{ behavior: 'allow' }`。跟真正的 `permissionMode: 'bypassPermissions'`（SDK 層級整個跳過 `canUseTool`）不同，這裡呼叫端仍然攔得到每一次工具呼叫，保留事後稽核與未來加更多攔截邏輯的空間。

### `claude-cli.js` 的變動

- `ClaudeCliSession` 建構子新增 `freePermissionMode`（boolean，預設 `false`）與 `onNarration`（function，預設 no-op）兩個選項。
- `freePermissionMode` 在建構時讀一次、存成 instance 屬性，不會在同一個 session 進行中途因為外部設定改變而變動行為——要退出 CLI 模式（丟棄該 session）、重新進入才會套用新值。
- `canUseTool` 內：`SAFE_TOOLS` 判斷維持在最前面、行為不變；接著才判斷 `this.freePermissionMode`——是的話 `await this.onNarration(...)` 後直接 `allow`，不建立 `pendingResolve`、不呼叫 `this._settle`；不是的話走原本 `docs/specs/0006` 的暫停確認流程。
- `onNarration` 是 `await` 過的，確保文字泡泡在工具真的執行前更新，時序上讀起來合理；但 `onNarration` 的回傳值完全不影響是否放行（免確認模式下一定放行），跟 `pendingResolve` 那套「回傳值決定 allow/deny」的語意不同，不要混淆。
- `onNarration(text, spokenText)` 帶兩個參數，`spokenText` 是給 TTS 念的版本（見 `spokenToolUseSummary`，`Bash` 一律不念原始指令內容，其餘工具跟 `text` 相同）——這是後續補的行為，見「請 CLI 執行系統層級指令時不要把整串指令念出來」這個修正，不是這份 spec 原始範圍，但因為改的是同一個 callback 就記在這裡。

### `settings-store.js` 的變動

- `getCliFreePermissionMode()` / `setCliFreePermissionMode(enabled)`：跟其餘設定同一套「讀 `settings.json`、沒存過就回預設值」慣例。關閉時直接 `delete` 該欄位而不是存 `false`，讓「沒設定過」與「明確關閉」是同一個狀態，跟 `resetMicSettings()` 的哲學一致。

### `main.js` 整合

- `openSettings()` 的 `init` payload 新增 `cliFreePermissionMode` 欄位（兩個發送點都要改：`settingsWin` 已存在時的即時發送、`did-finish-load` 時的發送）。
- 新增 IPC handler `settings-set-cli-free-mode`：`enabled === false` 直接存檔；`enabled === true` 先跳 `dialog.showMessageBox` 警告（跟 `settings-clear-api-key`／`settings-clear-memory` 同一套二次確認手法），使用者取消回傳 `{ ok: false, cancelled: true }`，確認才真的存檔。
- 建立 `ClaudeCliSession` 的地方（`chat-send` handler 裡，session 不存在時才 new 一個）帶入 `freePermissionMode: settingsStore.getCliFreePermissionMode()` 與 `onNarration` callback，後者呼叫既有的 `logConversationTurn()` + `speakAndShow()`，跟一般 `outcome.text` 的顯示走同一條路徑，格式一致。
- 進入 CLI 模式的歡迎詞（`CLI_MODE_ENTER_PHRASES` 命中那個分支）依 `settingsStore.getCliFreePermissionMode()` 分兩種文案，免確認模式開啟時提前告知。

### `settings.html` 的變動

- 新增 `cliFreeModeSection`，維持既有 `.section-title` + `.hint` + `.btn-row` + `.msg` 版面慣例。
- 開/關兩顆按鈕沿用 `.btn-toggle`／`.btn-toggle.active` 樣式（跟 OpenAI／Ollama provider 切換同一套視覺語言），選中「開啟」代表目前是風險狀態。
- `onInit` 的 destructure 新增 `cliFreePermissionMode`，初始化按鈕選中狀態。

## Testing Decisions

- `claude-cli.test.js` 新增四個測試：免確認模式下風險操作不暫停、依序呼叫 `onNarration` 且文字正確；`SAFE_TOOLS` 在免確認模式下不觸發 `onNarration`（因為原本就不需要告知）；`onNarration` 會在工具真正放行前被 `await` 完（用非同步 narration + 執行順序陣列驗證）；沒有傳 `freePermissionMode` 時預設為關閉、行為跟舊版一致（回歸測試，確保這個新選項是純增量、不影響既有行為）。
- 沿用既有的 `makeQueryImpl` mock 手法，不用真的裝 SDK。
- **刻意不寫自動測試**：`settings-store.js` 的 `getCliFreePermissionMode`/`setCliFreePermissionMode`（純 JSON 讀寫，跟其餘 settings-store 函式同樣沒有獨立測試檔）、`main.js` 的 IPC 接線與 `dialog.showMessageBox` 二次確認流程、`settings.html` 的按鈕互動——這些跟 `docs/specs/0006` 的「薄膠水層／原生 UI 用跑起來手動驗證」是同一個決定。

## Acceptance Criteria

1. 設定畫面能看到「CLI 模式免確認」區塊，預設顯示「關閉」為選中狀態。
2. 點擊「開啟」→ 跳出原生警告對話框，說明會拿掉逐步確認這道防線。
3. 對話框按「取消」→ 設定不變，UI 維持「關閉」選中。
4. 對話框按「我了解風險，啟用」→ 設定存成開啟，UI 切換成「開啟」選中。
5. 開啟狀態下重新整理／重開設定視窗 → 開啟狀態有正確保留（讀自 `settings.json`）。
6. 點擊「關閉」→ 不跳確認對話框，立即存回關閉狀態。
7. 免確認模式開啟時進入 CLI 模式 → 歡迎詞明確提到目前是免確認狀態。
8. 免確認模式開啟時請角色做一件需要寫檔／跑指令的事 → 不會被要求回覆同意/拒絕，操作直接執行，文字泡泡顯示「⚡ 免確認模式，已自動執行：...」。
9. 免確認模式關閉時（預設或使用者關掉）→ 行為完全等同 `docs/specs/0006`，風險操作照常逐一確認。
10. 免確認模式開啟時請角色做一件只需要讀檔案的事 → 跟原本一樣不會有任何確認/自動執行的額外訊息（`SAFE_TOOLS` 不受影響）。

## Edge Cases

- **免確認模式開啟中途在設定畫面關閉**：已經在跑的 `ClaudeCliSession` 因為 `freePermissionMode` 是建構時讀一次的值，不會中途變成需要確認——這是刻意的邊界（見 Implementation Decisions），避免任務跑到一半行為突變讓使用者搞不清楚現在是哪個模式。要讓新設定生效，必須先「退出 CLI 模式」（會丟棄該 session，跟 `docs/specs/0006` 的既有 Edge Case 一致）再重新進入。
- **`onNarration` 呼叫 `speakAndShow` 失敗（例如 L2D 尚未就緒）**：目前沒有額外的錯誤處理，跟一般 `outcome.text` 顯示路徑用同一個函式、同一套錯誤容忍程度，不特別加防護。

## Out of Scope

- **per-character 的免確認模式開關**——目前是全域設定，角色一/二共用同一個值。
- **針對特定工具類型（例如只放行 `Write` 但仍暫停 `Bash`）的細粒度免確認設定**——開啟就是全部風險操作都自動放行，沒有中間選項。
- **免確認模式的使用時數/自動到期機制**——開啟後會一直維持到使用者自己去設定畫面關閉，不會逾時自動恢復確認。

## Further Notes

- 相關文件：`docs/adr/0008-desktop-pet-claude-cli-mode-local-execution.md`（原始安全設計理由）、`docs/adr/0010-desktop-pet-cli-free-permission-mode.md`（為什麼願意加這個開關、風險取捨）、`docs/specs/0006-desktop-pet-claude-cli-mode.md`（CLI 模式本體）。

## 待辦：補建 GitHub Issue

跟前幾份 spec 一樣，這台機器沒有 `gh` CLI。日後裝好並登入後：

```bash
gh issue create \
  --repo reqw123/question \
  --title "desktop-pet：CLI 模式免確認模式（設定畫面 opt-in 開關，跳過逐步確認）" \
  --body-file docs/specs/0009-desktop-pet-cli-free-permission-mode.md \
  --label ready-for-agent
```
