# desktop-pet-web：高精度 3D 展示卡片手勢動作觸發（MediaPipe GestureRecognizer，純前端頁面本地效果）

> **狀態**：已實作（2026-08-18）。程式碼＋單元測試已完成，`tsc -b`／`oxlint`／`vitest run`／`vite build` 均已跑過且全過，**手動瀏覽器/鏡頭驗證（Acceptance Criteria）尚未執行**——見文末「實作備註」。
> **打算套用的 triage 標籤**：`ready-for-agent`。
> **依賴**：`docs/adr/0013-desktop-pet-web-gesture-action-trigger-scope.md`（為什麼跟操控模式互斥、為什麼只做一種手勢、為什麼不橋接真的桌寵，務必先讀）、`CONTEXT.md`（「手勢動作觸發」與「手勢拖曳」「本機控制面板」的用詞區分）、`src/pages/desktop-pet/components/Aatrox3DShowcase.tsx`（本次擴充的宿主元件，`triggerSelectedAction()` 已經是可重用函式，見下方 Solution）、`src/pages/desktop-pet/components/gesture-drag/`（`GestureDragControl.tsx`／`gestureMath.ts`，鏡頭權限/`GestureRecognizer` 載入/錯誤訊息的既有寫法，本次直接照抄同一套慣例，不重新設計）。

## Problem Statement (Goal)

高精度 3D 模型展示卡片（Aatrox3DShowcase）目前有兩種觸發動作的方式：下拉選單直接切換、操控模式下按空白鍵播放下拉選單目前選定的動作（見 `triggerSelectedAction()`）。這次要加第三種：**開鏡頭比手勢也能觸發同一件事**——比 👍（`Thumb_Up`）＝播放下拉選單目前選定的動作，等於「鏡頭版的空白鍵」。這個功能必須是選配的（預設不啟用、不佔用鏡頭），失效時完全不能影響卡片既有功能，也完全不能碰真正在使用者電腦上跑的 `desktop-pet` Electron App。

## Solution

新增一個獨立的手勢模式，複用 `gesture-drag/` 已經寫好的 `@mediapipe/tasks-vision` `GestureRecognizer` 載入方式，只在使用者主動點擊「手勢模式」按鈕後才要求鏡頭權限、開始運作。

### 流程

1. Aatrox3DShowcase 卡片新增一顆「手勢模式」按鈕，跟現有「進入操控模式」按鈕並列。兩者互斥：手勢模式開啟時操控模式按鈕 disable（反之亦然），一次只能有一種輸入方式在跑。
2. 點擊「手勢模式」→ 動態 `import()` 新元件（例如 `AatroxGestureTrigger.tsx`），呼叫 `getUserMedia` 要求鏡頭權限，載入 `gesture_recognizer.task` + wasm runtime（`FilesetResolver.forVisionTasks('/mediapipe/wasm')`，資源路徑跟 `gesture-drag` 共用同一份 `public/mediapipe/`，不需要重新自架）。
3. 啟用成功後，3D 展示區右下角疊一個小視窗（PIP）：鏡頭畫面（水平鏡像）＋手部骨架疊圖＋目前偵測到的手勢文字（例如「👍 Thumb_Up」或「未偵測到手」）。3D 模型畫面本身全程保持可見，不被鏡頭畫面遮住。
4. 每一幀呼叫 `gestureRecognizer.recognizeForVideo(video, performance.now())`，讀 `gestures[0].categoryName`。
5. **邊緣觸發判定**：維持一個「目前是否處於 Thumb_Up 狀態」的旗標。從「非 Thumb_Up」轉成「連續偵測到 Thumb_Up 達到穩定門檻（見下方 Implementation Decisions 的防手震処理）」的那一刻，呼叫一次 `triggerSelectedAction()`，並把旗標設為 true；之後持續偵測到 Thumb_Up 不會重複觸發，直到偵測結果連續轉為「非 Thumb_Up」達到同樣的穩定門檻，旗標才重置為 false，允許下一次觸發。
6. 下拉選單在手勢模式開啟時比照操控模式的既有規則一起 `disabled`（跟 `controlMode` 同一條 disabled 判斷式，改成 `status !== 'ready' || controlMode || gestureMode`）。
7. 使用者再按一次「手勢模式」按鈕關閉、或離開頁面、或這個 section 滾出 `IntersectionObserver` 視窗（比照既有 WebGL 延遲初始化的邏輯）：停止偵測迴圈、呼叫 `gestureRecognizer.close()`、停止所有 `MediaStreamTrack`、隱藏 PIP。

