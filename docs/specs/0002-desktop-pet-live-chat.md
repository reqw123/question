# desktop-pet：即時對話（文字輸入＋OpenAI 聊天＋角色人設＋網頁摘要）

> **狀態**：spec 完成，尚未建立對應的 GitHub issue（這台機器沒有 `gh` CLI，見文末待辦）。
> **打算套用的 triage 標籤**：`ready-for-agent`。
> **依賴**：`docs/specs/0001-desktop-pet-tts-playback.md` 已完成，本 spec 直接呼叫該 spec 產出的 `tts.js`（`synthesizeSpeech()`）跟 `main.js` 的語音播放管線（`speakText()` 的模式），不重新設計語音輸出。

## Problem Statement (Goal)

`desktop-pet` 現在有 Live2D 角色、語音輸出（`0001` spec），但角色講的話要嘛是寫死的閒置閒聊（`idle-chat.json`），要嘛是系統匣手動觸發的固定測試句——沒有任何一個地方，角色會針對使用者實際說的話產生真正的回應。使用者要的「AI 桌面助理」，核心缺口是「即時對話」：打字給角色、角色（用真正的 LLM）回應、並且用既有的語音管線講出來。

## Solution

系統匣以外，新增「點角色本體」這個互動入口：互動模式下點角色一或角色二的畫面範圍，彈出一個貼著角色的文字輸入框（跟現有泡泡同一個視覺語言）。送出訊息後，main process 依照被點擊的角色套用對應的人設（system prompt）與該角色獨立的對話記憶，呼叫 OpenAI Chat Completions（`gpt-4o-mini`）取得回覆；訊息裡如果偵測到網址，先在背景抓取該網頁內容當作額外上下文餵給模型（唯讀摘要，不做任何瀏覽器自動操作）。拿到回覆後，用跟語音測試相同的管線同時顯示文字泡泡＋語音播放。

## User Stories (Requirements)

1. As the desktop-pet 使用者，I want 點角色一或角色二的畫面範圍就能打字跟它說話，so that 不用先去翻系統匣選單才能開始對話。
2. As the desktop-pet 使用者，I want 角色一跟角色二各自有不同的個性回話，so that 兩個角色感覺是不同的「人」，不是同一套文字換了張嘴巴講。
3. As the desktop-pet 使用者，I want 角色記得我們最近聊過什麼（在一定範圍內），so that 不用每句話都重新自我介紹一次前情提要。
4. As the desktop-pet 使用者，I want 角色一跟角色二的對話記憶完全分開，so that 換個角色聊天不會把另一個角色的記憶錯亂地拿來用。
5. As the desktop-pet 使用者，I want 對話訊息裡貼一個網址，角色能讀懂那個網頁的內容並回答我關於它的問題，so that 我不用自己先去讀完整篇文章再回來問。
6. As the desktop-pet 使用者，I want 角色回覆時同時看到文字泡泡跟聽到語音，so that 感覺角色是真的在「說」這段回覆，不是分開兩件事。
7. As the desktop-pet 使用者，I want 點擊拖曳鈕／靜音鈕這些既有的控制項時不會誤觸「跟角色說話」，so that 現有的操作方式不會被這個新功能干擾。
8. As the desktop-pet 使用者，I want 送出訊息後角色還在等 AI 回覆時能看得出「正在想」，so that 我知道要等一下，而不是以為卡住了。
9. As the desktop-pet 使用者，I want OpenAI 聊天請求失敗（額度用完、網路問題、key 錯誤）時輸入框給我清楚的錯誤提示，so that 我知道要去哪裡處理，而不是對著沒反應的角色乾等。
10. As the desktop-pet 使用者，I want 網頁抓取失敗時角色還是能正常回覆（告訴我讀取失敗），so that 一個網址讀取失敗不會讓整段對話都廢掉。
11. As the desktop-pet 使用者，I want 沒設定 OpenAI API key 時點角色說話會得到清楚提示，so that 我知道要先去系統匣「設定...」補上。
12. As the desktop-pet 使用者，I want 對話記憶存到超過上限時最舊的自動被丟掉，so that 角色不會無限吃我的 token 額度也不會佔用無限的本機儲存空間。
13. As the desktop-pet 開發者（未來的我），I want OpenAI API key 只存在 main process，聊天/摘要的網路呼叫也只在 main process 發出，so that renderer 端（含理論上的 XSS 風險）永遠碰不到金鑰，延續既有的 `contextIsolation` 安全慣例。
14. As the desktop-pet 開發者（未來的我），I want 人設文字存在一個我可以直接手改的設定檔，so that 之後想調整角色個性不用改任何程式碼、不用重新部署。

