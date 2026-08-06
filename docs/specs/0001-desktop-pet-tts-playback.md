# desktop-pet：純語音播放（TTS，不含嘴型同步）

> **狀態**：spec 完成，尚未建立對應的 GitHub issue（這台機器沒有 `gh` CLI，見下方待辦）。
> **打算套用的 triage 標籤**：`ready-for-agent`（這個 repo 沒安裝 `triage` skill，此標籤是沿用 `/to-spec` 的預設慣例，手動建 issue 時記得加上）。

## Problem Statement (Goal)

`desktop-pet` 目前完全是「靜態」的：角色的所有話都是文字泡泡（`idle-chat.json` 寫死台詞），沒有任何聲音會從角色「嘴裡」發出來。使用者想要的「AI Live2D 桌面助理」體驗，核心差異就是角色要能真的「開口說話」，而不只是顯示文字——這是把桌寵從裝飾品變成有陪伴感助理的關鍵一步（見 CONTEXT.md「即時對話」、ADR-0002）。

目前「即時對話」（真正呼叫 LLM 產生回覆）本身還沒做，所以這份 spec 不等它——先把「給一段文字、讓角色用語音講出來」這個能力做成獨立、可重用的模組，之後「即時對話」做出來時直接呼叫它即可。

## Solution

新增一個「語音播放」能力：main process 呼叫 OpenAI TTS API 把文字轉成語音音檔，透過 IPC 把音檔資料送進桌寵視窗（renderer），用既有的 `new Audio(...)` 機制播放——這樣會自動吃到現有 🔇 靜音鈕的攔截邏輯，不用另外接線。系統匣選單新增一個「語音測試」手動觸發入口（跟現有「動作測試」同樣的 UX 慣例），在「即時對話」做出來之前就能獨立驗證這條語音管線是通的。

不做嘴型同步——角色講話時維持原本的待機動畫，只有聲音會播放。

## User Stories (Requirements)

1. As the desktop-pet 使用者，I want 角色能用語音把一段文字念出來，so that 桌寵感覺像是真的在「說話」而不是只顯示文字泡泡。
2. As the desktop-pet 使用者，I want 語音播放跟現有的 🔇 靜音鈕共用同一顆開關，so that 我不用學一套新的操作方式，靜音鈕永遠代表「桌寵安不安靜」。
3. As the desktop-pet 使用者，I want 在「即時對話」功能做出來之前，就能先手動測試語音播放能不能動，so that 我可以確認這條技術路徑是通的，不用等到整個對話功能完成才知道有沒有問題。
4. As the desktop-pet 使用者，I want 在還沒設定 OpenAI API key 的情況下觸發語音測試時，得到清楚的提示而不是程式沒反應或崩潰，so that 我知道要先去哪裡補上設定。
5. As the desktop-pet 使用者，I want 我的 OpenAI API key 能存在應用程式內、重開程式後還在，so that 我不用每次都重新輸入。
6. As the desktop-pet 使用者，I want OpenAI TTS 請求失敗（額度用完、網路問題、key 錯誤）時程式只是安靜地失敗並在終端機印出原因，so that 桌寵不會因為一次語音請求失敗就當掉或卡住。
7. As the desktop-pet 使用者，I want 角色模型還沒載入完成時觸發語音測試不會出錯，so that 我可以在啟動桌寵的過程中隨意點選單不用擔心搞壞什麼。
8. As the desktop-pet 使用者，I want 語音正在播放時再觸發一次語音測試，舊的聲音會被停掉才播新的，so that 不會聽到兩段語音疊在一起變成聽不清楚的雜音。
9. As the desktop-pet 使用者，I want 之後「即時對話」功能要接語音輸出時，能直接呼叫同一個「講出這段文字」的能力，so that 不用為了語音輸出重新設計一套機制。
10. As the desktop-pet 開發者（未來的我），I want OpenAI API key 只存在 main process、絕不進到 renderer 的 JS context，so that 就算桌寵的 renderer 頁面有 XSS 風險，金鑰也不會外洩（延續 `contextIsolation: true` 的既有安全慣例）。

## Implementation Decisions (Architecture)

