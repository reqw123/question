# desktop-pet：嘴型同步（Lip Sync）

> **狀態**：spec 完成，尚未建立對應的 GitHub issue（這台機器沒有 `gh` CLI，見文末待辦）。
> **打算套用的 triage 標籤**：`ready-for-agent`。
> **依賴**：`docs/research/lip-sync-feasibility.md`（可行性研究，已完成）、`docs/specs/0001-desktop-pet-tts-playback.md`（語音播放管線）。

## Problem Statement (Goal)

角色講話（語音測試／即時對話）時嘴巴不會動，只維持原本的待機動畫，跟實際播放的語音對不上，是先前 grilling session 明確排除在 v1 之外、標記「最有研究價值」的項目。可行性研究已確認技術路徑可行，且**完全不用修改任何共用/唯讀檔案**（`lib/live2d.js`、`lib/*.min.js`、`live2d_my_like/`）。

**已知風險（使用者已同意接受、不先查證直接開始）**：角色一/二目前預設載入的模型（076/077）的 `model3.json` 都沒有宣告 `LipSync` 參數群組，實際有沒有可驅動的嘴巴參數要跑起來才知道。本 spec 的架構會對這個風險做防呆——找不到嘴巴參數的角色，自動跳過嘴型同步、退回原本「不動嘴巴但正常播語音」的行為，不會整個功能掛掉或報錯。

## Solution

在 `desktop-pet/index.html`（應用程式碼，不是共用檔案）新增一個以 `AnalyserNode` 分析 TTS 語音音量、透過已經在用的 `PIXI.Ticker.shared` 每幀把音量值寫進角色的嘴巴參數（`coreModel.setParameterValueById`/`setParamFloat`，跟 `lib/live2d.js` 的 `_applyParamOverrides` 用同一組 public API）的機制。角色開始播放語音時啟動，語音結束/停止時嘴巴自動閉合、交還控制權給原本的待機動畫。

## User Stories (Requirements)

1. As the desktop-pet 使用者，I want 角色講話時嘴巴會跟著音量開合，so that 語音播放時角色看起來真的在「說話」，不是嘴巴不動配音畫面兜不起來。
2. As the desktop-pet 使用者，I want 語音播放結束後嘴巴自動閉合、恢復原本待機動畫，so that 沒講話的時候不會卡在張嘴的畫面。
3. As the desktop-pet 使用者，I want 如果目前角色的模型根本沒有可用的嘴巴參數，嘴型同步安靜跳過、語音跟文字泡泡照常正常運作，so that 這個功能的風險不會波及既有的語音播放能力。
4. As the desktop-pet 使用者，I want 嘴型同步不會讓語音本身變安靜或延遲，so that 加了這個視覺效果不會犧牲既有的聽覺體驗。
5. As the desktop-pet 使用者，I want 兩個角色都在講話時（理論上不會同時發生，但架構要對得起這個可能性）嘴型同步不會互相干擾，so that 角色一跟角色二的嘴巴各自對應各自的語音。
6. As the desktop-pet 開發者（未來的我），I want 嘴型同步的音量計算邏輯是一個獨立、可測試的純函式，so that 之後要調整嘴巴開合的靈敏度/平滑度，不用整個功能重新手動測試才能確認邏輯對不對。

## Implementation Decisions (Architecture)

### 音量分析 → 嘴巴開合值（測試 seam）

- 新增 `desktop-pet/lipsync.js`：純函式模組，不 import Web Audio API／PIXI／Electron，介面：
  `analyzeMouthOpenness({ timeDomainData, previousValue, gain?, smoothing?, minThreshold? }) → number`（0~1，Cubism 慣例的參數值域）。
  - `timeDomainData`：`Uint8Array`，格式跟 `AnalyserNode.getByteTimeDomainData()` 回傳的一致（0~255，128 是靜音中心點）——呼叫端負責從真正的 `AnalyserNode` 拿到這包資料餵進來，這個函式本身完全不碰 Web Audio API，方便單元測試（測試時直接建構 `Uint8Array` 字面量當輸入）。
  - 內部：算 RMS（均方根振幅）→ 套用門檻值（太小聲當作沒在講話，避免背景噪音讓嘴巴一直微微張開）→ 套用增益 → 跟前一幀的值做指數平滑（避免每幀跳動讓嘴巴看起來在抖動）→ clamp 到 0~1。
  - 匯出 `computeRms(timeDomainData)` 作為內部小工具函式一併匯出，方便獨立測試（不用每個案例都繞過完整的平滑/門檻邏輯）。

### 每個角色的嘴巴參數 ID 偵測（防呆，對應 User Story 3）

