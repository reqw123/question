# desktop-pet-web：Live2DCard 手勢拖曳（MediaPipe Tasks Vision GestureRecognizer，純前端頁面本地效果）

> **狀態**：已實作（2026-08-10），尚未建立對應的 GitHub issue（這台機器沒有 `gh` CLI，見文末待辦）。程式碼＋單元測試已完成，**手動瀏覽器/鏡頭驗證（Acceptance Criteria）尚未執行**——見文末「實作備註」。
> **打算套用的 triage 標籤**：`ready-for-agent`。
> **依賴**：`docs/adr/0011-desktop-pet-web-gesture-drag-scope.md`（為什麼只作用在頁面本地卡片、不橋接真正桌寵，務必先讀）、`CONTEXT.md`（「手勢拖曳」與「本機控制面板」的用詞區分）、`desktop-pet-web/src/pages/desktop-pet/components/HeroLive2DStage.tsx`（原本叫 `Live2DCard.tsx`，2026-08-10 改成單一共用 PIXI 畫布架構後改名，見文末「改版：整個 Hero 區塊改用單一共用 PIXI 畫布」段落——本文件前半段部分敘述停留在改名前的舊檔名/舊架構，屬於歷史記錄，不是寫錯）。

## Problem Statement (Goal)

desktop-pet-web 首頁 Hero 區塊的 Live2DCard 目前只能用滑鼠點擊觸發角色技能動作、用箭頭/圓點切換三張卡片。使用者想要多一種用手勢跟卡片模型互動的方式。經過需求訪談，範圍收斂成一個具體、獨立的互動：**用手指觸碰模型、停留兩秒選定、跟隨手部移動、比出握拳（石頭）放開**——不做其餘手勢對應其他動作、不橋接控制真正在使用者電腦上跑的桌寵（見 ADR-0011）。這個功能必須是選配的（預設不啟用、不佔用鏡頭），失效時完全不能影響既有頁面功能。

## Solution

新增一個獨立、lazy-loaded 的前端模組，使用 `@mediapipe/tasks-vision` 的 `GestureRecognizer` 類別做手部追蹤＋手勢分類，只在使用者主動點擊「啟用手勢拖曳」之後才要求鏡頭權限、開始運作。

### 流程

1. Live2DCard 卡片新增一顆「啟用手勢拖曳」切換按鈕（跟翻牌箭頭同一層、卡片一角）。
2. 點擊後才動態 `import()` 手勢模組，呼叫 `getUserMedia` 要求鏡頭權限，載入自架的 `gesture_recognizer.task` + wasm runtime。
3. 啟用成功後，卡片旁顯示鏡頭畫面（水平鏡像）＋即時手部骨架疊圖，預設開啟、可收合關閉。
4. 每一幀呼叫 `gestureRecognizer.recognizeForVideo(video, performance.now())`，同時拿到 21 點 `landmarks`（含食指指尖 landmark #8）與內建手勢分類 `gestures[0].categoryName`——不需要另外建立 `HandLandmarker` 實例（見下方 Implementation Decisions 的「模型精簡」）。
5. 把食指指尖的 normalized 座標換算成目前顯示中模型所在畫布的本地座標（處理鏡像＋鏡頭畫面與 canvas 長寬比不同的對應）。
6. 判斷指尖是否落在目前模型的「緊致外框」內（見下方，重用既有的 alpha 邊框）：
   - 在框內 → 累積停留時間，卡片上顯示繞著指尖的進度環（0→2000ms 填滿）。
   - 停留期間指尖離開外框、或該幀偵測不到手 → 進度**重置為 0**（不是暫停續接）。
   - 累積滿 2000ms → 進入「已選定」狀態，記錄「指尖觸碰點」與「模型當時位置」的相對 offset。
7. 已選定狀態下，每一幀依 `(指尖目前位置 − 初始觸碰點) + 模型初始位置` 更新模型 `position`，並 clamp 讓模型的緊致外框保持完全落在畫布邊界內（不能拖出卡片）。
8. 已選定狀態下，偵測到 `gestures[0].categoryName === 'Closed_Fist'`（握拳，剪刀石頭布的「石頭」），或該幀偵測不到手／信心值過低 → 立即結束選定，模型停在最後位置，不重新置中、不觸發任何額外動作。
9. 再次觸碰模型可重新選取、重新拖曳（回到步驟 6）。
10. 使用者再按一次「啟用」按鈕關閉、或離開頁面、或切換輪播卡片（ModelStage 整個重新掛載）：停止偵測迴圈、呼叫 `gestureRecognizer.close()`、停止所有 `MediaStreamTrack`、隱藏鏡頭 preview。

## User Stories (Requirements)

1. As 訪客，I want 一顆清楚的「啟用手勢拖曳」按鈕，so that 我知道這是選配功能，不會一進站就被要求開鏡頭。
2. As 訪客，I want 啟用後看得到自己的手跟骨架疊圖，so that 我知道鏡頭有抓到我的手、也知道怎麼瞄準模型。
3. As 訪客，I want 觸碰模型時看到進度環，so that 我知道「長按選定」正在生效，不是沒反應。
4. As 訪客，I want 選定後模型跟著我的手移動、比出石頭後模型停住，so that 我可以用手把角色拖到卡片裡想要的位置。
5. As 訪客，I want 拒絕鏡頭權限或瀏覽器不支援時，頁面其餘功能（輪播、點擊觸發動作、控制面板）完全正常，so that 這個附加功能失效不會壞了我原本想做的事。
6. As 訪客，I want 關閉這個功能或離開頁面後鏡頭確實釋放，so that 我不會擔心背景一直在錄影。
7. As 開發者（未來的我），I want 手勢/拖曳邏輯是獨立模組、跟 `Live2DCard.tsx` 之間只有一個小小的型別化介面，so that 之後要調整手勢邏輯不用碰 PIXI/Live2D 生命週期程式碼，反之亦然。