- **模組邊界**：新增一個 main-process 端的模組，職責是「給文字（跟可選的 voice 參數）→ 呼叫 OpenAI TTS API → 回傳音檔 bytes，或在失敗時拋出可辨識的錯誤」。這個模組**不 import 任何 Electron API**，是純粹的網路呼叫封裝，方便獨立測試（見 Testing Decisions）。
- **API key 存放**：不用 `.env`（ADR-0006）。改成應用程式內建一個簡單的設定視窗——跟既有 `scene-editor`/`name-manager` 一樣的模式：獨立 `BrowserWindow` + 專屬 `preload.js`（`contextIsolation: true`），只曝露 `saveApiKey(key)` / `getApiKey()` 兩個 IPC 方法。Key 實際存放在本機使用者資料目錄下的一個 JSON 設定檔（Electron `app.getPath('userData')` 底下），由 main process 讀寫，不曝露檔案路徑或原始檔案存取權限給任何 renderer。系統匣選單新增「設定」項目開啟這個視窗。
- **語音請求流程**：使用者觸發「語音測試」→ main process 讀取本機存的 API key → 呼叫上述 TTS 模組 → 拿到音檔 bytes → 透過現有視窗的 `executeJavaScript`（沿用 `MOTION_ACTIONS`/`triggerMotion()` 已經在用的手法）或新增的 IPC channel，把音檔資料（base64 或 ArrayBuffer）送進 renderer → renderer 端用 `new Audio(...)` 播放（會自動被既有 `_allAudio` 靜音攔截機制接管）。
- **與現有動作觸發的差異**：`MOTION_ACTIONS` 是純 renderer 端呼叫（`call` 字串直接在 renderer 執行），語音播放不能比照辦理——TTS 需要 Node 端的網路存取跟金鑰，所以觸發流程是「main process 先做完網路請求，再把結果送進 renderer 播放」，是新的、比 `MOTION_ACTIONS` 更重一點的流程，屬於刻意的架構差異，不是疏漏。
- **L2D 就緒防呆**：沿用 `triggerMotion()` 已有的 `window._l2dReady` 檢查慣例——L2D 還沒載入完成時，語音測試安靜跳過並在終端機印警告，不彈錯誤視窗、不中止程式。
- **播放中斷/重疊控制**：新語音要播放前，先停掉（`pause()` + 從 `_allAudio` 移除或直接觸發 `ended`）目前正在播放中的舊語音，確保不會有兩段語音同時播放。
- **文字長度防呆**：OpenAI TTS API 對輸入文字有長度上限；模組層要在送出請求前檢查長度，超過上限時直接回傳明確錯誤，不送出注定失敗的請求。
- **語音音色參數化**：TTS 模組的介面預留一個可選的 `voice` 參數（OpenAI TTS 支援多種具名音色），這次先用單一預設音色；「不同角色用不同音色」是「即時對話」跟角色人設綁定時才要決定的事，不在這份 spec 範圍內（見 Out of Scope）。
- **手動測試入口**：系統匣選單「動作測試」旁新增「語音測試」子選單，內容是 1-2 組固定的測試句子（純粹用來驗證管線，不是產品功能本身）。

## Testing Decisions

- **什麼是好測試**：只測「給文字/key，打 OpenAI TTS API，回傳音檔 bytes 或拋出分類過的錯誤」這個模組對外的行為（輸入輸出契約），不測試它內部怎麼組 HTTP request；mock 網路層（fetch），不要真的打 OpenAI API。
- **測試對象（唯一 seam）**：只有上述 main-process 端、不碰 Electron API 的 TTS 呼叫模組會寫單元測試。涵蓋：成功案例（回傳音檔 bytes）、API 回傳非 200（分類成可辨識的錯誤，例如 key 無效 vs 額度用盡 vs 其他）、網路層直接 throw（連不上）、輸入文字超過長度上限時在送出請求前就回傳錯誤（不呼叫網路層）。
- **刻意不寫自動測試的部分**：Electron IPC 接線、系統匣選單、設定視窗的 UI、renderer 端 `new Audio()` 播放與靜音整合——這些是薄膠水層，用「跑起來手動驗證」取代自動測試（對應 Acceptance Criteria 逐項手動檢查）。
- **前例**：這是這個 repo（`desktop-pet` 子專案）第一個有自動測試的模組，目前完全沒有測試框架。建議只在 `desktop-pet/package.json` 加 `vitest` 作為 devDependency，不影響專案其他子系統（`multi/`、`live2d_my_like/` 等維持現狀不動）。

## Acceptance Criteria

1. 未設定 API key 時觸發「語音測試」→ 終端機印出清楚的錯誤訊息，程式不崩潰、不卡住，UI 沒有無回應的假死狀態。
2. 已設定有效 API key 時觸發「語音測試」→ 幾秒內從系統預設音訊輸出聽到語音播放。
3. 🔇 靜音狀態下觸發語音測試 → 語音正常播放流程跑完，但實際上聽不到聲音（`muted = true`），行為跟現有 `chatSounds` 音效一致。
4. 語音播放中途切換 🔇/🔊 → 正在播放中的語音立即跟著切換靜音狀態，不用等這段播完。
5. OpenAI API 請求失敗（無效 key／額度用盡／網路錯誤）→ 錯誤被記錄到終端機，Electron 主行程/桌寵視窗都不當掉，不留下卡住的 loading 狀態。
6. 送出超過 OpenAI TTS 長度上限的文字 → 在發出網路請求前就擋下並回傳明確錯誤，不會先打 API 才失敗。
7. 設定視窗輸入有效 API key 並儲存 → 完全重啟 `desktop-pet`（`npm start` 重新啟動，不只是重新整理視窗）之後，key 仍然存在、不用重新輸入。
8. 設定視窗嘗試儲存空白/純空白字元的 key → 擋下，不會把無效值寫進設定檔。
9. `window._l2dReady` 還是 `false`（角色還沒載入完）時觸發語音測試 → 安靜跳過並在終端機印警告，不彈出錯誤視窗、不中止程式，跟現有 `triggerMotion()` 對其他動作的防呆行為一致。
10. 語音播放進行中，再次觸發語音測試 → 前一段語音立即停止，只聽得到新的一段，不會兩段疊在一起。

