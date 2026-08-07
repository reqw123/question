# desktop-pet：即時對話新增 Ollama 本機 provider（可選，預設仍 OpenAI）

> **狀態**：spec 完成，已實作，尚未建立對應的 GitHub issue（這台機器沒有 `gh` CLI，見文末待辦）。
> **打算套用的 triage 標籤**：`ready-for-agent`。
> **依賴**：`docs/specs/0002-desktop-pet-live-chat.md`（即時對話原本的 OpenAI 呼叫流程）、`docs/adr/0001-openai-for-live-chat.md`（本 spec 推翻其中「不做本地模型備援」的部分，見該 ADR 的更新段落）。

## Problem Statement (Goal)

即時對話目前唯一的 provider 是 OpenAI，使用者必須有 API key、每次呼叫都要花額度、也一定要連得到外網。使用者想加一個本機 Ollama（`qwen2.5:3b`/`qwen2.5:7b`）選項，在乎離線／免費／隱私的情境可以自己切過去用，但不想因此失去 OpenAI 這個品質較好的預設路徑。

## Solution

設定畫面新增「即時對話 AI 提供者」區塊：OpenAI／Ollama 本機兩個切換鈕，預設 OpenAI（跟推出前行為一致，不影響既有使用者）。選 Ollama 之後才需要填 Base URL（預設 `http://localhost:11434`）跟模型名稱（預設 `qwen2.5:7b`，可自行改成 `qwen2.5:3b` 等其他已下載的模型），並提供「測試連線」按鈕列出這台 Ollama 已下載的模型清單。`chat-send` 的 main process 端流程（人設、記憶、網頁摘要、語音輸出）完全不變，只有「呼叫哪個 API 產生回覆文字」這一步依設定分流。

## User Stories (Requirements)

1. As the desktop-pet 使用者，I want 在設定畫面把即時對話切換成本機 Ollama，so that 不用付 OpenAI 額度也能跟角色聊天。
2. As the desktop-pet 使用者，I want 切換到 Ollama 之後可以自訂 Base URL 跟模型名稱，so that 我可以指到區網內其他機器跑的 Ollama，或換成 `qwen2.5:3b`／其他我已經 pull 好的模型。
3. As the desktop-pet 使用者，I want 按「測試連線」看到這台 Ollama 目前有哪些已下載的模型，so that 我不用自己去終端機打 `ollama list` 再手動抄名字。
4. As the desktop-pet 使用者，I want 沒改設定的話即時對話行為完全不變（還是 OpenAI），so that 這個新功能不會在我不知情的狀況下換掉我原本在用的東西。
5. As the desktop-pet 使用者，I want 選了 Ollama 之後就不再需要 OpenAI API key 才能聊天，so that 我可以在完全沒有 OpenAI key 的情況下使用即時對話。
6. As the desktop-pet 使用者，I want Ollama 沒有在跑／指定的模型沒下載時得到清楚的錯誤訊息，so that 我知道具體要做什麼（開 Ollama、`ollama pull <model>`）而不是對著沒反應的角色乾等。
7. As the desktop-pet 開發者（未來的我），I want Ollama 的呼叫邏輯跟 OpenAI 的 `chat.js` 是同一種模組介面形狀，so that 之後要加第三個 provider 可以直接照抄，不用重新設計錯誤分類。

## Implementation Decisions

### 新模組 `ollama.js`（測試 seam，跟 `chat.js` 同一種介面形狀）

- `sendOllamaChatMessage({ message, systemPrompt, history, model, baseUrl, fetchImpl? }) → Promise<{ reply }>`，失敗拋出分類過的 `OllamaError`（`code`：`INVALID_INPUT`/`NETWORK_ERROR`/`MODEL_NOT_FOUND`（404）/`API_ERROR`/`EMPTY_REPLY`）。
- `listOllamaModels({ baseUrl, fetchImpl? }) → Promise<{ models: string[] }>`，設定畫面「測試連線」用。
- 打的是 Ollama **原生** `/api/chat`（`stream:false`），不是 OpenAI 相容的 `/v1/chat/completions`——跟 `ai-quiz-generator/index.html` 既有的 `callOllama()` 是同一個端點/約定，兩處除錯經驗互通。
- 這裡的呼叫全部發生在 **main process**（Node），不是瀏覽器 fetch，所以不會撞到 `ai-quiz-generator` 那邊使用者要另外設定 `OLLAMA_ORIGINS=*` 才能繞過 CORS 405 的問題——這是這次選擇「main process 呼叫」而不是「renderer 直接呼叫」的主要理由。

