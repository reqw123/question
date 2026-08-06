# desktop-pet：語音輸入（STT，點擊切換錄音＋靜音自動停止）

> **狀態**：spec 完成，尚未建立對應的 GitHub issue（這台機器沒有 `gh` CLI，見文末待辦）。
> **打算套用的 triage 標籤**：`ready-for-agent`。
> **依賴**：`docs/adr/0007-voice-input-whisper-click-toggle-auto-stop.md`（架構決策）、`docs/specs/0002-desktop-pet-live-chat.md`（`sendChatMessage` IPC 直接重用，不重新設計對話送出流程）。

## Problem Statement (Goal)

「即時對話」目前只能打字。使用者想要語音輸入，讓對話更接近「真的在講話」，不用每次都停下來打字。ADR-0002 原本把這個排除在 v1 之外，這份 spec 是把它加回來。

## Solution

聊天輸入框裡新增一顆 🎤 按鈕：點一下開始用麥克風錄音，偵測到使用者停止說話（或再點一次手動停止）就結束錄音，呼叫 OpenAI Whisper API 轉錄成文字，直接重用既有的 `sendChatMessage` IPC 送出（不經過文字輸入框讓使用者確認/編輯這一步）——語音輸入只是換一種方式「產生文字」，送出之後的整條管線（人設、記憶、網頁摘要偵測、語音回覆、文字泡泡）完全沿用 `0002` spec 已經做好的東西，不重新設計。

## User Stories (Requirements)

1. As the desktop-pet 使用者，I want 點聊天輸入框裡的 🎤 就能用講的跟角色說話，so that 不用每次都停下來打字。
2. As the desktop-pet 使用者，I want 講完話停頓一下系統會自動偵測我說完了，so that 不用自己去點停止。
3. As the desktop-pet 使用者，I want 也可以手動點一次 🎤 結束錄音，so that 靜音偵測沒抓準或我想提早結束時有備案。
4. As the desktop-pet 使用者，I want 轉錄完的文字直接送出去，不用我再按一次確認，so that 語音輸入真的比打字快，不會多一道手續把這個優點抵銷掉。
5. As the desktop-pet 使用者，I want 錄音中途按 Esc 可以整個取消（不轉錄、不送出），so that 講錯話/講到一半改變主意時可以反悔。
6. As the desktop-pet 使用者，I want 錄音中途按 Esc 只取消錄音、不會把整個聊天輸入框關掉，so that 我不用重新點角色再開一次框。
7. As the desktop-pet 使用者，I want 忘記手動停止時錄音不會無限進行下去，so that 不會浪費 API 額度或錄到不相干的環境音。
8. As the desktop-pet 使用者，I want 沒有偵測到任何有效語音時（完全靜音/聽不清楚）不會送出空白訊息，so that 角色不會收到一則空的、莫名其妙的訊息。
9. As the desktop-pet 使用者，I want 麥克風權限第一次使用時不用在桌寵裡另外跳一個確認框，so that 操作流程跟現有其他功能一樣簡潔（Windows 系統層級的權限提示還是會有）。
10. As the desktop-pet 使用者，I want 語音轉錄失敗（額度用完、網路問題、key 錯誤）時輸入框給我清楚的錯誤提示，so that 我知道要去哪裡處理，而不是對著沒反應的麥克風按鈕乾等。
11. As the desktop-pet 開發者（未來的我），I want OpenAI API key 只存在 main process、Whisper 的網路呼叫也只在 main process 發生，so that 延續既有的 `contextIsolation` 安全慣例，跟 `tts.js`/`chat.js`/`page-digest.js` 一致。

## Implementation Decisions (Architecture)

### Whisper API 呼叫（測試 seam之一）