## Implementation Decisions

### 點角色觸發輸入框（UI 入口）

- 現有共用 PIXI canvas（兩個角色畫在同一張全螢幕透明 canvas 上）預設 `pointer-events:none`；既有的拖曳機制是「先用 🎲 選單指定要拖哪個角色，才把整張 canvas 暫時打開 `pointer-events:auto`」，**不是**真的偵測點在哪個角色身上——這個「點角色本體判斷是哪個角色」的能力目前完全不存在，是本 spec 新建的。
- 做法：互動模式（非點擊穿透）下，canvas 額外接一個 click 監聽；點擊座標用**矩形範圍判斷**（沿用跟 `getCharPositions()`／泡泡定位同一組 offsetX/offsetY/scale 資料算出的角色可視範圍），落在角色一範圍算角色一、落在角色二範圍算角色二，兩者都沒中就當作點空白處，不觸發。這是**近似值，不是像素級精準**——角色圖片四周的透明留白也會算進「點中」範圍，見 Edge Cases。
- 跟既有拖曳機制共存：只有在「目前沒有角色被 🎲 選單指定為拖曳目標」時才處理點角色開聊天，避免使用者正在拖曳角色時被誤判成想聊天。
- 跟按鈕互斥（Q A 已確認）：`⠿` 拖曳鈕、🔇 靜音鈕都是疊在 canvas 上層的獨立 DOM 元素，點擊會被這些元素先攔截，不會穿透到 canvas 觸發聊天——這是既有 DOM 層級本來就會處理的行為，不用額外寫排除邏輯。
- 輸入框：貼著被點擊角色的頭部定位點（複用 `headRatio`/`headXRatio` 那組資料，跟文字泡泡同一個錨點），輸入完 Enter 或按鈕送出。

### 人設與記憶（跟著插槽 c1/c2，不是跟著模型身份，Q B 已確認）

- 新增 `personas.json`：`{ c1: "<system prompt>", c2: "<system prompt>" }`，純文字檔，使用者直接手改（不做視覺化編輯視窗，Q C 已確認）。換角色一/二目前套用的模型不會換人設——人設跟著「角色一/二」這個插槽，跟整個 codebase 現有的 `c1`/`c2` 慣例（動作測試、閒置閒聊、`speak()`/`speak2()`）一致。
- 新增 `chat-memory-store.js`（跟 `settings-store.js` 同一層級的薄膠水層，main process 專用）：每個角色（`c1`/`c2`）各自一份對話紀錄，存在 `app.getPath('userData')` 底下，每次對話後追加一輪（使用者訊息＋AI 回覆），超過 **20 輪**自動丟最舊的（Q D 已確認），不做摘要壓縮（ADR-0003）。
- 每次呼叫 OpenAI Chat Completions：`system` 訊息＝該角色的 persona，後面接該角色目前存的歷史紀錄，再接這次的新訊息。

### 聊天呼叫（測試 seam 之一）

- 新增 `chat.js`：純函式模組，不 import 任何 Electron API，介面跟 `tts.js` 同一種形狀：
  `sendChatMessage({ message, systemPrompt, history, apiKey, fetchImpl? }) → Promise<{ reply: string }>`，失敗時拋出分類過的 `ChatError`（`code`：`INVALID_INPUT`/`AUTH_ERROR`/`RATE_LIMIT`/`API_ERROR`/`NETWORK_ERROR`，跟 `tts.js` 的 `TtsError` 分類方式一致，錯誤訊息一樣要帶上 API 回應內文方便診斷——這是上一份 spec 上線後才追加的教訓，這次直接做進第一版）。
- 呼叫 `https://api.openai.com/v1/chat/completions`，`model: 'gpt-4o-mini'`。

### 網頁摘要（測試 seam 之二，ADR-0005 範圍界定）