## Implementation Decisions

### 套件與資源自架

- `@mediapipe/tasks-vision` 用 npm 安裝（`desktop-pet-web` 已經是 Vite + npm 依賴的架構，跟現有 `motion`/`lucide-react` 同一套模式；不用 CDN `<script>`，那是 `desktop-pet`／`lib/` 那個純 script-tag 架構的做法，這裡不適用）。
- 比照這個 repo 既有慣例（`lib/live2d.js`、`live2d_my_like/models/*` 都是唯讀複製進 `public/`，不吃執行期 CDN），把 wasm runtime（`node_modules/@mediapipe/tasks-vision/wasm/*`）複製到 `desktop-pet-web/public/mediapipe/wasm/`，模型檔複製到 `desktop-pet-web/public/mediapipe/models/gesture_recognizer.task`。
- `FilesetResolver.forVisionTasks('/mediapipe/wasm')`、`GestureRecognizer.createFromOptions(vision, { baseOptions: { modelAssetPath: '/mediapipe/models/gesture_recognizer.task', delegate: 'GPU' }, runningMode: 'VIDEO', numHands: 1 })`，`delegate: 'GPU'` 失敗時 fallback `'CPU'`（`createFromOptions` 失敗時重試一次、把 delegate 換成 CPU，兩次都失敗才視為整個模組不可用）。

### 模型精簡：只用 GestureRecognizer，不另外建立 HandLandmarker

原始需求把「手部骨架（HandLandmarker）」跟「手勢分類（GestureRecognizer）」列成兩個步驟。查證官方文件（`developers.google.com/edge/mediapipe/solutions/vision/gesture_recognizer/web_js`）確認：`GestureRecognizerResult` 本身就包含 `landmarks`（21 點手部座標，畫骨架疊圖／判斷指尖是否觸碰模型都用這個）跟 `gestures`/`handedness`，`createFromOptions()` 只需要 `gesture_recognizer.task` 一個模型檔，不需要另外載入/引用 `hand_landmarker.task`。所以這次**只建立一個 `GestureRecognizer` 實例**，同時滿足「畫骨架＋判斷觸碰」跟「判斷放開手勢」兩個需求，不用兩個模型各跑一次——效能較好，自架資源也少一份大檔案。如果之後要做原始需求裡「pinch 等內建沒有的手勢」，才需要額外用 `landmarks` 自己算幾何關係，不需要另外的模型。

**這點跟原始需求字面上的兩步驟拆分不同，是本文件唯一一處主動的技術簡化，請在審閱時特別確認可以接受。**

### 觸碰判定：重用既有的 alpha 緊致外框

`Live2DCard.tsx` 現有的 `measureTightBounds()`／`scanAlphaBounds()` 已經算出每個模型「真正輪廓」的緊致外框（用來置中縮放模型，同一個框天生就適合拿來當手勢的碰撞區域，不用另外設計 hit-test）。指尖是否算「觸碰模型」＝指尖換算後的畫布座標是否落在這個框內，不需要更精確的逐像素判定。

### `Live2DCard.tsx` 的最小擴充介面（高內聚低耦合的具體做法）

`ModelStage` 目前把 PIXI model 實例關在自己內部（`modelRef` 是 private 的）。新增一個**唯一**的擴充點：

```ts
type ActiveModelHandle = {
  model: any // PIXI Live2DModel 實例
  tightBounds: Box // measureTightBounds() 算好的框（scale=1 本地座標）
  getCanvasSize: () => { width: number; height: number }
}

// Live2DCard 新增 optional prop：
onActiveModelChange？: (handle: ActiveModelHandle | null) => void
```

- 模型 `setState('ready')` 的同一時機呼叫一次 `onActiveModelChange(handle)`。
- `ModelStage` 的 cleanup（卡片切換、元件卸載）呼叫 `onActiveModelChange(null)`——**這一行就是「切換輪播卡片會自動清掉手勢選定狀態」的完整實作**，不需要手勢模組自己去監聽卡片切換事件。
- 手勢模組（新元件，例如 `GestureDragControl.tsx`）拿到 handle 之後直接讀寫 `handle.model.position`，`ModelStage` 完全不知道「手勢」這個概念存在，兩邊只透過這個型別化 handle 溝通。
- `Live2DCard` 本身不 import 手勢模組——手勢模組是包在 `Live2DCard` 外層的獨立元件（放在 Hero 裡，`<Live2DCard onActiveModelChange={...} /> <GestureDragControl ... />` 這種平行組合，不是 `Live2DCard` 內部 import），確保 `Live2DCard.tsx` 除了這一個 optional prop，完全不用改動既有邏輯。

### 座標換算與鏡像

- 鏡頭 `<video>` 用 CSS `transform: scaleX(-1)` 水平鏡像顯示（符合「像照鏡子」的直覺）；`landmarks` 的原始座標也要對應鏡像（`x' = 1 - x`）再拿去換算，確保「你的手往右移，畫面上的手影像也往右移」跟「畫布裡的模型跟著往右移」方向一致。
- `landmarks[8]`（食指指尖）是 normalized `[0,1]` 座標，先做鏡像修正，再乘上目前模型畫布的 `getCanvasSize()` 得到畫布本地像素座標。鏡頭畫面跟畫布長寬比不一定相同，用 `object-fit: cover` 等比例對應的方式換算，避免手往左右移動時跟畫面感覺對不齊。

### 拖曳與 clamp