- 新增 `desktop-pet/stt.js`：純函式模組，介面形狀跟 `tts.js`/`chat.js` 一致：
  `transcribeAudio({ audioBuffer, mimeType, apiKey, fetchImpl? }) → Promise<{ text: string }>`，失敗拋出分類過的 `SttError`（`INVALID_INPUT`/`AUTH_ERROR`/`RATE_LIMIT`/`API_ERROR`/`NETWORK_ERROR`，錯誤訊息帶 API 回應內文，這次直接做進第一版，不像 `0001` spec 事後才補）。
- 呼叫 `https://api.openai.com/v1/audio/transcriptions`（`multipart/form-data`，帶 `file`／`model: 'whisper-1'`），用 Node 全域 `FormData`/`Blob`（Electron 這個版本的 Node 已經有，跟 `tts.js`/`chat.js` 用全域 `fetch` 是同一個判斷）。

### 靜音偵測（測試 seam之二）

- 新增 `desktop-pet/silence-detector.js`：純函式模組，介面：
  `checkSilence({ rms, silenceStartedAt, now, rmsThreshold?, silenceDurationMs? }) → { shouldStop: boolean, silenceStartedAt: number|null }`。
  - 跟 `lipsync.js` 同一種「不自己保存狀態，呼叫端每幀把上一次的結果餵回來」的純函式設計（`silenceStartedAt` 進、出都由呼叫端保管）。
  - 音量高於門檻 → `shouldStop:false`、`silenceStartedAt:null`（重置，代表使用者還在講話）。
  - 音量低於門檻 → 如果是第一次偵測到安靜，記錄這一刻當 `silenceStartedAt`；如果已經安靜超過 `silenceDurationMs`（預設 1500ms）→ `shouldStop:true`。
  - `rms` 本身怎麼算沿用 `lipsync.js` 的 `computeRms()`，不重新實作一份（`silence-detector.js` 只管「安靜多久該停」的判斷邏輯，不管音量怎麼算）。

### 錄音/轉錄流程（薄膠水層，`index.html`）

1. 點 🎤 → `navigator.mediaDevices.getUserMedia({ audio: true })` 拿麥克風串流 → `MediaRecorder` 開始錄音 → 同時用 `AnalyserNode`（跟嘴型同步的手法一樣，但這次是分析麥克風輸入而不是 TTS 播放輸出）每隔一小段時間讀音量，餵給 `checkSilence()`。
2. 60 秒安全上限計時器（`setTimeout`），到時間強制觸發跟手動停止一樣的流程。
3. 停止（自動偵測到安靜 / 手動再點一次 🎤 / 60 秒上限）→ `MediaRecorder.stop()` → 拿到錄音 Blob → 透過 IPC 送進 main process。
4. Esc → 直接呼叫 `MediaRecorder.stop()` 但**捨棄**這段錄音（不送 IPC），跟步驟 3 的差別只在於「要不要真的送出去轉錄」。
5. main process 新增 `ipcMain.handle('voice-transcribe', ...)`：讀 API key（沒設定就直接回錯誤，不呼叫 Whisper）→ 呼叫 `stt.js` 的 `transcribeAudio()` → 回傳 `{ ok, text }` 或 `{ ok:false, error }`。
6. renderer 拿到轉錄文字後，**直接重用** `window.petBridge.sendChatMessage(charKey, text)`（`0002` spec 既有的介面）送出——語音輸入不用另外接一條送出邏輯，送出之後的一切（人設/記憶/網頁摘要偵測/語音回覆/嘴型同步）全部沿用既有管線。
7. 空字串/純空白的轉錄結果 → 不呼叫 `sendChatMessage`，安靜重置成待命狀態（User Story 8）。

### 麥克風權限

- `main.js` 的 `createWindow()`：`session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => { if (permission === 'media') return callback(true); callback(false); })`——只自動放行 `media`（麥克風/攝影機）這一種權限請求，其他類型維持預設拒絕，不是整個放飛權限檢查。

### UI 狀態