- 新增 `page-digest.js`：純函式模組，介面 `fetchPageText({ url, fetchImpl? }) → Promise<string>`，失敗時拋出分類過的 `PageDigestError`。
- 流程：抓取 HTML → 用簡單的 regex 去標籤＋壓縮空白轉成純文字（不引入額外的 HTML parser 套件，維持這個模組零依賴）→ 截斷到合理長度（避免把整篇網頁塞爆 chat 請求的 token）。
- 觸發時機：main process 收到訊息時，用 regex 偵測文字裡有沒有 `http(s)://` 開頭的網址（Q15 已確認：自動偵測，不用特殊指令）；有的話先呼叫這個模組，抓取結果當作額外上下文一起送給 `chat.js`。
- **失敗時優雅降級（User Story 10）**：網頁抓取/解析失敗不會擋住整段對話——main process 改成把「這個網址讀取失敗」的訊息也一起放進送給模型的上下文，讓角色可以回覆「我讀不到這個網頁」，而不是整個請求直接失敗。

### 對話流程整合（main process 端組裝，薄膠水層，不寫自動測試）

1. renderer 送出「使用者對角色 c1/c2 說了 X」的 IPC
2. main process：偵測 X 有沒有網址 → 有就呼叫 `page-digest.js`（失敗就降級，不擋流程）
3. 讀該角色的 persona（`personas.json`）＋歷史記憶（`chat-memory-store.js`）
4. 呼叫 `chat.js` 取得回覆文字
5. 存這一輪到該角色的記憶（超過 20 輪丟最舊的）
6. 沿用 `0001` spec 的模式：呼叫 `tts.js` 取得語音 → `L2D.speak()`/`speak2()` 顯示文字泡泡 → 把音檔送進 renderer 播放
7. 全程任何一步失敗（缺 key、聊天 API 失敗），把分類過的錯誤送回輸入框顯示，不靜靜失敗（跟語音測試「印終端機」不同，這裡使用者正在等回覆，要在 UI 上看得到）

## Testing Decisions

- 沿用 `0001` spec 的測試哲學：只測「不碰 Electron API 的純函式模組」對外的輸入輸出契約，mock 網路層，不真的打 OpenAI API。
- **兩個測試 seam**：
  1. `chat.js` 的 `sendChatMessage()`——成功案例、401/403/429/其他非 200（含回應內文帶入錯誤訊息）、網路層 throw、空白訊息在送出前被擋下。跟 `tts.js` 的九個測試案例是同一套模式，直接照抄改參數。
  2. `page-digest.js` 的 `fetchPageText()`——成功案例（HTML 轉純文字）、非 200 回應、網路層 throw、明顯不是網址格式的輸入在送出前被擋下。
- **刻意不寫自動測試**：`chat-memory-store.js`（跟 `settings-store.js` 同等級）、canvas 點擊命中判斷、輸入框 UI、IPC 接線、main process 的對話流程整合——這些是薄膠水層或需要真實畫面座標的邏輯，用跑起來手動驗證取代。
- 沿用 `desktop-pet` 既有的 `vitest`，不需要新增測試框架或設定。

## Acceptance Criteria

1. 互動模式下點角色一或角色二的可視範圍 → 該角色旁邊彈出輸入框。
2. 點角色一/二以外的空白畫面 → 不彈出任何輸入框。
3. 點 `⠿` 拖曳鈕或 🔇 靜音鈕 → 只觸發那顆按鈕原本的功能，不會同時彈出聊天輸入框。
4. 已設定有效 API key，對角色一輸入訊息送出 → 幾秒內看到文字泡泡＋聽到語音回覆，且回覆內容跟角色一的 persona 語氣一致。
5. 對角色二輸入訊息 → 回覆語氣跟角色一明顯不同（套用各自 persona），且角色二不會提到角色一的對話內容（記憶互相獨立）。
6. 連續對同一個角色聊超過 20 輪 → 最舊的對話從記憶中消失，角色不會再提到那些內容，但最近 20 輪內的內容還記得。
7. 訊息裡貼一個有效網址並發問 → 回覆內容能反映該網頁的實際內容。
8. 訊息裡貼一個抓不到內容的網址（404 或連不上） → 角色仍正常回覆（告知讀取失敗），不會整個沒反應或卡住。
9. 未設定 API key 時點角色說話 → 輸入框顯示清楚提示，不會送出去憑空等待。
10. OpenAI 聊天請求失敗（key 錯誤/額度用盡/網路問題）→ 輸入框顯示對應的清楚錯誤，不會卡在「傳送中」的狀態。
11. 等待回覆期間 → 有看得出來的「思考中」提示。
12. 完全重啟 `desktop-pet` 後，之前跟角色一聊過的內容還在（記憶有持久化）。