- 選定當下記錄 `grabOffset = fingertipCanvasPos − model.position`；之後每一幀 `model.position = fingertipCanvasPos − grabOffset`（保留抓取時的相對位置，不是讓模型中心直接跳到指尖）。
- Clamp：更新後的 `model.position` 要讓 `tightBounds`（乘上目前 `model.scale`）矩形完全落在畫布 `[0, canvasWidth] x [0, canvasHeight]` 內，超出邊界就夾回邊界上。
- 視窗 resize 時既有的 `applyFit()` 邏輯不變（會重新置中縮放）——**手動拖曳過的位置不會在 resize 後被保留**，這是刻意的取捨（見 Out of Scope），避免為了一個小功能去改動既有 resize 邏輯的語意。

### 失效隔離（嚴格版，對應 Q2）

- 手勢模組整段用動態 `import()`，不啟用就完全不下載、不初始化，不會拖慢首頁載入。
- `getUserMedia`／`FilesetResolver`／`GestureRecognizer.createFromOptions` 任何一步失敗，都在「啟用手勢拖曳」按鈕旁邊顯示一行不擋路的錯誤訊息（例如「手勢功能目前無法使用：瀏覽器不支援鏡頭存取」），按鈕本身維持可再次嘗試，**不影響 Live2DCard 既有的翻牌／點擊觸發動作／其他頁面內容**。
- `delegate: 'GPU'` 失敗自動 retry `'CPU'` 不算失敗，只有兩次都失敗才顯示錯誤訊息。

## Testing Decisions

- **會寫單元測試（純函式，不碰真的 MediaPipe/PIXI）**：指尖座標換算＋鏡像、hit-test（是否落在 tightBounds 內）、hold 進度計時狀態機（累積/重置規則）、拖曳位置 clamp 公式。這幾塊都是純數學，用假的 landmark 座標／假的 Box 就能測。
- **刻意不寫自動測試**（跟本 repo `docs/specs/0006`／`0009` 對「薄膠水層／需要真實瀏覽器 API」的既有慣例一致）：`getUserMedia` 串流處理、`GestureRecognizer` 實際載入與推論、鏡頭 preview 疊加畫面、按鈕點擊/UI 互動——這些需要真的瀏覽器鏡頭與 WASM 環境，用手動跑起來驗證（見下方 Acceptance Criteria）。

## Acceptance Criteria

1. 開啟 desktop-pet-web 首頁，Hero 區塊的 Live2DCard 上看得到「啟用手勢拖曳」按鈕；頁面載入當下**不會**跳出鏡頭權限請求。
2. 按下按鈕 → 跳出瀏覽器鏡頭權限請求 → 允許後，卡片旁出現鏡頭畫面＋即時手部骨架疊圖。
3. 用食指指尖觸碰畫面中卡片內的模型輪廓、持續停留 → 看到繞著指尖的進度環逐漸填滿；中途把手移開模型輪廓，進度環歸零重新開始。
4. 停留滿 2 秒 → 模型進入「已選定」狀態（有明確視覺變化，如卡片邊框反應或模型本身表現），之後移動手部，模型跟著移動，且不會被拖出卡片邊界。
5. 比出石頭（Closed_Fist，握拳）→ 模型立即停在目前位置，不再跟隨手部。
6. 放開後再次觸碰模型 2 秒 → 可以重新選定並再次拖曳。
7. 切換輪播卡片（點箭頭/圓點/方向鍵）→ 手勢拖曳的選定狀態自動清空，新卡片的模型可以獨立被觸碰選定，不會殘留上一張卡片的拖曳狀態。
8. 拖曳中把手移出鏡頭畫面 → 模型立即停在最後位置（視同放開），不會卡在「幽靈拖曳」狀態。
9. 再按一次「啟用手勢拖曳」按鈕關閉，或離開/重新整理頁面 → 瀏覽器分頁鏡頭指示燈確實熄滅。
10. 刻意拒絕鏡頭權限 → 按鈕旁出現清楚的錯誤訊息，頁面其餘功能（輪播卡片切換、點擊模型觸發技能動作、下方本機控制面板按鈕）完全不受影響，行為跟這個功能不存在時一樣。
11. 全程不需要真正在使用者電腦上執行 `desktop-pet` Electron App——手勢拖曳跟桌寵是否有在跑無關。

## Edge Cases

- **拖曳中切換到瀏覽器其他分頁再切回來**：`requestAnimationFrame` 迴圈在背景分頁會被瀏覽器節流或暫停，回到分頁後應該無縫接續，不需要特殊處理（跟一般 rAF 迴圈行為一致）。
- **同時有兩隻手進到鏡頭畫面**：`numHands: 1`，`GestureRecognizer` 本來就只會回傳信心值最高的一隻手，不需要額外邏輯篩選。
- **選定其中一張卡片的模型後，該模型的「點擊觸發技能動作」互動**：手勢拖曳不會 dispatch 真正的 DOM click 事件，跟滑鼠點擊互不干擾，兩者可以並存（拖曳跟點擊播動作是完全獨立的輸入管道）。
- **視窗 resize 發生在拖曳中**：目前的 `ResizeObserver` 邏輯會呼叫 `applyFit()`，等同重新置中縮放——如果 resize 剛好發生在拖曳過程中，以 `applyFit()` 的結果為準（拖曳被此次 resize 覆蓋），跟「使用者手動拖曳過的位置不會在 resize 後保留」是同一個決定（見 Out of Scope）。
- **瀏覽器不支援 WASM SIMD／`getUserMedia`（極舊瀏覽器）**：`FilesetResolver.forVisionTasks()` 或 `getUserMedia` 會拋出例外，走一般錯誤訊息路徑，不特別偵測瀏覽器版本。

## Out of Scope

