# desktop-pet：CLI 模式（對話觸發 Claude Code 執行本機任務，逐步確認風險操作）

> **狀態**：spec 完成，已實作，尚未建立對應的 GitHub issue（這台機器沒有 `gh` CLI，見文末待辦）。
> **打算套用的 triage 標籤**：`ready-for-agent`。
> **依賴**：`docs/specs/0002-desktop-pet-live-chat.md`（即時對話原本的訊息路由）、`docs/specs/0004-desktop-pet-voice-input.md`（沿用其點擊錄音/打字流程，不新增背景常駐麥克風）、`docs/adr/0008-desktop-pet-claude-cli-mode-local-execution.md`（為什麼願意做這個高風險功能、安全設計理由）。

## Problem Statement (Goal)

桌寵目前的對話只能生成文字（OpenAI 或 Ollama），沒辦法真的做事。使用者想要一個更方便的入口，透過跟角色聊天觸發 Claude Code 在本機專案目錄執行實際任務（讀寫檔案、跑指令），不用切到終端機。

## Solution

在既有的點擊錄音/打字對話流程裡加一個「觸發短語」機制：對話中說/打「進入 CLI 模式」，該角色接下來的每一則訊息都改送去 Claude Agent SDK（`@anthropic-ai/claude-agent-sdk`）在固定的工作目錄（`C:\question`）執行；遇到讀檔案以外的操作（`Bash`／`Write`／`Edit`／`WebFetch`...）一律暫停，透過角色的文字泡泡＋語音問使用者同意/拒絕，收到明確同意才繼續。說「退出 CLI 模式」回到一般聊天。

## User Stories (Requirements)

1. As the desktop-pet 使用者，I want 跟角色說「進入 CLI 模式」，so that 不用切視窗、直接透過聊天觸發 Claude Code 做事。
2. As the desktop-pet 使用者，I want 交代任務後，角色遇到要寫檔案/跑指令這種有風險的操作會先問我，so that 不會有我沒同意過的操作偷偷被執行。
3. As the desktop-pet 使用者，I want 角色讀檔案、搜尋這種唯讀操作不用每次都問我，so that 不會為了雞毛蒜皮的事一直被打斷。
4. As the desktop-pet 使用者，I want 明確回覆「同意」或「拒絕」來決定要不要放行，so that 我清楚知道自己在同意什麼。
5. As the desktop-pet 使用者，I want 回覆模稜兩可時角色會請我講清楚，而不是自己亂猜，so that 不會因為語音辨識/我表達不清楚而誤放行一個我不同意的操作。
6. As the desktop-pet 使用者，I want 同一次 CLI 模式裡問第二個任務時，角色記得前一個任務的上下文，so that 不用每次都重講一次背景。
7. As the desktop-pet 使用者，I want 說「退出 CLI 模式」回到一般聊天，so that 不會不小心一直處於「會執行指令」的狀態。
8. As the desktop-pet 使用者，I want 沒開始/沒登入 Claude Code 時得到清楚的錯誤訊息，so that 我知道要先做什麼才能用這個功能。
9. As the desktop-pet 開發者（未來的我），I want CLI 任務的執行邏輯是一個可以獨立測試的模組、不用真的裝 SDK 或連上 Claude 就能測，so that 這塊高風險邏輯的正確性有自動測試把關，不是只能手動驗證。

## Implementation Decisions

### 為什麼是「觸發短語」不是真正的語音喚醒詞

見 ADR-0008。`docs/specs/0004` 已經因為聲學回授/幻覺輸入的問題拿掉過一次持續語音模式，真正的 always-listening 喚醒詞需要重新引入同一套背景常駐麥克風架構，風險/複雜度不成比例。改成沿用既有的「點 🎤 或打字」流程，訊息內容剛好是觸發短語就切換模式——不需要改動語音輸入的任何架構。

### 新模組 `claude-cli.js`（測試 seam）

- `ClaudeCliSession` class：一個 instance 代表「一次 CLI 模式對話」的狀態機，橫跨可能好幾輪的確認/任務。
  - `start(prompt) → Promise<{ type, text }>`：開始新任務，回傳值在**下一個該讓使用者看到的時間點**才 resolve（可能是需要確認、也可能是任務直接做完了），不會整個等到任務全部結束——任務可能要跑很久。
  - `resolveConfirmation(allow) → Promise<{ type, text }>`：使用者回覆同意/拒絕待確認的操作，恢復執行到下一個暫停點。
  - `hasPendingConfirmation`：目前是否有操作在等使用者回覆。