- 🎤 按鈕三態：待命（灰色圖示）／錄音中（紅色或閃爍，點擊變成手動停止）／轉錄中（loading 狀態，鎖住不能再點）。
- 錄音/轉錄期間：既有的文字輸入框跟送出邏輯要跟著鎖住（重用 `0002` spec 已經有的 `chatRequestPending`/`chatInput.disabled` 機制，統一成一個「這個聊天框目前忙碌中」的狀態，不分是文字送出忙碌還是語音錄音/轉錄忙碌），避免文字/語音兩條路同時搶送出。

## Testing Decisions

- 沿用 `0001`/`0002`/`0003` 的測試哲學：只測不碰瀏覽器 API／Electron API 的純函式模組，mock 網路層，不需要真的錄音或打 OpenAI API。
- **兩個測試 seam**：
  1. `stt.js` 的 `transcribeAudio()`——成功案例、空音檔在送出前被擋下（`INVALID_INPUT`）、缺 key（`INVALID_INPUT`）、401/403/429/其他非 200（含回應內文）、網路層 throw。跟 `tts.js`/`chat.js` 是同一套九宮格案例，直接照抄改參數。
  2. `silence-detector.js` 的 `checkSilence()`——大聲輸入回傳 `shouldStop:false` 且重置 `silenceStartedAt`；安靜輸入第一次偵測到 → 開始計時、`shouldStop:false`；安靜時間超過門檻 → `shouldStop:true`；安靜時間還沒到門檻 → `shouldStop:false` 且保留原本的 `silenceStartedAt`（不是重新開始算）。
- **刻意不寫自動測試**：`getUserMedia`/`MediaRecorder` 接線、`AnalyserNode` 音量讀取迴圈、IPC 接線、🎤 按鈕 UI 狀態機、麥克風權限 handler——這些需要真實瀏覽器/麥克風/Electron 環境，跑起來手動驗證（對應 Acceptance Criteria）。

## Acceptance Criteria

1. 點 🎤 → 開始錄音，按鈕視覺上明確變成「錄音中」狀態。
2. 講一段話、停頓約 1.5 秒 → 自動停止錄音，幾秒內看到/聽到角色的回覆（文字泡泡＋語音，沿用既有管線）。
3. 錄音中再點一次 🎤 → 立刻停止，跟自動偵測停止走同一條轉錄＋送出流程。
4. 錄音中按 Esc → 錄音立刻停止，**不會**出現角色回覆（沒有送出任何東西），聊天輸入框本身維持開著（不會被關掉）。
5. 對著麥克風錄音但完全不說話（或只有背景噪音）→ 不送出任何訊息，🎤 按鈕回到待命狀態，不會出現空白的角色回覆。
6. 錄音超過 60 秒沒有停止 → 自動觸發轉錄＋送出，跟正常流程一致。
7. 錄音/轉錄期間 → 文字輸入框跟送出功能都鎖住，不能同時打字送出，也不能點另一個角色切換聊天框。
8. 未設定 API key 時點 🎤 → 直接顯示清楚錯誤，不會嘗試錄音或呼叫 Whisper。
9. Whisper API 呼叫失敗（key 錯誤/額度用盡/網路問題）→ 輸入框顯示對應的清楚錯誤，🎤 按鈕回到待命狀態可以重試。
10. 第一次使用語音輸入時 → 不會跳出桌寵自己的確認框（Windows 系統的麥克風權限提示不算）。

## Edge Cases