## Edge Cases

- **API key 格式看起來有效但實際上是錯的**（例如已被撤銷）：OpenAI 會回傳 401/403，模組要能把這類錯誤跟「額度用盡」（429）、「網路完全連不上」區分開，至少在終端機訊息上能分辨，方便之後排查。
- **兩個角色（角色一/角色二）同時存在**：這份 spec 的語音測試不特別區分角色，是桌寵這個視窗整體的一個播放能力；「哪個角色講話該用哪個音色」是即時對話接上之後才要處理的事（見 Out of Scope）。
- **使用者在語音請求進行中關閉桌寵（`F10`）**：進行中的網路請求/IPC 應該不會讓程式卡在結束流程中；沒有機制存活的必要（跟「即時對話」之後可能需要的「離開前存記憶」不同，語音播放沒有需要保留的狀態）。
- **設定檔案損毀或找不到**：讀取 API key 時若設定檔不存在或內容無法解析，視同「未設定」，走 Acceptance Criteria #1 的路徑，不要讓整個桌寵啟動流程因為這個壞掉。
- **極短或空字串文字**：送空字串或純空白給語音測試，模組應直接拒絕（跟長度上限檢查同一層防呆），不要送一個空請求去打 API。
- **系統音訊輸出設備問題**（例如使用者電腦沒有作用中的輸出裝置）：這是作業系統/瀏覽器層級的行為，`new Audio().play()` 失敗時的 Promise rejection 要被接住並記錄，不要變成 unhandled rejection 讓終端機噴一堆看不懂的錯誤。

## Out of Scope

- **「即時對話」本身**（文字輸入框、呼叫 OpenAI 聊天 API、角色人設、對話記憶）——這是獨立的、更大的功能，本 spec 只做語音播放這一塊，之後即時對話做出來時，直接呼叫本 spec 產出的「講出這段文字」能力即可。
- **嘴型同步（lip sync）**——已明確排除（前次 grilling session 決策），角色講話時維持原本待機動畫。
- **語音輸入／語音辨識（STT）**——ADR-0002 已排除，本 spec 純粹是輸出。
- **依角色分別設定音色**——模組介面預留 `voice` 參數，但「哪個角色用哪個音色」的對應規則要等即時對話的角色人設功能一起決定。
- **把語音接到閒置閒聊（`idle-chat.json`）**——ADR-0004 明確排除，閒置閒聊要保持免費、不呼叫任何 API。
- **完整功能齊全的設定畫面**——只做「輸入/儲存 OpenAI API key」這一個欄位，不是一個通用的應用程式設定中心。
- **多人/發佈場景的金鑰管理**（例如金鑰加密儲存、多使用者隔離）——ADR-0006/專案定位已確認純自用，不處理。

## Further Notes

- 這份 spec 完成後，`desktop-pet` 會有三個獨立、可重用的能力可以拼裝出完整的「即時對話＋語音」體驗：閒置閒聊（既有，不動）、語音播放（本 spec）、即時對話（尚未開始，下一份 spec）。建議下一份 spec 直接命名為「即時對話」，並在 Implementation Decisions 裡直接引用本 spec 產出的「講出這段文字」模組介面，不要重新設計語音播放邏輯。
- 相關文件：`CONTEXT.md`（即時對話／角色人設／網頁摘要術語定義）、`docs/adr/0001`～`0006`（本次功能規劃的六個決策記錄）。

## 待辦：補建 GitHub Issue

這台機器沒有 `gh` CLI，尚未建立對應的 GitHub issue。日後裝好 `gh` 並登入後，可執行類似：

```bash
gh issue create \
  --repo reqw123/question \
  --title "desktop-pet：純語音播放（TTS，不含嘴型同步）" \
  --body-file docs/specs/0001-desktop-pet-tts-playback.md \
  --label ready-for-agent
```

若 `ready-for-agent` 標籤在 repo 裡還不存在，要先 `gh label create ready-for-agent`。