- **不橋接控制真正的桌寵**——見 ADR-0011，完全不碰 `control-server.js`／`main.js`。
- **不做原本討論過的 7 種內建手勢個別對應不同動作的方案**——已經被這次「觸碰拖曳」的單一互動取代，不會兩者並存。
- **不做超出 Hero 區塊的漫遊**——模型移動範圍限制在 Hero 區塊邊界內（2026-08-10 修訂，原本限制在卡片畫布邊界內；見 ADR-0011 修訂記錄、下方實作備註）。
- **拖曳後的位置不會在視窗 resize 後保留**——resize 會照既有邏輯重新置中縮放。
- **放開手掌不會觸發額外的動作/特效**——單純停在原地，沒有「放下時演一個動作」這種附加效果。
- **不做啟用狀態跨頁面造訪的持久化**——每次重新載入頁面都是預設關閉，要重新按一次按鈕才會再要求鏡頭權限。
- **不做雙手互動、不做 pinch 等自訂手勢幾何判斷**——這次只用內建的 `Closed_Fist`（石頭）分類，沒有用到需要自己算 landmark 距離/角度的手勢。

## Further Notes

- 相關文件：`docs/adr/0011-desktop-pet-web-gesture-drag-scope.md`（為什麼只作用在頁面本地、不橋接桌寵）、`CONTEXT.md`（「手勢拖曳」跟「本機控制面板」的用詞區分，避免被讀成同一件事）。
- `Live2DCard.tsx` 目前的三張模型（077／1024100／abeikelongbi_3）已經各自算好 alpha 緊致外框（`measureTightBounds()`），手勢拖曳的觸碰判定直接重用這個框，不需要為手勢功能另外設計一套碰撞偵測。

## 實作備註（2026-08-10）