## User Stories (Requirements)

1. As 訪客，I want 一顆清楚的「手勢模式」按鈕，so that 我知道這是選配功能，不會一進到這張卡片就被要求開鏡頭。
2. As 訪客，I want 啟用後在卡片角落看到自己的手跟骨架疊圖＋目前手勢名稱，so that 我知道鏡頭有抓到我的手、也知道現在比的手勢有沒有被系統認出來。
3. As 訪客，I want 比 👍 之後角色立刻播放我在下拉選單選的動作，so that 我可以體驗到「手勢真的能操控角色」的因果關係。
4. As 訪客，I want 比着 👍 不放不會讓角色瘋狂重複播動作，so that 手勢觸發的手感跟空白鍵一致、不會覺得失控。
5. As 訪客，I want 拒絕鏡頭權限或瀏覽器不支援時，卡片其餘功能（下拉選單、操控模式、空白鍵）完全正常，so that 這個附加功能失效不會壞了我原本想玩的東西。
6. As 訪客，I want 關閉手勢模式或離開頁面後鏡頭確實釋放，so that 我不會擔心背景一直在錄影。
7. As 開發者（未來的我），I want 手勢邏輯是獨立模組、只透過呼叫 `triggerSelectedAction()` 跟 Aatrox3DShowcase 溝通，so that 之後要調整手勢判定邏輯不用碰 three.js/動畫混合的程式碼，反之亦然。

## Implementation Decisions

### 複用 `gesture-drag` 的載入/資源慣例，不重新自架

`@mediapipe/tasks-vision` 已經是既有 npm 依賴，`gesture_recognizer.task`／wasm runtime 已經複製進 `public/mediapipe/`（見 `docs/specs/0010`）。這次**不新增任何依賴、不新增任何靜態資源**，`FilesetResolver.forVisionTasks('/mediapipe/wasm')`／`GestureRecognizer.createFromOptions(vision, { baseOptions: { modelAssetPath: '/mediapipe/models/gesture_recognizer.task', delegate: 'GPU' }, runningMode: 'VIDEO', numHands: 1 })` 照抄 `GestureDragControl.tsx` 的寫法，GPU 失敗 retry CPU 的邏輯也一併照抄。

### 只需要手勢分類，不需要碰 hit-test／hold 計時／clamp

跟 `gesture-drag` 不同，這次不需要座標換算、不需要判斷指尖有沒有觸碰模型、不需要拖曳/clamp——只需要 `gestures[0].categoryName` 這一個欄位。`gestureMath.ts` 那批純函式（`computeGrabOffset`／`dragPosition`／`clampModelPosition` 等）跟這次無關，不需要 import，也不需要為了共用而修改那個檔案。

### 邊緣觸發的防手震処理

手勢分類是逐幀回報（約 20-30fps），單幀雜訊可能讓 `Thumb_Up` 中間閃一幀 `None` 又跳回來，如果單純「上一幀不是 Thumb_Up、這一幀是 Thumb_Up」就觸發，容易被雜訊誤判成「使用者放開又比了一次」而重複觸發。改成**連續 N 幀（建議 N=3，約 100-150ms）** 分類結果一致才視為「狀態真的改變」，觸發判定/重置判定都套用同一個穩定門檻。這不是 Q9 講的「冷卻時間」（冷卻時間是觸發後鎖住一段時間，這裡是「狀態轉換前先確認幾幀」），使用者放開再比一次的邊緣觸發手感不變，只是多了防手震層，避免真實鏡頭雜訊造成的誤觸發。

### 元件邊界

新增 `src/pages/desktop-pet/components/aatrox-gesture/AatroxGestureTrigger.tsx`，只做「鏡頭權限＋手勢分類＋邊緣觸發判定＋畫 PIP」，透過一個 prop 呼叫外部傳入的 `onGestureTrigger: () => void`（Aatrox3DShowcase 傳 `() => triggerSelectedActionRef.current()`，用法比照現有 `playAnimationRef`／`resetPoseRef` 那批 ref-based 橋接）。`AatroxGestureTrigger` 完全不知道「Aatrox」「動作」「three.js」這些概念，Aatrox3DShowcase 也完全不知道 MediaPipe 存在，兩邊只透過這一個 callback prop 溝通。

### 失效隔離