- **使用者從沒授權過麥克風、Windows 系統層級直接擋下**：`getUserMedia()` 會 reject，這個錯誤要被接住顯示清楚訊息（例如「麥克風存取被拒，請檢查 Windows 隱私權設定」），不是讓程式看起來卡住沒反應。
- **錄音中途麥克風被拔掉/其他程式搶走裝置**：`MediaRecorder`/串流中斷的錯誤要被接住，視同「這次錄音失敗」，回到待命狀態，不當掉整個聊天框。
- **極短的錄音**（例如手滑點兩下，錄音不到 0.5 秒就停止）：跟「完全靜音」走同一條「不送出」的路徑（User Story 8 / Acceptance Criteria 5）。
- **完全靜音時 Whisper 幻覺出文字**（實測發生過，見「實作後又修正」）：不能只靠「轉錄結果是空字串」判斷沒講話——Whisper 對純靜音音檔不保證回傳空字串，會幻覺出「Thanks for watching」之類的字幕片語並被當成正常訊息送出。改成錄音期間就用既有的 RMS 音量（跟安靜偵測同一份數據）記錄「這整段有沒有出現過任何一幀音量高於安靜門檻」，完全沒有的話直接跳過呼叫 Whisper，從源頭擋掉，不是靠檢查轉錄文字內容。
- **靜音偵測門檻在吵雜環境誤判**（例如背景一直有聲音，永遠偵測不到「安靜」）：60 秒上限（Acceptance Criteria 6）是這種情況的安全網，不會讓錄音真的無限進行下去；使用者也可以隨時手動點 🎤 停止。
- **轉錄文字包含網址**：直接重用 `sendChatMessage`（Implementation Decisions 第 6 點），所以 `0002` spec 的網頁摘要自動偵測邏輯一樣會生效，語音講出一個網址一樣可以觸發摘要——不用重新處理這個情境。

## Out of Scope

- **按住說話（push-to-talk）**——Q2 已決定用點擊切換，不是按住。
- **語音活動偵測自動開始錄音／喚醒詞**——開始錄音仍然是使用者主動點擊，只有「停止」這一側是自動偵測，見 ADR-0007。
- **轉錄文字送出前的確認/編輯**——Q3 已決定直接送出。
- **OpenAI Realtime API／真正的雙向即時語音串流**——ADR-0007 明確排除，維持現有「文字聊天＋另外呼叫 TTS」的架構不變。
- **依角色/語言調整 Whisper 的辨識語言參數**——先用 Whisper 的自動語言偵測，不特別指定 `language` 參數；之後如果偵測不準確再考慮。
- **錄音音量視覺化（例如即時波形）**——🎤 按鈕只做三態（待命/錄音中/轉錄中），不做即時音量視覺回饋。

## Further Notes

- 這是延續原本五類功能建議之外的第四份 spec（`0001` 語音輸出、`0002` 即時對話、`0003` 嘴型同步、`0004` 語音輸入），完成後桌寵的「聊天」輸入方式會有文字＋語音兩種，出口（回覆顯示）完全共用同一條管線，沒有分岔。
- `stt.js`／`silence-detector.js` 的模組介面延續 `tts.js`/`chat.js`/`page-digest.js`/`lipsync.js` 建立的形狀慣例（純函式、`fetchImpl`/狀態注入、分類過的 `Error`），之後任何新的「呼叫外部 API」或「逐幀分析音訊」功能都可以照抄。
- 相關文件：`CONTEXT.md`（語音輸入術語定義）、`docs/adr/0002`（已標記 superseded）、`docs/adr/0007`（本次架構決策）。

## 實作後修正：語音模式持續循環（不是單次錄音）

實作完給使用者驗收時發現，原本「錄一段→轉錄→送出→回到待命，要再手動點一次」的單次流程不符合實際使用習慣——使用者要的是「開啟後持續講、講完一句自動接著錄下一句，不用每句都點」，跟打字模式可以自由切換使用。修正後的行為：