### 設定存放（`settings-store.js`）

- `getChatProviderSettings()` / `saveChatProviderSettings()`：存 `chatProvider`（`'openai'`｜`'ollama'`，預設 `openai`）、`ollamaBaseUrl`（預設 `http://localhost:11434`）、`ollamaModel`（預設 `qwen2.5:7b`）到跟 API key／麥克風門檻同一份 `settings.json`。
- 選 Ollama 時 Base URL／模型名稱不能是空白（存檔前擋下，不是等聊天送出去才失敗）；選 OpenAI 時不檢查這兩欄，維持原本的 `openaiApiKey` 設定不受影響。

### `chat-send` 流程分流（`main.js`，薄膠水層）

- 原本「沒 API key 直接擋下」的檢查改成只在 `provider === 'openai'` 時才做——選 Ollama 的使用者完全不需要碰到 OpenAI key。
- 人設、對話記憶、網址偵測/摘要、語音輸出（TTS）、記憶寫入全部沿用 `0002` spec 既有流程不變；只有「呼叫 `chat.js` 還是 `ollama.js` 取得回覆文字」這一步依 `getChatProviderSettings().provider` 分流，兩邊都回傳同一種 `{ reply }` 形狀，下游不用知道换過 provider。
- 語音輸入（Whisper STT）、語音輸出（OpenAI TTS）**不受影響**，繼續固定用 OpenAI——這次只換「文字對話生成」這一段（見 ADR-0001 更新段落，STT/TTS 沒有被這次決定波及）。

### 設定畫面 UI（`settings.html`）

- OpenAI／Ollama 本機兩個切換鈕（互斥，選中套用 `.btn-toggle.active` 青色實心樣式），選 Ollama 才展開 Base URL／模型名稱欄位。
- 「測試連線」呼叫 main process 的 `settings-test-ollama` IPC（實際打 `/api/tags`），成功後把模型清單塞進 `<datalist>` 給模型名稱欄位當自動完成建議，不強制只能選清單裡的（使用者可以手動輸入還沒被抓到的模型名稱）。
- 沿用既有的「存檔訊息顯示在下方 `.msg`」模式，沒有二次確認對話框——切換 provider／改 Ollama 位址是可逆操作，跟清除 API key／記憶不同。

## Testing Decisions

- 沿用 `0001`/`0002` spec 的測試哲學：只測「不碰 Electron API 的純函式模組」對外的輸入輸出契約，mock 網路層，不真的打本機 Ollama。
- `ollama.js` 的 `sendOllamaChatMessage()`／`listOllamaModels()`／`normalizeOllamaUrl()`——成功案例、404（模型未下載，訊息帶 `ollama pull <model>` 指令）、其他非 200、網路層 throw（`Ollama 沒開`最常見的樣子）、空白訊息/model/baseUrl 在送出前被擋下、空回覆當錯誤處理、URL 正規化（裸 `host:port`、結尾斜線、`https` 原樣保留）。跟 `chat.js`/`stt.js` 的測試案例是同一套模式。
- **刻意不寫自動測試**：`settings-store.js` 的 provider 存取（跟既有 mic 設定同等級，需要 Electron `app.getPath`）、`settings.html` 的切換鈕 UI／IPC 接線、`main.js` 的 `chat-send` 分流邏輯——這些是薄膠水層或需要真實 Electron 環境，用跑起來手動驗證取代。

## Acceptance Criteria