- 手勢模組整段用動態 `import()`，不啟用就完全不下載、不初始化，不會拖慢卡片首次渲染。
- `getUserMedia`／`FilesetResolver`／`GestureRecognizer.createFromOptions` 任何一步失敗，在「手勢模式」按鈕旁顯示一行不擋路的錯誤訊息（沿用 `gesture-drag` 的 `describeError()` 文字），按鈕維持可再次嘗試，不影響卡片其餘功能。
- `delegate: 'GPU'` 失敗自動 retry `'CPU'` 不算失敗，只有兩次都失敗才顯示錯誤訊息。

## Testing Decisions

- **會寫單元測試（純函式，不碰真的 MediaPipe/three.js）**：邊緣觸發＋穩定門檻的狀態機（連續 N 幀一致才轉換狀態、觸發時機、重置時機），比照 `gestureMath.test.ts` 的寫法抽成一個獨立純函式（例如 `gestureTriggerState.ts`），用假的 `categoryName` 序列驗證。
- **刻意不寫自動測試**（跟本 repo 既有慣例一致，見 `docs/specs/0010` Testing Decisions）：`getUserMedia` 串流處理、`GestureRecognizer` 實際載入與推論、PIP 疊加畫面、按鈕點擊/UI 互動——這些需要真的瀏覽器鏡頭與 WASM 環境，用手動跑起來驗證（見下方 Acceptance Criteria）。

## Acceptance Criteria

1. 開啟 desktop-pet-web，捲到高精度 3D 展示區，看得到「手勢模式」按鈕；頁面載入當下、進入這張卡片當下都**不會**跳出鏡頭權限請求。
2. 按下「手勢模式」→ 跳出瀏覽器鏡頭權限請求 → 允許後，卡片角落出現 PIP（鏡頭畫面＋骨架疊圖＋手勢文字），3D 模型畫面本身仍然完整可見。
3. 手勢模式開啟時，「進入操控模式」按鈕跟下拉選單都變成 disabled；再按一次「手勢模式」關閉後兩者恢復可用。
4. 比 👍 → 角色立刻播放下拉選單目前選定的動作，跟操控模式下按空白鍵的效果一致（含 Attack 系列的截斷+收劍過場、其他動作的自然播完接回待機，都是同一個 `triggerSelectedAction()`）。
5. 比着 👍 持續不放 → 動作只觸發一次，不會重複播放/閃爍。
6. 放開（比其他手勢或放下手）幾幀後再比一次 👍 → 可以再次觸發。
7. 手離開鏡頭畫面 → PIP 顯示「未偵測到手」，不會誤觸發。
8. 再按一次「手勢模式」按鈕關閉，或離開/重新整理頁面，或把這個 section 捲出畫面 → 瀏覽器分頁鏡頭指示燈確實熄滅。
9. 刻意拒絕鏡頭權限 → 按鈕旁出現清楚的錯誤訊息，卡片其餘功能（下拉選單、操控模式、WASD/空白鍵）完全不受影響，行為跟這個功能不存在時一樣。
10. 全程不需要真正在使用者電腦上執行 `desktop-pet` Electron App——手勢模式跟桌寵是否有在跑無關。

## Edge Cases

- **同時有兩隻手進到鏡頭畫面**：`numHands: 1`，`GestureRecognizer` 只會回傳信心值最高的一隻手，不需要額外篩選。
- **手勢模式開啟中，角色正在播攻擊動畫（`isAttacking === true`）時比出 👍**：`triggerSelectedAction()` 本身已經支援「連續觸發直接打斷重播」（見 Aatrox3DShowcase 既有邏輯），手勢觸發跟空白鍵觸發共用同一個函式，行為天生一致，不需要額外處理。
- **手勢模式開啟中，這個 section 被捲出可視範圍**：比照現有 WebGL 渲染迴圈的 `IntersectionObserver` 停用邏輯，一併停止手勢偵測＋釋放鏡頭，捲回來不自動恢復（要重新按一次「手勢模式」按鈕），避免使用者捲走了卻不知道鏡頭還開著。
- **瀏覽器不支援 WASM SIMD／`getUserMedia`（極舊瀏覽器）**：走一般錯誤訊息路徑，不特別偵測瀏覽器版本，跟 `gesture-drag` 一致。

## Out of Scope

- **不橋接控制真正的桌寵**——見 ADR-0013，完全不碰 `control-server.js`／`main.js`。
- **不做操控模式（WASD）跟手勢模式同時並存**——見 ADR-0013，一次只能開一種輸入方式。
- **不做第二種手勢對應其他動作**——這次只做 👍＝觸發下拉選單選定的動作，見 ADR-0013。
- **不做手勢對移動/鏡頭視角的控制**——手勢模式不牽涉移動，角色位置/鏡頭沿用進入手勢模式當下的狀態。
- **不做啟用狀態跨頁面造訪的持久化**——每次重新載入頁面都是預設關閉，要重新按一次按鈕才會再要求鏡頭權限。