- **新增檔案**：`src/pages/desktop-pet/components/gesture-drag/gestureMath.ts`（純函式：鏡像/座標換算、hit-test、hold 狀態機、clamp、release 判斷，含 `gestureMath.test.ts` 19 個測試）、`GestureDragControl.tsx`（元件本體）。`Live2DCard.tsx` 新增並 export `Box`／`ActiveModelHandle` 型別與 `onActiveModelChange` prop，`Hero.tsx` 用 `useState` 接手 handle 並平行渲染兩個元件。
- **測試框架**：desktop-pet-web 原本沒有測試框架，這次新增 `vitest`（devDependency）+ `npm test` script，只測 gestureMath 這幾個純函式，`GestureDragControl.tsx` 本身（鏡頭/MediaPipe/rAF）維持 spec 原定的「不寫自動測試」。
- **模型檔來源**：`gesture_recognizer.task` 從官方 `storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task` 下載（float16 版本，8.3MB），複製進 `public/mediapipe/models/`；wasm 從 `node_modules/@mediapipe/tasks-vision/wasm/*` 複製進 `public/mediapipe/wasm/`。這兩個資料夾都不在 `.gitignore` 排除範圍內，會跟著進版本控制（比照 `public/lib/` 既有慣例）。
- **`.oxlintrc.json` 新增 `ignorePatterns: ["public/mediapipe/wasm/**"]`**：複製進來的 wasm glue code（emscripten 產物）本身有一處會被 `react-hooks/rules-of-hooks` 誤判成錯誤（把一個叫 `useProgram` 的 WebGL 函式當成 React Hook），導致 `npm run lint` 直接 fail exit code 1，所以整個排除在外，跟原本 `public/lib/*.js` 沒被排除、只是恰好只觸發 warning 不算 error 的情況不同。
- **驗證狀態**：`tsc -b`／`oxlint`／`vitest run`／`vite build` 均已跑過且全過（`vision_bundle` 確認被 code-split 成獨立 chunk，不在首頁主 bundle 裡）。**Acceptance Criteria 列的 11 項手動瀏覽器＋真實鏡頭驗證還沒有人跑過**，這台機器目前無法起真的瀏覽器/鏡頭去驗證，需要使用者自己 `npm run dev` 之後在瀏覽器裡照 Acceptance Criteria 逐項測過一輪。
- **鏡頭 preview 裡也有一份進度環/選定圓圈**：`GestureDragControl` 自己管的攝影機小預覽（骨架疊圖那塊）維持原本畫法，跟卡片上的準心是同一份資料（holdRatio/selected）畫在兩個不同畫布上，不衝突。
- **放開手勢從「張開手掌」改成「握拳（石頭，`Closed_Fist`）」**（2026-08-10 追加變更）：張開手掌跟「手指伸直移動中」的自然手型太接近，拖曳途中手指稍微張開就容易誤觸放開；握拳是一個跟「觸碰/拖曳」姿勢差異很大的明確動作，抽成 `RELEASE_GESTURE` 具名常數（`gestureMath.ts`），之後要再換手勢只要改一個地方。
- **卡片上的準心游標**（2026-08-10 追加）：`GestureDragControl` 新增 `overlayContainer?: HTMLElement | null` prop，`Hero.tsx` 把包住 `Live2DCard` 的 `relative` 容器 DOM 節點（用 `useState` + callback ref 取得）傳進去，元件內部用 `createPortal` 把一張 `pointer-events-none` 的準心 canvas 疊在卡片正上方，跟 hit-test/clamp 用同一組 `canvasSize`/`fingertipCanvasPos` 座標，天生對齊。這解決了「攝影機只是看著使用者、使用者很難把現實手部位置對應到卡片上具體位置」的問題——原本只能參照角落那個 160px 小預覽去猜，現在卡片上直接看得到指尖目前對應的位置，用視覺回饋直接瞄準。`Live2DCard.tsx` 完全沒有因此被改動，portal target 是 `Hero.tsx` 裡兩者共用的兄弟層級父容器，不是 `Live2DCard` 內部節點，架構上的「兩者只透過 handle 溝通」原則沒有被打破。
- **選定放開瞬間狂閃/整頁抖動的 bug 修復**（2026-08-10）：放開時忘記把 `holdRef`（hold 進度計時狀態機）歸零，`updateHold()` 一旦 `state.selected===true` 就直接原樣回傳、不重新判斷，導致放開後下一幀立刻被誤判成「還是已選定」重新選取，馬上又被同一個手勢放開，在選定/放開之間逐幀狂閃。順便把「已選定」文字改成固定高度佔位（不管有沒有文字都保留那行空間），避免文字出現/消失讓下面整頁內容垂直位移，這也是抖動的次要成因。
- **拖到 Hero 區塊任何位置**（2026-08-10 追加，ADR-0011 修訂）：`ActiveModelHandle` 新增 `setEscapeRect(rect: Box | null) => void`。`ModelStage`（`Live2DCard.tsx`）讓模型可以從「卡片內原本的位置」搬到「呼叫端指定的位置（escapeContainer）」——PIXI canvas 本身完全沒有被放大或改變邏輯座標，純粹是外層那個定位用 wrapper div 的 CSS `left/top/width/height` 在動，模型在自己那個卡片大小的小畫布裡的相對位置（`applyFit()` 算好的）從頭到尾沒變過。
  - **搬家機制：原生 DOM `appendChild()`，不是 `createPortal`**（2026-08-10 踩坑後修正，見下方「已知踩過的坑」）：一開始用 `createPortal` 切換 target 容器，實測發現 React 換 portal 的 container 時不是把既有 DOM 節點搬過去，而是在新 container 底下**重新生成**節點——PIXI 用原生 `container.appendChild(canvas)` 掛進去的 `<canvas>` 不在 React 虛擬 DOM 的追蹤範圍內，重新生成節點時會被留在舊節點上孤兒化，畫面上整個消失，而且孤兒化的 canvas／WebGL context 沒被正常 `destroy()`，多次觸發還會把瀏覽器同時能開的 WebGL context 用完，導致其他卡片也一起初始化失敗。改成 `escapeBoxElRef` 這個 div 在 JSX 裡永遠只掛在同一個位置（虛擬 DOM 結構不變），要搬家時直接呼叫原生 `el.appendChild()` 把整個已經存在、裡面掛著活的 PIXI canvas 的節點搬到 `escapeContainer` 底下——真正的 DOM 節點搬家，不是重新生成，canvas／WebGL context／PIXI ticker 全部原封不動跟著過去；React 之後不會去改動這個節點在虛擬 DOM 裡的父子關係，所以不會「修正」回原本位置。
  - `GestureDragControl` 選定的那一刻（第一次選定，逃出卡片）量測卡片目前在 Hero 區塊裡的螢幕位置（`overlayContainer.getBoundingClientRect()` 相對 `escapeContainer.getBoundingClientRect()`），刻意選在「已經穩定停留 2 秒」這個時間點量測，不會跟翻牌的 3D 翻轉動畫撞在一起（`getBoundingClientRect()` 在翻轉期間不準這件事，`Live2DCard.tsx` 原本就有踩坑紀錄）。
  - **放開後模型不會飛回卡片**：停在被放開的位置（Hero 區塊裡任何地方），跟原本「放開不重新置中」是同一個決定的延伸。逃出過一次之後，之後的 hit-test／再次選定都改用 Hero 區塊本地座標比對模型目前的實際位置，不會再去比對卡片裡那個已經空掉的位置。
  - **失效隔離**：`escapeContainer`／`overlayContainer` 是 optional prop，沒給、或量測失敗（回傳 null），自動退回舊的卡片內 clamp 拖曳行為，不是「二選一改寫」而是「加了一個可以不给的擴充能力」。
  - **z-index／點擊穿透**：`Hero.tsx` 新增一個蓋住整個 Hero `<section>` 的 `pointer-events-none` 疊層（`z-10`，蓋在文字/按鈕上面）當 `escapeContainer`；模型本體那塊 div 另外開 `pointer-events-auto`，所以被拖出去的角色蓋在標題上時看得到、點得到（觸發技能動作），其餘 Hero 區塊（連結、按鈕）維持可以正常點擊穿透過去。`<section>` 本身有 `overflow-hidden`，模型無論如何都跑不出這個區塊，是最後一道保險。
  - **手動驗證還沒做**：這塊複雜度最高（DOM 量測、原生 DOM 節點搬家、z-index/pointer-events），特別需要在真的瀏覽器裡測過：逃出卡片時模型有沒有跳一下／閃一下、拖到標題文字上方看不看得到、放開後再選取準不準、切換輪播卡片時逃出去的模型有沒有正確消失、連續多次觸發逃出會不會有殘留節點。
  - **已知踩過的坑**（2026-08-10）：
    1. `homeSlotEl` 用 `useState` + callback ref 拿，第一次 render 一定是 `null`；PIXI 載入的 `useEffect` 原本沒依賴它、掛載時就跑，讀到 `containerRef.current` 是 `null` 直接誤判「角色載入失敗」。後來把這個機制整個換掉（見下一條），這個坑已經不存在（`containerRef` 現在跟其他 ref 一樣掛載當下就有）。
    2. 上面提到的 `createPortal` 切換 target 會孤兒化 PIXI canvas、拖垮 WebGL context 額度——這是選定手勢那一刻「模型瞬間消失、其他卡片也空白」的根因，已改用原生 `appendChild()` 修正（見上方「搬家機制」）。這兩個坑都是這次「拖到 Hero 區塊」功能新引入的，跟手勢拖曳原本的核心邏輯（hold 計時、hit-test、clamp）無關，那些部分沒受影響。
    3. 準心半徑原本用 `canvas.width * 0.025` 算，逃出卡片後畫布換成整個 Hero 區塊（寬很多），準心跟著放大到不成比例；改成固定 9px 半徑，不再跟畫布寬度縮放，順便把準心造型從「圓圈+十字短線」簡化成「圓圈+中心小圓點」，視覺上更乾淨。