- 核心機制：SDK 的 `canUseTool` 是一個 async callback，SDK 會等它 resolve 才繼續往下執行/生成下一則訊息——用這個特性把「有風險的操作」暫停下來，等桌寵這邊的使用者用聊天回覆同意/拒絕，再把結果餵回去，不用自己重新發明一套暫停/恢復機制。
- 只有 `Read`／`Glob`／`Grep` 這三個唯讀工具透過 `allowedTools` 自動放行，其餘一律經過 `canUseTool` 問過使用者才執行——`permissionMode: 'default'`，不用 `bypassPermissions`（見 ADR-0008）。
- 每個任務結束後把 SDK 回傳的 `session_id` 記下來，同一個 `ClaudeCliSession` instance 裡的下一個任務用 `resume: sessionId` 延續同一個對話（User Story 6）。
- `queryImpl` 可注入（預設才 `require('@anthropic-ai/claude-agent-sdk')` 的 `query`，且是延遲載入，模組載入時不用真的裝這個套件）——跟 `chat.js`/`tts.js`/`stt.js`/`ollama.js` 的 `fetchImpl` 是同一種測試 seam 手法，測試時整個用假的 async generator 取代，不用真的連上 Claude。
- `interpretYesNo(message)`：寬鬆比對常見的同意/拒絕講法（中英文），否定詞（不同意/不可以...）一定排在肯定詞前面比對，避免「不可以」因為含有「可以」被誤判成同意；看不懂回傳 `null`，呼叫端要求使用者換句話說（User Story 5），絕不在含糊時偷偷當同意。
- `describeToolUse(toolName, input, opts)`：把 `canUseTool` 收到的工具呼叫轉成人看得懂的一句話，優先用 SDK 自己組好的 `opts.title`（例如「Claude wants to read foo.txt」），沒有的話對 `Bash`/`Write`/`Edit` 給出重點摘要，其餘工具退回精簡過的 JSON。
- `spokenToolUseSummary(toolName, description)`：`describeToolUse()` 的 TTS 專用版本。`Bash` 的 `description` 常常整串是原始 shell 語法（旗標、管線、路徑符號），逐字念出來使用者聽不懂也不想聽，一律換成通用一句「執行一個系統指令」；文字泡泡（`text`）仍然顯示 `describeToolUse()` 的完整內容，只有 TTS 念的內容（`spokenText`）改用這個函式的結果，確保使用者同意/拒絕前一樣能在畫面上看到完整指令。`main.js` 的 `speakAndShow(charKey, text, { spokenText })` 支援兩者分開；省略 `spokenText` 時行為跟原本一樣。

### `main.js` 整合（薄膠水層）

- 觸發短語判斷（`normalizeTriggerPhrase()`：去空白、轉小寫）跟一般聊天完全分開，在 `chat-send` 一開頭就處理，不呼叫 OpenAI/Ollama、不檢查 API key，訊息也不寫進 `chatMemoryStore`（CLI 任務的技術性輸出跟角色的聊天記憶混在一起沒有意義，也可能塞爆記憶檔案）。
- `cliModeActive`（`Set<charKey>`）＋`claudeCliSessions`（`Map<charKey, ClaudeCliSession>`）：每個角色各自獨立，角色一在 CLI 模式不影響角色二。
- CLI 模式下收到訊息：有待確認的操作 → 送去 `interpretYesNo()` 判斷同意/拒絕；沒有待確認的操作 → 當作新任務的 prompt 呼叫 `session.start()`。
- 工作目錄固定 `path.join(__dirname, '..')`（即 `C:\question`，整個 repo 根目錄）——跟這台機器上跑 Claude Code 的目錄一致。目前沒有開放設定畫面調整（見 Out of Scope）。

## Testing Decisions

- `claude-cli.js` 的 `ClaudeCliSession`／`interpretYesNo`／`describeToolUse` 是這份 spec 的核心測試對象：安全工具自動放行不暫停、風險工具暫停等確認、同意後恢復執行、拒絕後 `deny` 有正確傳給 SDK、同一任務多輪確認、`busy` 期間拒絕重複啟動、沒有待確認操作時 `resolveConfirmation` 回錯誤、SDK 拋例外時分類成 error 且解除 `busy`、`session_id` 在同一 session 內的下一個任務有正確帶上 `resume`。
- `interpretYesNo` 額外測「不可以/不同意」不會因為含有「可以/同意」子字串被誤判、純英文詞用詞界比對不會誤中「know」這種剛好含 "no" 子字串的訊息、含糊訊息回傳 `null` 不亂猜。
- 用 `queryImpl` mock（手動實作的 async generator，內部照著真實 SDK 的協定呼叫 `options.canUseTool`）取代真的裝 SDK／連上 Claude，跟其餘模組的 `fetchImpl` mock 同一套哲學。
- **刻意不寫自動測試**：`main.js` 的觸發短語比對／CLI 模式狀態切換／IPC 接線——薄膠水層，用跑起來手動驗證取代。