- 沿用 `lib/live2d.js` 現有的 `L2D._getParamIds(coreModel)`（`_applyParamOverrides` 已經在用的同一個方法，回傳這個模型實際有的 Parameter ID 清單的 `Set`，是 public 方法可以直接呼叫，不算修改共用檔案）。
- 候選嘴巴參數 ID 清單（研究報告發現不同模型大小寫不一致）：`['ParamMouthOpenY', 'PARAM_MOUTH_OPEN_Y']`，依序檢查哪個存在於該角色模型的參數清單裡，取第一個命中的當作這個角色本次執行期間要用的嘴巴參數 ID。
- 角色載入完成時（`state.ready` 之後）偵測一次、快取結果；候選清單都沒命中就記錄「這個角色沒有可用的嘴巴參數，嘴型同步跳過」，之後這個角色永遠不會嘗試寫入嘴巴參數，也不會每幀重複警告洗版。

### 驅動邏輯（跟現有 Ticker 精確共存，對應研究報告§5.4 的優先度陷阱）

- 用 `PIXI.Ticker.shared.add(fn, null, PIXI.UPDATE_PRIORITY.LOW + 1)` 註冊——跟 `lib/live2d.js` 的 `_attachVisibilitySync` **同一個優先度插槽**（`NORMAL`〔pixi-live2d-display 自己跑 `model.update()` 更新曲線〕跟 `LOW`〔PIXI 渲染〕之間），確保嘴型同步的寫值發生在模型自己的曲線更新「之後」、畫面渲染「之前」，不會被同一幀的曲線更新蓋掉。
- 這個 callback 每幀執行：檢查目前有沒有正在播放的 TTS audio、該角色有沒有偵測到嘴巴參數 ID——兩者都成立才讀 `AnalyserNode` 資料、算開合值、寫入參數；沒有播放中的語音就寫 `0`（閉嘴），交還控制權給原本的待機動畫曲線。

### AnalyserNode 接線（對應研究報告§5.2/5.3 的坑）

- `playTtsAudio()` 建立 `new Audio(...)` 之後，建立（或重用同一個）`AudioContext` + `createMediaElementSource(audioEl)` + `AnalyserNode`，**一定要**把 `analyser` 接回 `audioContext.destination`（不接的話音訊會被導去 Web Audio 的分析圖但出不了喇叭，變成語音整個沒聲音——研究報告點名的陷阱，AC 會涵蓋這一項）。
- `createMediaElementSource()` 對同一個 `<audio>` 元素只能呼叫一次；`playTtsAudio()` 每次語音測試/對話回覆都會 `new Audio(...)` 一個全新的元素（既有行為，見 `0001` spec），所以這裡不會撞到「同一個元素重複呼叫」的限制，不用額外處理。

### 跟現有語音管線的整合點

- 不改 `preload.js`/`main.js` 的任何 IPC——嘴型同步完全是 renderer 端（`index.html`）自己的事，main process 不需要知道嘴巴有沒有在動。
- `playTtsAudio(audioBase64, charKey)`：目前這個函式簽名沒有帶 `charKey`（見 `0001`/`0002` spec 的既有實作），這裡要**新增**這個參數（呼叫端 `onPlayTtsAudio` 的事件資料也要跟著多帶 `charKey`），嘴型同步才知道該驅動哪個角色的模型——這是對既有介面的小幅擴充，不是重新設計。

## Testing Decisions

- 只測 `lipsync.js` 的 `analyzeMouthOpenness()`／`computeRms()`——純函式、輸入是字面量 `Uint8Array`、輸出是可斷言的數值範圍，不用 mock 任何東西，也不需要 jsdom/瀏覽器環境（跟 `tts.js`/`chat.js`/`page-digest.js` 用同一套 vitest 設定就能跑，不用新增測試環境設定）。
- 案例：全靜音輸入（所有值=128）→ 輸出趨近 0；滿振幅輸入（例如交替 0/255）→ 輸出接近上限 1；低於門檻的小聲輸入 → 輸出 0（被門檻濾掉）；輸出永遠 clamp 在 0~1 之間即使給極端的 gain／輸入；平滑效果：前一幀是高值、這一幀輸入突然靜音，輸出應該是介於兩者之間的漸變值，不是瞬間掉到 0。
- **刻意不寫自動測試**：`AnalyserNode`/`AudioContext` 接線、`PIXI.Ticker` 註冊、`L2D._getParamIds()` 偵測、實際的 `setParameterValueById` 呼叫——這些都需要真實瀏覽器/PIXI/Cubism 執行環境，跑起來手動驗證（對應 Acceptance Criteria）。

