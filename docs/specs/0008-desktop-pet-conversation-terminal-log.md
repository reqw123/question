# desktop-pet：每輪即時對話印到終端機

> **狀態**：spec 完成，已實作，尚未建立對應的 GitHub issue（這台機器沒有 `gh` CLI，見文末待辦）。
> **打算套用的 triage 標籤**：`ready-for-agent`。
> **依賴**：`docs/specs/0002-desktop-pet-live-chat.md`（一般聊天）、`docs/specs/0005-desktop-pet-ollama-provider.md`（Ollama provider）、`docs/specs/0006-desktop-pet-claude-cli-mode.md`（CLI 模式）——這三種「即時對話」都經過同一個 `chat-send` handler，這份 spec 統一補上終端機記錄。

## Problem Statement (Goal)

即時對話目前沒有任何地方看得到完整的對話紀錄——文字泡泡秀完就消失，`chatMemoryStore` 存的檔案要自己去找路徑打開看。使用者想要每一輪對話（自己說了什麼、角色回了什麼）直接印在跑 `npm start` 的終端機視窗上，方便直接盯著看。

## Solution

新增 `logConversationTurn(charKey, label, userMessage, replyText)`，在 `chat-send` 裡每一個會產生回覆的分支（一般聊天的 OpenAI/Ollama、CLI 模式的進入/離開/確認/任務結果）結束時都呼叫一次，統一印到終端機（`console.log`，跟現有「未預期錯誤都印到終端機」是同一個習慣）。

## Implementation Decisions

- 格式：`[desktop-pet] <角色名>對話（<provider/模式標籤>）\n  你：<使用者訊息>\n  <角色名>：<回覆內容>`——`<provider/模式標籤>` 是 `OpenAI`／`Ollama`／`CLI 模式` 三種之一，方便一眼看出這輪走的是哪條路徑。
- 角色名沿用既有的 `CHAR_LABEL`（`{ c1: '角色一', c2: '角色二' }`，跟清空記憶確認對話框用的是同一份對照表）。
- **涵蓋所有「即時對話」路徑**，不只是成功產生回覆的那種：CLI 模式的進入/離開確認訊息、聽不懂同意/拒絕要求重講的提示，全部算進去——使用者要的是「每次」的對話內容，不是只挑重要的印。
- 純粹印出，**不寫檔、不影響任何既有邏輯**（`chatMemoryStore` 的記憶存檔、`speakAndShow` 的泡泡/語音都完全不受影響，這只是額外加一行 log）。
- 失敗的請求（例如聊天 API 呼叫失敗、缺 API key）不會走到這個 log——那些分支本來就直接 `return { ok: false, error }`，沒有真正的回覆內容可以印；錯誤本身已經有自己的 `console.error`（見既有的語音合成失敗處理），不重複記錄。

## Testing Decisions

- **刻意不寫自動測試**：純粹一行 `console.log` 組字串，跟這個 handler 其餘薄膠水層邏輯（觸發短語比對、CLI 模式狀態切換）同一等級，用跑起來手動驗證取代。

## Acceptance Criteria

1. 對角色一送出一句一般聊天訊息並收到回覆 → 終端機印出這一輪的使用者訊息跟角色回覆，標籤顯示目前生效的 provider（OpenAI 或 Ollama）。
2. 對角色二重複第 1 點 → 終端機印出的角色名稱正確是「角色二」，跟角色一的紀錄不會混在一起搞混是誰說的。
3. 進入 CLI 模式、交代一個任務、同意一個風險操作、任務完成、退出 CLI 模式 → 終端機依序印出這五輪的內容，標籤都是「CLI 模式」。
4. 聊天 API 呼叫失敗（例如 key 錯誤）→ 終端機不會印出一輪不完整/空白的對話紀錄，只會看到原本就有的錯誤訊息。

## Out of Scope

- **把終端機記錄寫成檔案／log rotation**——只印到終端機，不落地存檔。
- **在畫面上另外顯示對話紀錄面板**——只印到終端機，不是新增 UI。

## 待辦：補建 GitHub Issue

跟前幾份 spec 一樣，這台機器沒有 `gh` CLI。日後裝好並登入後：

```bash
gh issue create \
  --repo reqw123/question \
  --title "desktop-pet：每輪即時對話印到終端機" \
  --body-file docs/specs/0008-desktop-pet-conversation-terminal-log.md \
  --label ready-for-agent
```