## 第一次嘗試失敗記錄：無法同時讓多個模型的 PIXI Application 一起活著（2026-08-10，已被下一節取代）

使用者原本要求：(1) 支援所有模型都能被手勢拖曳、(2) 拖出去的角色即使翻頁到下一張卡片也不用歸位、(3) 設變數限制最多同時逃出幾個模型。這三點合起來代表「同一時間可能有兩個以上的模型同時存在、同時在畫面上動」。**第一次嘗試**維持「每個模型各自一個 `PIXI.Application`（各自一個 WebGL context）」的舊架構，只是讓「曾經顯示過的模型」全部保持掛載（不因為翻牌而卸載，改成搬到一個不可見的保留區）——用 Playwright 寫了自動化重現腳本反覆驗證，過程中依序踩到、也修掉了兩個真的 bug（`homeSlotEl` render timing、`createPortal` 換 container 孤兒化 canvas），但最後發現一個**沒辦法在「每個模型各自一個 context」這個架構下修掉的限制**：

- 只要背景真的有第二個 `PIXI.Application`（第二個 WebGL context）存在，不管它有沒有在畫面上、ticker 有沒有在跑、有沒有用 `display:none`，只要它跟目前顯示中的那個模型同時活著，瀏覽器主控台就會開始出現 `WebGL: INVALID_OPERATION: bindTexture: object does not belong to this context`、`drawElements: no valid shader program in use` 這類錯誤，導致背景模型的 canvas 尺寸/位置/`model.visible`/`ticker.started` 全部正常，卻整個畫不出東西（透明），偶爾還會波及原本顯示中的那個模型一起變空白。
- 用一支獨立、不牽涉 React/DOM 的 Playwright 重現腳本（直接檢查 `gl.isContextLost()`、手動呼叫 `renderer.render()`、比對只有一個 vs 兩個 `PIXI.Application` 的情境）確認：**這是 pixi-live2d-display／PIXI 這套播放方案在「多個獨立 renderer context 同時存在」情境下的既有限制**（先後排除了 `display:none` 導致 GPU 資源回收、React StrictMode 開發模式下重複建立 `PIXI.Application` 兩種假說，移除 StrictMode 後問題依舊存在）。
- 因此當時把「多模型同時掛載」整個回退到「同一時間只有一個 PIXI Application 存在」——**這個回退已經被下一節的「單一共用畫布」重新設計取代**，保留這段記錄純粹是留下踩坑過程，避免以後有人重踩同一個坑（誤以為「多個 PIXI.Application 同時存在」是可行的）。

## 改版：整個 Hero 區塊改用單一共用 PIXI 畫布（2026-08-10）

根治上面那個限制的辦法，是從根本避開「多個獨立 WebGL context 同時存在」這個前提——**整個 Hero 區塊只建立一個 `PIXI.Application`**，三個模型 eager 載入、全部 `addChild` 進同一個 `stage`，「在卡片位置 / 藏起來 / 被拖到 Hero 區塊哪裡」全部只是 `model.visible`／`model.position`／`model.scale` 這些 PIXI 屬性，不再需要搬動任何 DOM 節點。

