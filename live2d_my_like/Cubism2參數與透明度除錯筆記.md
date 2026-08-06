# live2d_my_like — Cubism 2 模型系統技術筆記

給以後（自己或別人）用 `viewer.html` 調角色參數、做透明度/關節動作時看的筆記。
這份筆記是從實際除錯 `aek999_1505_destroy` 這個模型的「skill_02 動作透明化沒作用」問題中整理出來的，
但裡面的 API、陷阱、修法對所有 Cubism 2 模型（`model.json` + `.moc` + `.mtn`，不是 `model3.json` 那種
Cubism 3/4）都適用，之後做關節變形（骨架類 Parameter）也會用到同一套工具。

## 目錄

1. [1. Parameter 與 Part 的差異（一定要先分清楚）](#1-parameter-與-part-的差異一定要先分清楚)
2. [2. viewer.html 內建工具（優先用這個，不用每次寫 console）](#2-viewerhtml-內建工具優先用這個不用每次寫-console)
3. [3. Console 常用指令速查](#3-console-常用指令速查)
4. [4. `.mtn` 動作檔案格式（純文字，不是二進位！）](#4-mtn-動作檔案格式純文字不是二進位)
5. [5. 案例研究：為什麼「skill_02 動作按鈕」原本沒有透明化效果](#5-案例研究為什麼skill02-動作按鈕原本沒有透明化效果)
   - [現象](#現象)
   - [根因（對照 `lib/live2d.min.js` 官方核心 + `lib/all.min.js` pixi-live2d-display 包裝層原始碼查出）](#根因對照-liblive2dminjs-官方核心--liballminjs-pixi-live2d-display-包裝層原始碼查出)
   - [適用範圍：只有 Cubism 2 有這個問題，Cubism 3/4 不會](#適用範圍只有-cubism-2-有這個問題cubism-34-不會)
   - [修法（`viewer.html` 裡的 `attachVisibilitySync`）](#修法viewerhtml-裡的-attachvisibilitysync)
   - [修這個過程中踩到的兩個額外陷阱](#修這個過程中踩到的兩個額外陷阱)
6. [6. 之後做關節/骨架變形（Parameter 驅動）要注意的地方](#6-之後做關節骨架變形parameter-驅動要注意的地方)

---

## 1. Parameter 與 Part 的差異（一定要先分清楚）

Cubism 2 的模型控制分兩層，容易搞混：

| | Parameter | Part |
|---|---|---|
| 命名慣例 | `PARAM_XXX`（例如 `PARAM_JC`） | `PARTS_XXX`（例如 `PARTS_01_FACE_001`） |
| 負責什麼 | 驅動網格變形（角度、張嘴幅度、關節彎曲…） | 整組 Drawable 的透明度開關（不做變形） |
| 數值範圍 | 由模型設計時自訂 min/max（可能是 -1~1、0~30 等） | 固定 0~1 |
| 官方查詢 index 的方法 | `cm.getParamIndex(id)`（**官方公開 API**，直接吃字串） | 沒有官方 `getPartsIndex(id)`，見下方 |
| 讀寫數值 | `cm.getParamFloat(idx)` / `cm.setParamFloat(idx, v)` | `cm.getPartsOpacity(idOrIdx)` / `cm.setPartsOpacity(idOrIdx, v)` |

**重要陷阱**：`getPartsID()` 回傳的不是字串，是一個物件 `{id: 'PARTS_xxx'}`，
要拿 `.id` 才是字串，直接 `=== 'PARTS_xxx'` 比較永遠是 `false`（第一次踩雷紀錄）。

**好消息（後來才發現，比較省事的寫法）**：`live2d.min.js` 原生的
`setPartsOpacity` / `getPartsOpacity` / `getPartsDataIndex` 其實都支援**直接傳 ID 字串**，
不是數字的話會自動轉換：

```js
// 不需要自己去反查 index，這樣就夠了：
cm.setPartsOpacity('PARTS_01_FACE_001', 0);   // 直接用字串 ID
cm.getPartsOpacity('PARTS_01_FACE_001');       // 找不到會回傳 0，不會噴錯
```

viewer.html 的「🧩 Part 透明度檢查器」目前是用比較繞的寫法反查 index
（因為當初不知道字串可以直接傳），之後如果要重構可以簡化，但目前功能沒問題不用急著改。

---

## 2. viewer.html 內建工具（優先用這個，不用每次寫 console）

- **🔍 Parameter 檢查器** / **🧩 Part 透明度檢查器**：右/左側面板，滑桿即時改數值，用來反查
  「拉哪個 Parameter／哪個 Part 會影響畫面上哪裡」。
- **❄️ 凍結待機動作**：勾起來才能穩定調參數，不然待機動作(`daiji_idle_01.mtn`)每一幀都會把你手動改的值蓋掉。
- 下方會自動列出 `model.json` 裡 `motions` 註冊的所有動作按鈕（例如 `skill_02`），
  點了等同 `curModel.motion('skill_02', 0, PIXI.live2d.MotionPriority.FORCE)`。

---

## 3. Console 常用指令速查

前提：在 `viewer.html` 頁面上，`curModel` 是目前載入模型的全域變數（top-level `let`，
不掛在 `window` 上，但 DevTools console 一樣能直接存取）。

```js
const cm = curModel.internalModel.coreModel;   // Cubism 2 核心物件，之後都對它操作
```

**查 Parameter index（官方 API，直接吃 ID 字串）：**
```js
cm.getParamIndex('PARAM_JC');   // 找不到回傳 -1
```

**查 Part 是不是存在、有哪些 ID（沒有官方按 ID 查詢的 API，直接列全部最快）：**
```js
cm._$5S._$F2.map(p => p.getPartsID().id);   // 私有欄位，反解自 live2d.min.js，無官方文件
```

**播放已註冊好的動作：**
```js
curModel.motion('skill_02', 0, PIXI.live2d.MotionPriority.FORCE);
```

**手動即時控制（不透過動作檔，適合快速實驗）：**
```js
cm.setParamFloat(cm.getParamIndex('PARAM_JC'), 0.5);
cm.setPartsOpacity('PARTS_01_FACE_001', 0);
```

---

## 4. `.mtn` 動作檔案格式（純文字，不是二進位！）

第一次以為 Cubism 2 的 `.mtn` 是二進位格式，實際用 Read 工具打開才發現是純文字，可以直接讀/寫：

```
# Live2D Animator Motion Data
$fps=30

$fadein=0

$fadeout=0

PARAM_JC=-1,-0.9833,-0.9667,...,1
VISIBLE:PARTS_01_FACE_001=1,1,...,1,0,0,...,0
```

- `$fps=30`：曲線取樣率，每秒 30 格。
- 每條曲線一行，`<ParamOrVisibleID>=<逗號分隔的數值，共 (秒數×fps)+1 個>`。
- `VISIBLE:PARTS_xxx` 這種前綴，是 Cubism 2 把「Part 透明度時間軸」偽裝成一個特殊命名的
  Parameter 來存（細節見下一節），不是另一種獨立的曲線類型。
- 要新增新動作，先確認 `model.json` 的 `motions` 有沒有對應的 key（例如 `skill_03`），
  沒有的話要在 `model.json` 裡補一段：
  ```json
  "skill_03": [{ "file": "skill_03.mtn", "fade_in": 0, "fade_out": 0 }]
  ```

---

## 5. 案例研究：為什麼「skill_02 動作按鈕」原本沒有透明化效果

### 現象
用 F12 手動 `cm.setPartsOpacity(...)` 淡出某個 Part 完全正常；
但點擊 `skill_02` 動作按鈕（`curModel.motion('skill_02', ...)`）播放同一份動作檔，
`PARAM_JC` 有正確跑動畫，**Part 透明度卻完全沒反應**。

### 根因（對照 `lib/live2d.min.js` 官方核心 + `lib/all.min.js` pixi-live2d-display 包裝層原始碼查出）

1. `.mtn` 裡的 `VISIBLE:PARTS_xxx` 曲線，在 Cubism 2 官方核心裡是被解析成一個**真的存在於
   `.moc` 裡、只是名字比較特殊的 Parameter**（`live2d.min.js` 裡 motion loader 的
   `Y._$cs = "VISIBLE:"` 就是在處理這個前綴）。用診斷指令實測確認：
   ```js
   cm.getParamIndex('VISIBLE:PARTS_01_FACE_001')   // 回傳有效 index（不是 -1）
   ```
   而且播放動作時，這個 Parameter 的數值本身**會**正確依照曲線跑（`getParamFloat` 逐幀追蹤確認過，
   2 秒整準時從 1 降到 0）。

2. 但「把這個 Parameter 的值同步寫回對應 Part 的 `setPartsOpacity`」這件事，
   Cubism 2 官方 SDK 是靠另一個機制做的：`model.json` 裡宣告一個 `parts_visible` 設定區塊，
   載入時才會建立 Parameter → Part 的轉譯線路（原生對應函式是 `live2d.min.js` 裡的 `_$P7`，
   pixi-live2d-display 裡對應 `dt` / `ht` 這兩個 class）。**這個模型的 `model.json` 完全沒有
   `parts_visible` 欄位**，所以這條轉譯線路根本沒被建立——Parameter 曲線在跑，但沒人把它接到
   Part 的透明度上。

3. 就算補上 `parts_visible`，也不能直接解決：pixi-live2d-display 裡 `dt.normalizePartsOpacityGroup`
   這個實作跟官方原生 `_$P7` 邏輯有落差——它是設計給「互斥選項間淡入淡出」用的語意
   （例如兩個髮型切換，永遠要有一個是可見的），一旦群組裡全部成員的 Parameter 都是 0
   （我們要的「淡出後保持透明」），它反而會 fallback 把透明度拉回 1，跟我們要的效果相反。
   所以官方這條路對「單純淡出、之後保持透明」這種用法是不能用的。

### 適用範圍：只有 Cubism 2 有這個問題，Cubism 3/4 不會

這不是「Parameter 播放機制」本身壞掉，也不是所有版本的 Cubism 都有的通病，範圍很精準：
**只有 Part 透明度（`VISIBLE:` 這條路徑）有問題，一般 Parameter（例如 `PARAM_JC` 這種關節/變形參數）
完全沒事**——動作播放時 `PARAM_JC` 本來就正確運作，只有透明度沒套用。

而且**這是 Cubism 2 專屬的問題，Cubism 3/4 沒有這個坑**。對照 `lib/all.min.js` 裡 Cubism 3/4 的
動作播放邏輯（`CubismMotionCurveTarget_PartOpacity` 這個 enum）可以確認原因：

| | Cubism 2 | Cubism 3/4 |
|---|---|---|
| 動作曲線裡「Part 透明度」怎麼表示 | 沒有獨立類型，是**偽裝成一個特殊命名的 Parameter**（`VISIBLE:PARTS_xxx`） | **原生就有獨立的曲線類型** `CubismMotionCurveTarget_PartOpacity`，跟一般 Parameter（`_Parameter`）是分開的 enum |
| 播放時怎麼套用到畫面 | 需要額外一層轉譯（`parts_visible` 設定 + 官方那套邏輯），這層轉譯在 pixi-live2d-display 裡沒接好/語意不合，才會沒作用 | 動作播放時直接呼叫官方 `setPartOpacityByIndex`，不用額外轉譯，本來就會正確套用 |

結論：`attachVisibilitySync` 這個 patch **只需要、也只該作用在 Cubism 2 模型上**
（程式碼裡 `cm._$5S._$F2` 那個判斷式就是在專門辨識 Cubism 2，Cubism 3/4 模型會直接跳過這段邏輯）。
專案裡的 Cubism 3/4 模型（`furina`、`kuroneko`、`home_cat`、`1024100`、`1014107`、`1009109`、
`pinghai_4`、`076`、`077`、`girl120` 這些用 `model3.json` 的）如果之後也要做 Part 透明度動作，
直接在 Cubism Editor 裡編輯 PartOpacity 軌道、匯出 `motion3.json`，理論上不會遇到同樣的問題，
不需要套用這個 patch。

### 修法（`viewer.html` 裡的 `attachVisibilitySync`）

繞過官方那條有問題的路徑，改成每一幀直接把每個 `VISIBLE:<PartID>` Parameter 的即時值，
蓋回同名 Part 的透明度：

```js
function attachVisibilitySync(model) {
  const cm = model.internalModel && model.internalModel.coreModel;
  if (!cm || typeof cm.getParamIndex !== 'function' || !cm._$5S || !Array.isArray(cm._$5S._$F2)) {
    return null; // 只有 Cubism 2 模型才有這個坑
  }
  const partsArr = cm._$5S._$F2;
  const mappings = [];
  partsArr.forEach((p, partIdx) => {
    let id;
    try { id = p.getPartsID().id; } catch { return; }
    const paramIdx = cm.getParamIndex('VISIBLE:' + id);
    if (paramIdx >= 0) mappings.push({ paramIdx, partIdx });
  });
  if (!mappings.length) return null;

  const sync = () => {
    if (freezeIdle) return;   // 跟「凍結待機動作」開關連動，見下方陷阱 2
    mappings.forEach(({ paramIdx, partIdx }) => {
      cm.setPartsOpacity(partIdx, cm.getParamFloat(paramIdx));
    });
  };
  PIXI.Ticker.shared.add(sync, null, PIXI.UPDATE_PRIORITY.LOW + 1);  // 見下方陷阱 1
  return sync;
}
```

載入/切換模型時（`loadPath()`）要記得先移除舊模型的同步監聽再掛新的，不然會累積殘留、
指向已銷毀的 coreModel：

```js
if (curVisibilitySync) { PIXI.Ticker.shared.remove(curVisibilitySync); curVisibilitySync = null; }
// ...load new model...
curVisibilitySync = attachVisibilitySync(model);
```

### 修這個過程中踩到的兩個額外陷阱

**陷阱 1：PIXI Ticker 的「同優先度」排序方向**
`PIXI.Application` 自己的 `render` 是掛在 `UPDATE_PRIORITY.LOW`（-25）。一開始也把
同步函式掛在 `LOW`，以為「同優先度、我後掛的會排在渲染前面」——結果剛好相反：PIXI Ticker
的插入邏輯是「只有**嚴格大於**既有節點優先度才會排到它前面」，相同優先度會排到後面（先掛的在前）。
所以同步函式其實排在 `render` **之後**執行，等於永遠慢一幀才生效（肉眼看不出來，但邏輯是錯的）。
修法：優先度要嚴格夾在「pixi-live2d-display 自己更新 Parameter 用的 `NORMAL`(0)」和
「render 用的 `LOW`(-25)」中間，例如 `LOW + 1`，才能保證「更新 Parameter → 同步 Part 透明度 →
渲染」這個順序在同一幀內嚴格成立。

**陷阱 2：跟既有的手動調參數功能打架**
這個同步一旦生效，任何有對應 `VISIBLE:` Parameter 的 Part，不管是用「🧩 Part 透明度檢查器」拉滑桿、
還是 console 手動 `setPartsOpacity()`，下一幀都會被同步蓋回 Parameter 目前的值，
手動調整等於失效（包括本文件開頭示範的「手動淡出 FACE_001」那個練習，一旦這個模型的同步生效後
也會被蓋掉）。修法：讓同步函式尊重「❄️ 凍結待機動作」開關——勾起來時（要手動測參數）暫停同步，
沒勾時（正常播放動作）才自動生效。**這代表以後如果要手動測某個 Part 的透明度，記得先勾凍結**，
不然滑桿會像壞掉一樣完全沒反應。

---

## 6. 之後做關節/骨架變形（Parameter 驅動）要注意的地方

關節變形是純 Parameter 的事（不牽涉 Part 透明度那條有問題的路徑），所以理論上比透明度單純，
但這次踩雷的經驗可以直接套用在流程上：

1. **先用 Parameter 檢查器反查**：不要用猜的，拖滑桿看畫面實際變化，確認哪個 `PARAM_xxx`
   對應哪個關節/部位，記下 min/max 範圍（`cm.getParameterMinimumValue` 等是 Cubism 3/4 API，
   Cubism 2 要用 `mc.getParamMin(i)` / `mc.getParamMax(i)`，見 `buildParamInspectorC2`）。
2. **F12 手動測完曲線邏輯，再寫進 `.mtn`**：這次的流程證明是可行的——先在 console 用
   `requestAnimationFrame` 手動 tween 出想要的曲線，跟你確認邏輯對了之後，
   再用同一套算法生成 `.mtn` 文字內容（純文字格式，見第 4 節），比直接手刻 `.mtn` 數值容易除錯。
3. **Parameter 是純數值曲線，官方播放路徑本身沒問題**：不像 `VISIBLE:` 那樣需要額外的轉譯層，
   一般 `PARAM_xxx` 動作播放時 `setParamFloat` 是官方 SDK 直接處理的，`skill_02` 案例裡
   `PARAM_JC` 本來就正常運作，只有 `VISIBLE:` 那條路才有問題——所以關節動作大機率不會遇到
   同一種 bug，但如果遇到「動作按鈕播放時某個東西沒反應、但手動改參數卻正常」，
   第一步還是回來對照這份筆記的除錯方法：**寫一段診斷指令，同時印出 Parameter 的即時值
   跟畫面實際反映的狀態，兩者對不上，才是「有轉譯層缺失」的訊號**。