- 點 🎤 開啟**語音模式**（不是單次錄音），反覆循環：錄一段 → 偵測安靜自動停止（或 60 秒上限）→ 轉錄 → 打字機效果顯示在輸入框 → 直接送出 → 自動接著錄下一段。
- 再點一次 🎤／Esc／關閉聊天框才整個關掉。錄音中點擊：這一段照常轉錄送出（不是取消掉，可能話講到一半），只是送完不再自動續錄。
- 轉錄失敗（API/網路錯誤）會整個關掉語音模式，避免無腦重錄一直燒 API 額度；轉錄結果是空字串（完全靜音/聽不清楚）則視為語音模式常駐監聽下的正常情況，不關閉、直接續錄下一段。
- CONTEXT.md 新增「語音模式（Voice Mode）」術語，跟原本的「語音輸入」分開——「語音輸入」是功能總稱，「語音模式」specifically 指這個持續循環的狀態。

## 實作後修正：續錄要等角色語音真的播完（避免聲學回授）

語音模式持續循環上線後發現：`chat-send` 這個 IPC 原本是「語音合成完、把音檔送給 renderer 播放」就算完成（`main.js` 的 `speakAndShow()` 不等 renderer 真的播完），續錄迴圈接在 `sendTextMessage()` 後面——結果角色講話還沒講完，麥克風就已經重新打開，錄到角色自己的語音造成聲學回授。

修正：新增 `tts-playback-finished` IPC（renderer 的 `playTtsAudio()` 在音檔真的 `ended`／播放失敗時回報），`speakAndShow()` 改成送出音檔後 `await` 這個回報才 resolve（30 秒逾時保險，避免 renderer 沒回報時整個卡死）。這個修正同時也讓文字輸入模式送出下一句前，等角色把話講完才能再送，行為更一致（原本文字模式回覆合成完就能馬上再打字送出，即使角色還在講話）。

## 實作後再修正：殘響緩衝 + 連續輪數安全煞車 + 關閉按鈕的收尾狀態

上面那個修正上線後，使用者反映還是會出現幻覺語音輸入無限循環，而且點麥克風鈕沒辦法把語音模式關掉。追查後補了三層防護：

- **播放結束到重新開麥克風之間加 600ms 緩衝**（`POST_PLAYBACK_COOLDOWN_MS`）：`ended` 事件觸發的當下，喇叭到麥克風之間的殘響/回音不會瞬間消失，緊接著開麥克風容易錄到自己剛講完的尾音，這是「等播完才錄」這個修正沒能完全解決根因的部分。
- **連續自動觸發輪數上限 12 輪**（`MAX_CONSECUTIVE_VOICE_TURNS`）：不管上面兩層有沒有真的堵住殘響問題，這是最後一道安全閥——正常對話的節奏不可能連續 12 輪都不停頓，超過就強制關閉語音模式並顯示警告，不會真的無限循環燒 API 額度。
- **點擊關閉語音模式時立刻鎖住按鈕＋改文字**：原本點擊後這一段的收尾（轉錄/送出/等語音播完）還要跑幾秒，期間按鈕外觀不變，使用者容易誤以為沒點到而點第二次——第二次點擊會落進「重新開啟」分支，把剛剛的關閉動作蓋掉。改成點擊當下立刻 `disabled + 改標題`，真正回到待命才解鎖。

## 實作後又修正：拿掉持續語音模式，改回單次錄音、每次都要手動開啟

上面三層防護上線後，聲學回授/幻覺輸入的問題還是沒有根除，使用者決定不要再修這個持續循環，直接拿掉：