- **新增 `src/pages/desktop-pet/components/HeroLive2DStage.tsx`**（取代 `Live2DCard.tsx`）：`MODELS` 陣列不變；`slotsRef`（`useRef`，不是 `useState`——逐幀更新位置不該觸發 re-render）存三個模型各自的 `{model, tightBounds, status, escaped}`；`applyFitAt(model, tightBounds, rect)` 是 `applyFit()` 的偏移版，能把模型置中對齊到共用畫布裡的任意矩形（不再假設永遠對齊 (0,0)）。
- **卡片外框矩形量測掛在 PIXI 自己的 `ticker` 上、逐幀重算**（不是只在 resize 時算一次）：卡片外框有浮動的閒置動畫（Hero.tsx 的 `y: [0,-14,0]` bob），只在 resize 時量測矩形會讓模型跟外框的浮動脫節（外框飄、模型不飄）。改成掛在 ticker 上逐幀 `getBoundingClientRect()` + `applyFitAt()`，PIXI 本來就每幀都在畫，多這幾個計算成本可以忽略，換來模型永遠跟外框對齊，不用另外對兩個獨立的 CSS/PIXI 動畫做時間同步。量測用的錨點（`chromeRef`）刻意跟會做 `rotateY` 3D 翻牌動畫的 `motion.div`分開——量測中的元素套 3D transform 會不準，這個 repo 已經踩過這個坑（見 `docs/specs/0010` 這份文件更早的段落），這次錨點本身永遠不套 transform。
- **點擊觸發技能動作 + 無障礙合併成同一個機制**：不再是個別模型自己的 DOM 節點 + `onClick`，改成卡片外框裡疊一個 `absolute inset-0` 的真正 `<button>`（`aria-label` 對齊目前模型），只在目前模型 `status==='ready'` 時出現。因為模型視覺上就是填滿卡片外框的範圍，這顆按鈕天生對齊、不需要另外算座標 hit-test；用真正的 `<button>` 而不是 `role="button"` 的 div，原生就有 Tab/Enter/Space 行為，比舊版少寫一段 `onKeyDown`。
- **`ActiveModelHandle` 簡化**：`getCanvasSize()` 永遠回傳共用畫布大小（不再有「卡片本地 vs Hero 本地」兩套座標系）；`setEscapeRect(rect): boolean` 換成 `markEscaped(): boolean`——不再需要傳位置（模型已經在共用座標系裡，呼叫端直接改 `model.position` 就好），單純是「把這個模型標記成『以後切卡片不要自動隱藏/歸位』，回傳是否成功（可能因為 `maxEscapedModels` 上限被拒絕）」的一次性旗標。
- **`GestureDragControl.tsx` 大幅簡化**：刪掉整個「卡片本地 vs Hero 本地」雙座標系換算（`overlayContainer`、`measureCardOriginInHero`、`escapeBoxRef`、fallback 分支）——現在只有一種座標系，`handleFrame` 少了一半的分支。原本兩張準心／邊框畫布（卡片一張、Hero 一張）合併成一張，portal target 也統一成同一個 `canvasHost`。新增一個「已達上限」的提示訊息（`capMessage`，2.5 秒後自動消失）——`markEscaped()` 被拒絕時，除了把 hold 進度歸零（避免卡在「選定但沒效果」的狀態，見前面「已經踩過的坑」的抖動 bug 同樣的成因），也讓使用者知道為什麼沒有選定成功。
- **`Hero.tsx`**：`cardOverlayEl`（舊版給 GestureDragControl 量測卡片矩形用）整個拿掉，只剩 `canvasHostEl`（蓋住整個 Hero 區塊，真正的 `<canvas>` 掛在這裡，也是準心疊圖的 portal target）。
- **驗證**：`tsc`／`oxlint`／`vitest`（19/19）／`vite build` 全過；用 Playwright 反覆切換卡片＋螢幕截圖確認每張卡片角色正常顯示、主控台無錯誤；額外直接呼叫 `markEscaped()` + 手動改 `model.position`（不需要真的手勢/鏡頭）驗證了三個核心宣稱：①逃出的模型翻頁兩次後仍然 `visible:true` 且維持在手動設定的位置——畫面上實際看得到它跟目前卡片的角色同時存在；② `maxEscapedModels` 預設 2 的上限正確擋下第三次逃出；③點擊卡片觸發技能動作正常。手勢/鏡頭本身（MediaPipe 手部偵測）仍然無法自動化，需要使用者自己 `npm run dev` 實測。
- **已知的刻意簡化**：卡片翻牌時，外框（DOM 裝飾）維持原本的 `rotateY` 3D 翻轉，但模型本身改成淡入淡出（不是同步的假 3D 效果）——避免在 PIXI 裡另外做一套要跟 DOM 翻牌時間軸精準同步的動畫，把風險留在「好不好看」而不是「會不會炸」。逃出去的模型不會被卡片的 `overflow-hidden` 裁切（因為畫布跟卡片外框是兩個獨立的 DOM 節點），resize 時只會把逃出去的模型 clamp 回新的畫布範圍，不會重新置中（跟舊版「拖曳位置不因 resize 保留」是同一個刻意的取捨）。

## 視覺效果追加（2026-08-10）

跟上面「多模型同時掛載」那次嘗試同一輪要求，這兩項是純畫布繪圖層面的追加、沒有動到任何 DOM 生命週期，風險低、都已完成：

- **準心脈動光暈**：`drawCursor()` 新增一圈半徑隨時間（`performance.now()`，1.1 秒週期）從 `CURSOR_RADIUS` 擴散到約 2.2 倍、同時透明度從高到 0 淡出的外圈，讓固定 9px 大小的準心在畫面上更容易一眼注意到，不影響原本中心點/底圈/hold 進度弧的精確定位用途。
- **已選定角色的邊框動畫**：新增 `drawSelectionBorder()`，在角色**成功選定、正在被拖曳**的兩個分支（卡片內 fallback 拖曳、逃出 Hero 區塊拖曳）呼叫，沿角色目前實際外框（跟 hit-test/clamp 用的同一個框，卡片內是 `boxOnCanvas(tightBounds, scale, 拖曳後位置)`，逃出後是 `nextBox`）畫一段隨時間繞邊框跑動的高亮線段（`pointOnRectPerimeter()` 算跑動位置，22% 周長的分段、1.6 秒繞一圈），疊加三層由寬到窄、由淡到濃的線條製造發光感，中段點位再加 `Math.sin` 抖動製造鋸齒/放電的「閃電」視覺，而不是單純平滑的跑馬燈框線。只在 `selected===true`（已經在拖曳）時才畫，hold 累積階段維持原本的進度弧，不會兩者混在一起。

## 單一共用畫布上線後的四項回報修復（2026-08-10）

改成單一共用畫布上線後，使用者實測回報四個問題，逐一修復如下：