## Acceptance Criteria

1. 語音測試/即時對話觸發角色講話 → 嘴巴跟著音量明顯開合，不是完全不動、也不是跟語音對不上的固定節奏抖動。
2. 語音播放結束 → 嘴巴在語音結束後很快閉合（不會卡在張嘴或緩慢淡出很久），恢復原本的待機動畫。
3. 語音播放中途被新的一句話打斷（`0001` spec 既有的「新語音進來停掉舊的」邏輯）→ 舊的嘴型同步跟著停止，新的一句話接手，不會兩段疊在一起。
4. 加了嘴型同步之後，語音音量/音質/播放延遲跟加之前沒有可感知的差異。
5. 若目前角色的模型偵測不到候選清單裡任何一個嘴巴參數 ID → 嘴型同步整個跳過這個角色，語音照常播放、文字泡泡照常顯示，終端機/console 印一次警告（不是每幀都印）。
6. 角色一在講話、角色二沒有 → 只有角色一的嘴巴動，角色二維持原本待機動畫不受影響。
7. 桌寵啟動、角色還在載入完成之前 → 不會因為嘗試存取還沒 ready 的模型而報錯。

## Edge Cases

- **候選清單裡的參數 ID 存在，但實際上沒有被綁定到任何看得見的網格變形**（研究報告 §7 明確點名：「ID 存在不保證真的有視覺效果」）——這種情況嘴型同步「技術上成功執行」但畫面上看不出效果，不算功能故障，是模型本身的限制，Further Notes 會記錄這個已知落差。
- **AudioContext 建立失敗或被瀏覽器自動播放政策擋下**：分析/驅動邏輯整個包在 try/catch，失敗只記錄警告，語音播放本身（既有的 `a.play()`）不能因此連帶失敗——嘴型同步是語音播放的加分項，不能變成語音播放的單點故障。
- **使用者靜音了對話語音回覆的音量鈕**（見拆開後的 TTS 靜音開關）：語音是靜音播放（`muted=true`），但音訊資料本身還是在流動——嘴型同步要不要在靜音時也跟著不動嘴巴，或是照樣分析音量、只是聽不到聲音？決定：**靜音時嘴巴也不動**（跟静音鈕「桌寵安不安靜」的心智模型一致——沒聲音，嘴巴也不用裝忙）。
- **快速連續觸發多次語音測試**：舊語音被停掉時，對應的嘴型同步 Ticker 回呼也要跟著停止讀取已經 `pause()` 的舊 audio 元素，不要對一個不再播放的元素持續呼叫 `getByteTimeDomainData()`（沒有實際壞處，但是浪費運算、也可能讀到過期資料）。

## Out of Scope

- **修正 076/077 模型本身缺少 `LipSync` 參數群組宣告**——那是編輯 `.model3.json`/模型資源本身，超出「唯讀引用 `live2d_my_like/`」的既有原則，且屬於美術/模型製作範疇，不是這次的工程範圍。
- **精細的音素對嘴型（phoneme-based lip sync，例如 A/I/U/E/O 嘴型分類）**——只做「音量大小 → 嘴巴開合程度」這種簡化版，不做真正對嘴型的語音辨識分析，那是完全不同量級的工程。
- **依角色客製化 gain/smoothing 參數**——先用同一組預設值套用所有角色，之後真的覺得某個角色嘴巴開合幅度不對，再考慮做成 per-model 設定。
- **閒置閒聊（`idle-chat.json`）的嘴型同步**——ADR-0004 已經確定閒置閒聊沒有語音（純文字泡泡），沒有音訊可以分析，這個功能天生不適用。

## Further Notes

- 這是本次規劃的第三份、也是最後一份 spec（`0001` 語音播放、`0002` 即時對話、`0003` 嘴型同步），完成後原本 grilling session 列的五類功能建議（1️⃣~5️⃣）全部有對應的實作或研究產出。
- 相關文件：`docs/research/lip-sync-feasibility.md`（技術可行性研究，本 spec 的架構決策幾乎全部直接引用它的結論）、`docs/specs/0001-desktop-pet-tts-playback.md`（`playTtsAudio()` 既有實作，本 spec 會擴充它的簽名加上 `charKey`）。

## 待辦：補建 GitHub Issue

跟前兩份 spec 一樣，這台機器沒有 `gh` CLI。日後裝好並登入後：

```bash
gh issue create \
  --repo reqw123/question \
  --title "desktop-pet：嘴型同步（Lip Sync）" \
  --body-file docs/specs/0003-desktop-pet-lip-sync.md \
  --label ready-for-agent
```