## Edge Cases

- **點擊命中的是角色透明留白處，不是角色實際的不透明像素**：這是矩形範圍判斷的已知取捨（不是 bug），落在角色可視範圍內都算命中；如果體感上誤觸太頻繁，之後可以縮小判定範圍的比例，不需要改成真正的像素級 alpha 判斷。
- **使用者正在用 🎲 選單拖曳角色時點擊畫面**：拖曳行為優先，不觸發聊天輸入框（見 Implementation Decisions 的「跟既有拖曳機制共存」）。
- **同一則訊息裡貼了兩個以上的網址**：只處理偵測到的第一個網址，避免一次觸發多個網路請求拖慢回覆速度；之後想支援多網址是可以疊加的後續優化。
- **網頁內容極長（例如整本電子書網頁）**：`page-digest.js` 截斷到合理長度，不是整篇塞進 chat 請求，避免超過 token 上限或請求爆炸貴。
- **角色一/二同時被追問，AI 回覆還沒回來又送出第二則訊息**：後送出的訊息要等前一則處理完才送出（或明確排隊），不要兩個請求並發導致記憶寫入順序錯亂。
- **`personas.json` 檔案損毀或缺某個角色的欄位**：視同該角色沒有自訂 persona，退回一個通用預設 system prompt，不要讓整個對話功能因為設定檔壞掉而完全打不開。
- **`chat-memory-store.js` 的儲存檔損毀**：視同該角色記憶是空的（重新開始），不要讓桌寵啟動或聊天功能因為這個壞掉——跟 `0001` spec 對 `settings.json` 壞掉的處理方式一致。
- **使用者訊息本身就是空白**：跟 `tts.js`/`chat.js` 的輸入驗證一致，前端直接擋下不送出，不用等後端才發現。

## Out of Scope

- **像素級精準的角色點擊判定**——用矩形範圍近似值，見 Implementation Decisions/Edge Cases。
- **語音輸入（STT）**——ADR-0002 已排除，這裡的輸入仍然是打字。
- **記憶摘要壓縮**——ADR-0003 已排除，只做「超過上限丟最舊」。
- **人設視覺化編輯介面**——`personas.json` 是純文字檔，手改即可，不做像「模型命名管理」那樣的編輯視窗。
- **多網址、多輪對話中網頁內容的交叉引用**——只處理單一訊息裡偵測到的第一個網址。
- **瀏覽器擴充套件／內嵌 BrowserView／任何形式的瀏覽器自動操作**——ADR-0005 已排除，網頁摘要純粹是後端 fetch＋轉純文字。
- **依角色設定不同語音音色**——沿用 `0001` spec 的預留但未實作的 `voice` 參數，這份 spec 一樣先用單一預設音色。

## Further Notes

- 這份 spec 完成後，`desktop-pet` 會有四個角色能「說話」的路徑：閒置閒聊（免費、寫死）、系統匣語音測試（`0001`，固定測試句）、即時對話（本 spec，真正的 AI 回覆）——後兩者共用同一條「文字→語音+泡泡」管線，不重工。
- `chat.js`／`page-digest.js` 的模組介面刻意設計成跟 `tts.js` 同一種形狀（`{ ...params, fetchImpl? } → Promise<結果>`，分類過的 Error 帶 `code`），維持這個 repo 目前唯一的測試模式一致，之後任何新的「呼叫外部 API」功能都可以照抄這個形狀。
- 相關文件：`CONTEXT.md`、`docs/adr/0001`～`0006`、`docs/specs/0001-desktop-pet-tts-playback.md`。

## 待辦：補建 GitHub Issue

跟 `0001` spec 一樣，這台機器沒有 `gh` CLI。日後裝好並登入後：

```bash
gh issue create \
  --repo reqw123/question \
  --title "desktop-pet：即時對話（文字輸入＋OpenAI 聊天＋角色人設＋網頁摘要）" \
  --body-file docs/specs/0002-desktop-pet-live-chat.md \
  --label ready-for-agent
```