- 拿掉「送完自動接著錄下一段」的迴圈（`onRecordingStopped()` 尾端呼叫 `startRecording()` 續錄那一段），改成每一輪（錄音→轉錄→送出）結束後一律 `resetMicButtonToIdle()`，回到待命狀態。
- 連帶拿掉只為了這個持續迴圈存在的配套機制：`POST_PLAYBACK_COOLDOWN_MS`（播放後緩衝）、`MAX_CONSECUTIVE_VOICE_TURNS`／`voiceModeTurnCount`（連續輪數安全煞車）——沒有自動續錄就不會有「連續觸發燒額度」的風險，這兩層防護的存在理由一併消失。
- `voiceModeActive` 改名成 `voiceInputActive`，語意從「語音模式這個持續開關」窄化成「這一輪語音輸入（點擊→錄音→轉錄→送出）進行中」，跟 `isRecording` 的分工不變（`isRecording` 是更窄的「當下真的在錄音」，用來判斷點擊麥克風鈕是手動提前停止這一段）。
- 麥克風鈕的忙碌豁免條件從「語音模式開著時全程可點」改回「只有錄音中才可點，轉錄/送出中鎖住」，回到 Implementation Decisions「UI 狀態」原本三態設計的待命／錄音中／轉錄中，沒有「持續模式開著」這個第四態。
- `tts-playback-finished` IPC（`main.js` 的 `speakAndShow()` 等 renderer 回報播放真的結束才 resolve）**保留不動**：這個機制除了原本防回授的動機之外，也讓文字輸入模式在送下一句前一樣會等角色講完話（見上面「續錄要等角色語音真的播完」那次修正的說明），拿掉持續語音模式不影響這部分的價值。
- CONTEXT.md 的「語音模式（Voice Mode）」術語一併移除，「語音輸入（Voice Input）」定義改回描述單次錄音、每次都要手動點擊開啟。

## 實作後再修正：開麥克風不說話會幻覺出文字並照樣送出

改回單次錄音之後，使用者回報：開啟麥克風後完全不說話，等到自動停止，角色還是收到一則訊息（畫面截圖顯示轉錄結果是「Thanks for watching」，角色顯示「思考中...」代表真的送出去了）。

**根因**：`onRecordingStopped()` 原本只靠「轉錄結果字串 trim 後是不是空字串」判斷有沒有講話，這個假設不成立——OpenAI Whisper 對純靜音/近乎靜音的音檔不保證回傳空字串，這是 Whisper 訓練資料（大量 YouTube 影片）帶來的已知現象，常見幻覺片語包括「Thanks for watching」「Thank you.」「字幕由 ... 提供」之類，聽起來像結尾字卡而不是使用者講的話。

**修法**：不檢查轉錄結果的文字內容，改成在錄音期間就記錄事實——`recordingHadLoudAudio`（`index.html`）在每次安靜偵測的 200ms 音量檢查裡，只要這一幀 RMS 音量達到 `silence-detector.js` 的 `DEFAULT_RMS_THRESHOLD`（跟自動停止用的同一個門檻，這次額外把它匯出給呼叫端用）就設成 `true`。`onRecordingStopped()` 一開始（早於呼叫 Whisper 之前）先檢查這個旗標，整段錄音都沒出現過大於門檻的音量就直接跳過呼叫 Whisper API，當作沒講話處理——從源頭擋掉，不會讓幻覺文字有機會被判斷成「有效轉錄結果」。

## 實作後再修正：`recordingHadLoudAudio` 旗標防不住幻覺，改成累計時長 + 模型自報信心度雙層防護

上一輪修法上線後，使用者回報幻覺輸入還是沒有改善。

**根因**：`recordingHadLoudAudio` 是「錄音期間只要出現過一次超過門檻的音框就永遠算數」的
旗標，不是持續狀態。60 秒錄音裡任何一次瞬間噪音（滑鼠喀嚓聲、椅子聲、麥克風本底噪音的
波動）只要有一個 200ms 音框超過 `DEFAULT_RMS_THRESHOLD`（0.02，這個門檻本來是給
lipsync.js 拿來分辨「背景噪音」用的低標準，冒用來當「這段錄音該不該送 Whisper」的唯一
判斷依據太寬鬆），旗標就整段錄音變 `true`，之後即使使用者完全沒開口，一樣照樣呼叫
Whisper——這道防呆在真實環境裡幾乎攔不到東西。而且 Whisper 的幻覺不是只在音量真正歸零
時發生，對「音量夠低、沒有實際語音內容」的音檔一樣會幻覺。

**修法**：兩道獨立防線，任一道失守另一道還能擋。