1. 全新安裝、沒動過設定 → 即時對話行為跟推出前完全一致（OpenAI，需要 API key）。
2. 設定畫面選「Ollama 本機」、填好 Base URL/模型名稱、按「儲存」 → 下一次跟任一角色對話改用本機 Ollama 產生回覆，不再檢查/需要 OpenAI key。
3. Ollama 沒有在跑 → 對話送出後得到「連不上 `<baseUrl>`」這類清楚錯誤，不是無回應卡住。
4. 指定的模型沒下載過 → 得到「模型「X」找不到，請先執行 `ollama pull X`」這類可直接照做的錯誤訊息。
5. 設定畫面按「測試連線」，Ollama 正常在跑且至少下載過一個模型 → 顯示找到的模型數量與名稱，模型名稱欄位的自動完成建議清單同步更新。
6. 切回「OpenAI」並儲存 → 下一次對話改回呼叫 OpenAI，跟切換前行為一致。
7. 重新開啟設定畫面 → 目前生效的 provider／Base URL／模型名稱都正確還原顯示，不用重新輸入。
8. 完全重啟桌寵 → 上次選的 provider 設定還在（有持久化）。

## Edge Cases

- **切到 Ollama 後又清空 Base URL 或模型名稱直接按儲存**：擋在 `settings-store.js`（`saveChatProviderSettings`），回傳清楚錯誤，不會存進一個保證打不通的設定。
- **Base URL 打成裸 `host:port`（沒有 `http://`）**：`normalizeOllamaUrl()` 自動補上，跟 `ai-quiz-generator` 既有的正規化邏輯一致。
- **Ollama 回應是空字串**：視同錯誤（`EMPTY_REPLY`），不會把空白訊息送進聊天記憶或顯示成角色講了句空話。
- **使用者把兩個角色都設定成聊天，但只有一個 provider 設定**：provider 是全域設定（跟 API key 一樣），角色一/二共用同一個，不是各自獨立——這是刻意的簡化，跟人設/記憶各自獨立是不同層次的事。
- **`settings.json` 裡的 `chatProvider` 是損毀或未知的值**：`getChatProviderSettings()` 一律 fallback 回 `'openai'`，不會讓對話功能因為設定檔壞掉而完全打不開，跟既有的 mic 設定／API key 壞檔處理方式一致。

## Out of Scope

- **語音輸入（STT）／語音輸出（TTS）換成本機方案**——這次只換文字對話生成，STT/TTS 繼續固定用 OpenAI（見 Implementation Decisions）。
- **角色一/二各自獨立的 provider 設定**——目前是全域共用，見 Edge Cases。
- **自動偵測/掃描區網內的 Ollama 主機**——Base URL 需要使用者自己填。
- **串流回覆（stream:true）／逐字顯示**——`stream:false` 一次拿完整回覆，跟現有 OpenAI 路徑的行為一致，不做這次範圍外的串流 UI。
- **Ollama 模型的下載/管理（`ollama pull`／刪除模型）**——設定畫面只負責「連線測試＋選現有模型」，下載模型本身是使用者自己在終端機做的事。

## Further Notes

- `ollama.js` 的模組介面刻意跟 `chat.js`/`tts.js`/`stt.js` 同一種形狀（`{ ...params, fetchImpl? } → Promise<結果>`，分類過的 Error 帶 `code`），之後想加第三個聊天 provider 可以直接照抄。
- 這次的「main process 直接呼叫本機服務、不透過 renderer fetch」模式，順便讓桌寵版的 Ollama 整合比 `ai-quiz-generator`（純瀏覽器頁面，會撞到 CORS）更省事——這是選擇 Electron 架構在這裡的一個實際好處，值得之後其他要接本機服務的功能參考。
- 相關文件：`docs/adr/0001-openai-for-live-chat.md`（更新段落）、`docs/specs/0002-desktop-pet-live-chat.md`。

## 待辦：補建 GitHub Issue

跟前幾份 spec 一樣，這台機器沒有 `gh` CLI。日後裝好並登入後：

```bash
gh issue create \
  --repo reqw123/question \
  --title "desktop-pet：即時對話新增 Ollama 本機 provider（可選，預設仍 OpenAI）" \
  --body-file docs/specs/0005-desktop-pet-ollama-provider.md \
  --label ready-for-agent
```