## Acceptance Criteria

1. 對角色說「進入 CLI 模式」→ 角色回覆確認已進入、告知工作目錄與離開方式。
2. CLI 模式下請角色做一件只需要讀檔案的事 → 直接得到結果，中途不會被要求確認。
3. CLI 模式下請角色做一件需要寫檔案或跑指令的事 → 角色先描述要做什麼操作、問同意/拒絕，不會沒問過就執行。
4. 回覆「同意」→ 操作真的被執行，任務繼續進行到下一個暫停點或結束。
5. 回覆「拒絕」→ 操作沒有被執行，Claude 收到「使用者拒絕」的訊息並據此調整（例如改用其他做法、或告知使用者無法繼續）。
6. 回覆一句跟同意/拒絕無關的話（例如「今天天氣不錯」）→ 角色要求明確回覆同意或拒絕，不會自己亂猜。
7. 同一次 CLI 模式裡問完一個任務、再問第二個相關的任務 → 角色記得前一個任務的上下文。
8. 說「退出 CLI 模式」→ 角色確認已退出，之後的訊息回到一般聊天（OpenAI/Ollama），不會再被送去執行。
9. 角色一進入 CLI 模式，角色二仍是一般聊天狀態，兩者互不影響。
10. 這台機器沒有登入 Claude Code / SDK 呼叫失敗 → 角色回覆清楚的錯誤訊息，不會卡在「思考中」不回應。

## Edge Cases

- **CLI 任務還沒結束（或還在等確認）時，使用者對同一個角色送出新訊息**：`ClaudeCliSession.start()` 在 `busy` 期間會拒絕開新任務，回傳清楚的「上一個任務還在跑」訊息，不會兩個任務併發把狀態搞亂。
- **使用者在等確認時說了跟同意/拒絕無關的話**：`interpretYesNo()` 回傳 `null`，角色要求換句話說，不會把這句話誤當成新任務的 prompt（也不會誤當同意）。
- **`page-digest.js` 網址內容注入**：見 ADR-0008——CLI 模式下貼網址一樣會被當成一般聊天訊息處理（目前沒有特殊的 URL 偵測/摘要邏輯接進 CLI 模式，直接整句送給 Claude 當 prompt），最終防線是任何非唯讀操作都還是要經過確認。
- **退出 CLI 模式時還有半途的任務/待確認操作**：直接整個丟棄該角色的 `ClaudeCliSession`（`claudeCliSessions.delete(charKey)`），不留著跨模式的殘留狀態；使用者要繼續的話得重新進入 CLI 模式、重講一次任務。
- **SDK 呼叫本身拋出例外（例如沒有登入、網路問題）**：`_runLoop` 的 try/catch 接住，回傳分類過的 error 訊息並解除 `busy` 狀態，不會讓角色卡住。

## Out of Scope

- **真正的語音喚醒詞（背景常駐麥克風偵測）**——見 ADR-0008，這次刻意不做。
- **CLI 模式工作目錄的設定畫面**——目前固定在 `C:\question`，改路徑要改程式碼常數。
- **CLI 模式下的網頁摘要特殊處理**——沿用一般訊息直接當 prompt 送出，不像一般聊天那樣有 URL 偵測/摘要（見 Edge Cases，這是已知但刻意先不擋的簡化）。
- **對話記憶（`chatMemoryStore`）記錄 CLI 任務內容**——CLI 模式的訊息不寫進角色的聊天記憶。
- **額外的沙盒/目錄權限限制（`additionalDirectories` 之外的邊界）**——完全依賴 Claude Code 本身的邊界。

## Further Notes

- `claude-cli.js` 的模組介面（可注入的 `queryImpl`、分類過的回傳型別）刻意跟本 repo 其餘「呼叫外部能力」的模組一致，方便之後比對/除錯。
- 相關文件：`docs/adr/0008-desktop-pet-claude-cli-mode-local-execution.md`（安全設計理由，務必先讀這份再改這塊邏輯）、`docs/specs/0002-desktop-pet-live-chat.md`、`docs/specs/0004-desktop-pet-voice-input.md`。

## 待辦：補建 GitHub Issue

跟前幾份 spec 一樣，這台機器沒有 `gh` CLI。日後裝好並登入後：

```bash
gh issue create \
  --repo reqw123/question \
  --title "desktop-pet：CLI 模式（對話觸發 Claude Code 執行本機任務，逐步確認風險操作）" \
  --body-file docs/specs/0006-desktop-pet-claude-cli-mode.md \
  --label ready-for-agent
```