1. **錄音端：累計時長取代一次性旗標**（`silence-detector.js` 新增
   `DEFAULT_MIN_SPEECH_DURATION_MS`＝400ms，`index.html` 把 `recordingHadLoudAudio`
   改成 `loudAudioMs` 累加器）——音量達到門檻的時間合計要超過 400ms 才算「使用者真的有
   講話」，單一次瞬間噪音（通常只佔一個 200ms 音框）累計不到這個時長，不會再讓整段錄音
   蒙混過關。
2. **API 端：Whisper 自己回報的信心度**（`stt.js` 改用 `response_format: verbose_json`，
   檢查回應 `segments[].no_speech_prob` 的平均值，達到 `NO_SPEECH_PROB_THRESHOLD`＝0.6
   就把 `text` 改回空字串，不回傳可能是幻覺的文字）——這道防線刻意不去檢查/比對轉錄出來
   的文字內容本身（猜幻覺片語猜不完，也可能誤殺使用者真的講到類似字句的情況），而是看
   模型對「這裡有沒有語音」這件事本身的信心程度，跟第一道防線的判斷依據（錄音當下的音量）
   完全獨立。

兩處都補了對應的 vitest（`stt.test.js` 兩個新案例驗證 `no_speech_prob` 篩選行為）。

### 再修正：`DEFAULT_RMS_THRESHOLD` 從 0.02 調高到 0.04

上面兩道防線上線後，使用者回報幻覺還是差不多。這個門檻原本沿用 lipsync.js 判斷嘴巴
該不該動的數值（0.02），那是給動畫好不好看用的低標準，麥克風輸入這邊要判斷「有沒有
真的講話」標準需要更嚴，於是加倍到 0.04，濾掉更多本底噪音/環境雜音被誤判成「有講話」
的情況。這個常數同時是「安靜多久算講完了」（自動停止）跟「累計多久算真的有講話」
（幻覺防呆）共用的門檻，跟 TTS 播放時嘴型同步用的門檻（`lipsync.js` 的
`DEFAULT_MIN_THRESHOLD`）是分開的常數，調這裡不影響嘴巴動畫。如果之後還是誤判可以
再往上調，但調太高會讓音量偏小/離麥克風較遠的正常說話被誤判成安靜。

### 再修正：設定畫面開放調整「聲音最低門檻」「聲音累計時長」

使用者實測發現：重開 app 沒用，是 Electron 快取了改動前的 renderer 程式碼（要清快取才會真的
吃到新版），清完快取後上面兩層防護確認有效。既然門檻要不要調整因人因環境而異（不同麥克風/
房間的背景噪音水準不一樣），與其每次都要改程式碼再請使用者重開/清快取，改成開放在設定畫面
（系統匣「設定...」）直接調整：

- `settings-store.js` 新增 `getMicSettings()` / `saveMicSettings()` / `resetMicSettings()`，
  存到跟 API key 同一份 `settings.json`（key 是 `micRmsThreshold` / `micMinSpeechDurationMs`）。
  沒存過就 fallback 回 `silence-detector.js` 匯出的內建預設值——這兩個模組故意不重複定義
  一份預設值數字，避免兩邊改一個忘記改另一個。
- `main.js` 新增三個 IPC：`get-mic-settings`（給桌寵主視窗問目前值）、
  `settings-save-mic-settings`、`settings-reset-mic-settings`（給設定視窗存/還原）。
- `index.html` 的 `startRecording()` 開頭改成每次開始錄音都問一次 `petBridge.getMicSettings()`
  拿目前值（存到 `currentMicRmsThreshold`／`currentMicMinSpeechDurationMs`，取代直接讀
  `window.SilenceDetector.DEFAULT_*`），問不到就照樣 fallback 回內建預設值——這樣使用者在
  設定畫面調完，下一次點 🎤 就生效，不用重開桌寵，也不會因為 IPC 失敗就讓語音輸入整個掛掉。