## Further Notes

- 相關文件：`docs/adr/0013-desktop-pet-web-gesture-action-trigger-scope.md`（為什麼跟操控模式互斥、為什麼只做一種手勢、為什麼不橋接桌寵）、`CONTEXT.md`（「手勢動作觸發」跟「手勢拖曳」「本機控制面板」的用詞區分，避免被讀成同一件事）。
- `triggerSelectedAction()` 是上一個任務（空白鍵改成播放下拉選單選定的動作）新增的可重用函式，這次手勢模式是它的第二個呼叫端（第一個是空白鍵的 `handleKeyDown`）——這也是為什麼這次的核心邏輯量體很小：真正新寫的只有「手勢分類 → 邊緣觸發判定 → 呼叫既有函式」這一段橋接，動作播放/收劍過場/連續觸發打斷全部不需要重寫。

## 實作備註（2026-08-18）

- **新增檔案**：`src/pages/desktop-pet/components/aatrox-gesture/gestureTriggerState.ts`（純函式：邊緣觸發＋防手震狀態機，含 `gestureTriggerState.test.ts` 8 個測試）、`AatroxGestureTrigger.tsx`（元件本體，鏡頭權限/`GestureRecognizer` 載入/骨架繪圖照抄 `gesture-drag/GestureDragControl.tsx` 的既有寫法，未抽共用模組——量體小，見 Implementation Decisions）。`Aatrox3DShowcase.tsx` 新增 `triggerSelectedActionRef`（把定義在掛載 effect 閉包裡的 `triggerSelectedAction()` 轉手給平行掛載的手勢元件呼叫，跟 `playAnimationRef`／`resetPoseRef` 同一種橋接模式）、`gestureMode`／`gestureError` 兩個 state、手勢模式按鈕、`IntersectionObserver` 捲出視窗時一併 `setGestureMode(false)`。
- **邊緣觸發實作跟原訂計畫的差異**：Q9 討論時講的是「邊緣觸發，比着不放不會重複觸發」，實作時額外加了 `STABLE_FRAMES=3`（約 100ms，見 `gestureTriggerState.ts`）連續幀穩定門檻，觸發跟重置（重新可觸發）判定都套用同一個門檻，防止 MediaPipe 逐幀分類的雜訊（`Thumb_Up` 中間閃一幀 `None` 又跳回來）被誤判成「放開又比一次」而重複觸發。這不是 Q9 討論過的「冷卻時間」方案（冷卻時間是觸發後鎖住一段時間），純粹是邊緣觸發本身在真實逐幀雜訊下的必要防禦，手感（比着不放只觸發一次、要先放開再比一次）跟訪談定案的一致。
- **驗證狀態**：`tsc -b`／`oxlint`（新增/修改的檔案零警告零錯誤）／`vitest run`（27/27，含既有 `gestureMath.test.ts` 19 個＋新增 `gestureTriggerState.test.ts` 8 個）／`vite build` 均已跑過且全過（`vision_bundle` 確認沿用既有的獨立 code-split chunk，跟 `gesture-drag` 共用同一份，沒有因為這次新增第二個動態 `import('@mediapipe/tasks-vision')` 而變成兩份)。**Acceptance Criteria 列的 10 項手動瀏覽器＋真實鏡頭驗證還沒有人跑過**，這台機器目前無法起真的瀏覽器/鏡頭去驗證，需要使用者自己 `npm run dev` 之後在瀏覽器裡照 Acceptance Criteria 逐項測過一輪，尤其是：手勢模式/操控模式的按鈕互斥是否如預期互相 disable、PIP 疊圖有沒有正確疊在 3D 模型上層且不擋住既有的操控模式提示文字（兩者一次只會有一個顯示，理論上不會同時出現，但值得順手看一眼）。

## 待辦：補建 GitHub Issue

跟前幾份 spec 一樣，如果這台機器沒有 `gh` CLI 或尚未登入，日後補建：

```bash
gh issue create \
  --repo reqw123/question \
  --title "desktop-pet-web：高精度 3D 展示卡片手勢動作觸發（MediaPipe GestureRecognizer）" \
  --body-file docs/specs/0012-desktop-pet-web-gesture-action-trigger.md \
  --label ready-for-agent
```