1. **卡片翻頁特效消失**：不是限制，是漏做——上一輪「已知的刻意簡化」把模型轉場定成淡入淡出，但實際程式碼只有直接互換 `visible`，沒有真的接動畫。補上：切卡片的 `useEffect`（`[index]` 依賴）新增 `prevCurrentIdRef`（記住上一張卡片對應的模型 id）跟 `transitionTokenRef`（每次切卡片遞增的序號，讓切太快時舊的 `animate()` callback 變成 no-op，不會跟新的轉場互相覆寫 `model.alpha`），用 `motion/react` 的獨立 `animate(0, 1, { duration, onUpdate })` 讓新模型 alpha 0→1、舊模型 1→0，時長跟 DOM 外框的 `rotateY` 翻牌對齊（0.45s／`prefers-reduced-motion` 時 0.2s）。用 Playwright 在頁面內掛 `requestAnimationFrame` 輪詢兩個模型的 `alpha` 值驗證：整個轉場期間兩者 alpha 確實線性互補變化，新模型淡入完成的瞬間舊模型同步 `visible=false`。
2. **同時最多只能拖出 2 個角色，是不是設計考量**：`maxEscapedModels` 這個數字，原本的理由是「多個 WebGL context 同時存在有風險」的年代訂的安全邊界——改成單一共用畫布之後，這個理由已經不成立（只有一個 context，模型數量對它而言只是多幾個 drawcall），現在單純是可以自由調整的 UX 考量（拖太多角色同時飄在畫面上，會不會太亂）。跟使用者確認後維持 2，但改成集中管理：新增 `src/pages/desktop-pet/config.ts` 匯出 `MAX_ESCAPED_MODELS`，`Hero.tsx` 從這裡 import 傳給 `HeroLive2DStage` 的 `maxEscapedModels` prop（這個 prop 因此改成必填、拿掉原本的預設值，避免元件裡再放一份數字要跟 config.ts 一起改才不會兜不起來）。之後要調整（例如三個模型都能同時拖出）只要改 `config.ts` 這一個數字。
3. **abeikelongbi_3 角色自帶黑色背景，拖曳時遮住網頁內容**：根因比原本以為的更深——這份 moc3 除了一塊獨立、不掛任何 Cubism Part 的純黑矩形 `MB_blackbgjuxing2`（待機姿勢下 opacity 預設是 1）之外，還混進了一整套「主畫面情境」美術資源（桌子、板凳、貓、兩隻饅頭吉祥物、熊貓、飲料機，各自掛在自己的 Part 底下，待機時同樣全部可見），這些連同黑色矩形，是造成 `measureTightBounds()` 量出來的外框幾乎等於整張 6000×6000 原始畫布（角色因此被縮到只剩一個小點）的主因。中途也發現 `measureTightBounds()` 原本用 `renderer.extract.pixels()` 對模型做一次離屏渲染去掃描 alpha 通道找外框的做法，在這個共用畫布架構下的實際呼叫時機點會讀回全透明的畫面（跟畫面實際顯示的內容對不上，懷疑是這個自訂 Cubism WebGL renderer 在被拿去做「主渲染迴圈之外」的額外一次渲染時，內部視窗/framebuffer 狀態沒有正確對應到——沒有再往下深究到函式庫原始碼層級），這個問題不只影響 abeikelongbi_3，是所有模型的「畫布留白偵測」都沒真的生效，只是其他模型的保底畫布沒有大到會被注意到。完整修法：
   - `EXTRA_HIDDEN_PARTS`／`EXTRA_HIDDEN_DRAWABLES`（依模型 id 對照）列出要強制隱藏的 Cubism Part／無 Part 歸屬的 drawable 名稱，`setupExtraHidden()` 解析成實際 index 並掛在 PIXI ticker 上（`UPDATE_PRIORITY.LOW`）逐幀覆寫 opacity 為 0——這些 Part／drawable 的 opacity 每幀都會被待機動作重新算回原本的值，只在載入當下改一次不會生效。
   - 徹底放棄 `extract.pixels()` 像素掃描，改成 `computeGeometryBounds()`：直接讀 Cubism core 的 `getDrawableVertexPositions()`（跳過被強制隱藏、或當下 opacity 為 0 的 drawable），累加出角色本地座標的外框，再用 `internalModel.centeringTransform`（本地座標→畫布像素座標的仿射矩陣）換算成 `model.getBounds()` 同一套慣例的像素座標。不牽涉任何離屏渲染，沒有時機問題，比對整張 6000×6000 畫布做像素掃描便宜得多，`measureTightBounds()` 現在對所有模型統一用這個方法（保底才退回 `model.getBounds()`）。
   - 用 Playwright 驗證：`markEscaped()` + 手動定位到一個較大的顯示區域，截圖確認角色乾淨顯示（無黑色矩形、無桌子/板凳/貓/吉祥物），量出來的框（寬 3233px×高 6671px，local space 換算後跟角色實際頭到腳、含兔耳朵跟手持杯子道具的範圍吻合）不再是灌水的整張畫布。
4. **手指準心鎖定角色時，準心要在模型上層，並且要更有特色的視覺效果**：z-order 部分實測是誤會——`cursorRef` 這張 canvas 用 `createPortal` 掛進跟 PIXI `<canvas>` 同一個 `canvasHost`，`position:absolute`（PIXI 畫布是預設的 `position:static`）；CSS 的繪製順序規則是「有定位的元素一律畫在沒有定位的同層元素之上」，跟兩者誰在 DOM 順序上比較晚無關——準心事實上一直都畫在模型上層。實際成因是對比度不夠：準心是細線條的白/紫色圓環，疊在色彩豐富的角色插畫（尤其淺色肌膚/淺色衣物區域）上很容易被視覺上「淹沒」，加上 issue 3 修好之後角色顯示尺寸變大、細節更多，這個問題更明顯。修法：
   - `strokeWithOutline()`：所有準心線條改成先描一層深色半透明外框（`rgba(15,15,20,0.55)`，線寬 +2.5px）當底再疊主色線條，不管背景深淺都有穩定對比度，這是這次「更有特色」的核心手法。
   - 新增掃描外環：4 段短弧繞著準心以 2.4 秒週期慢慢轉動（未選定時顯示，強化「持續追蹤中」的視覺語言；選定後改用既有的邊框閃電動畫接手，兩種動畫不會同時搶注意力）。
   - 中心點半徑、底圈半徑略微加大（9→11px）並統一套用深色外框處理，脈動光暈邏輯不變。

## 待辦：補建 GitHub Issue

跟前幾份 spec 一樣，這台機器沒有 `gh` CLI。日後裝好並登入後：

```bash
gh issue create \
  --repo reqw123/question \
  --title "desktop-pet-web：Live2DCard 手勢拖曳（MediaPipe Tasks Vision GestureRecognizer）" \
  --body-file docs/specs/0010-desktop-pet-web-gesture-drag.md \
  --label ready-for-agent
```