- 設定視窗新增「語音輸入靈敏度」區塊，兩個 `<input type="number">` + 儲存/還原預設值按鈕，
  跟既有 API key／記憶清空同一套視覺風格。

### 再修正：`clearCache()` 沒等就 `loadFile()`，清快取跟載入頁面在賽跑

使用者確認「重開沒用、手動清快取才有用」之後往回查，發現 `main.js` 建立主視窗那段其實早就
有防 Chromium 磁碟快取的機制（`session.clearCache()` + 強制 `Cache-Control: no-store`），
但 `clearCache()` 是非同步的，舊寫法 `clearCache().catch(() => {})` 後面緊接著同步呼叫
`win.loadFile(...)`，兩者幾乎同時觸發，不保證清完快取才開始載入頁面——這就是防禦措施本來
存在、卻還是會吃到舊版程式碼的原因。改成 `clearCache().finally(() => win.loadFile(...))`，
確保一定是清完（不管成功或失敗，`.finally()` 都會繼續，不會讓清快取失敗卡住桌寵開不起來，
跟原本 `.catch(() => {})` 吞掉錯誤但繼續跑的行為一致）才開始載入，以後改完 renderer 端程式碼、
使用者單純重開 app 就應該會保證吃到最新版，不用再手動清快取。

### 再修正：設定視窗字體/按鈕視覺調整

設定視窗（`settings.html`）原本所有按鈕共用同一種灰底外框樣式（除了「儲存」是青色、
「清除」系列是橘色文字），現在改成三種語意固定的按鈕外觀，不分區塊都套用同一套規則：
`.btn-primary`（青色實心，儲存類）／`.btn-secondary`（紫色外框，語音輸入靈敏度區塊的
「還原預設值」——會覆蓋設定但不是不可逆操作）／`.btn-danger`（橘色外框，清除 API
key／清空記憶——不可逆，main process 還會再跳一次原生確認對話框）。另外把每個 section
開頭的區塊主標題（「OpenAI API Key」「對話記憶」「語音輸入靈敏度」）獨立成
`.section-title`（1.05em，比欄位小標題更突出一階），功能敘述文字（`.hint`）字級從
.78em 放大到 .88em，加大行高。

### 再修正：「清除本機快取並重開」改成獨立小視窗，列出實際會清掉什麼、路徑在哪

原本系統匣「清除本機快取並重開...」點下去是原生 `dialog.showMessageBox` 確認對話框，改成
獨立小視窗（`clear-cache-confirm.html` + `clear-cache-confirm-preload.js`，跟
`settings.html`/`name-manager.html` 同一套視窗架構），內容條列清除後會回到預設狀態的東西
（角色擺放位置/縮放、額外寵物顯示開關、角色一/二上次選過的造型——純使用者體驗描述，不提
localStorage/session 這些實作細節），並附上實際會被清掉的資料夾路徑
（`app.getPath('userData')` 底下的 `Local Storage` 資料夾，動態算出來顯示，不寫死），
另外加一句提醒：對話記錄、API key、語音輸入門檻都存在別的地方，這個操作不會動到。
`main.js` 原本的 `clearCacheAndRestart()`（跳原生對話框問完直接做）拆成
`performClearCacheAndRestart()`（純做清除+重開的動作）+ `openClearCacheConfirm()`
（開確認視窗）兩個函式，實際清除邏輯（`session.defaultSession.clearStorageData()` +
`app.relaunch()`/`app.exit()`）不變。

## 待辦：補建 GitHub Issue

跟前三份 spec 一樣，這台機器沒有 `gh` CLI。日後裝好並登入後：

```bash
gh issue create \
  --repo reqw123/question \
  --title "desktop-pet：語音輸入（STT，點擊切換錄音＋靜音自動停止）" \
  --body-file docs/specs/0004-desktop-pet-voice-input.md \
  --label ready-for-agent
```
