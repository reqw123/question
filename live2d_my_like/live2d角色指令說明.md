# Live2D 角色指令說明

這份文件記錄兩件事：

1. `L2D.play()`（`lib/live2d.js`）跟 `L2DGesturePlayer.play()`（`multi/L2DGesturePlayer.js`）這兩套指令系統的差別
2. `live2d_my_like/076`（納茲）跟 `live2d_my_like/1009109` 在資料夾/模型結構上的差別，以及這個差別為什麼直接決定了上面那套指令能不能用

兩套指令名字很像、都能讓角色動起來，但底層機制完全不同，混著用很容易誤判「這個角色是不是壞掉了」——實際上通常只是指令系統跟角色的參數命名對不起來。

---

## 一、L2D.play() vs L2DGesturePlayer.play()

### 快速對照表

| | `L2D.play(name, delayMs)` | `L2DGesturePlayer.play(name?, charKey?)` |
|---|---|---|
| 定義位置 | `lib/live2d.js` | `multi/L2DGesturePlayer.js` |
| 播放的是什麼 | 模型自帶的 **motion3.json 動作檔**（模型師/官方做好的完整動畫） | **直接操控 coreModel 參數**的自訂 keyframe（跟模型本身的動作檔完全無關） |
| 底層呼叫 | `model.motion(group, idx, 3)`（Cubism 官方動作播放 API） | 接管 `coreModel.update`，每幀用 `setParameterValueById()` 手動改參數值再還原 |
| 找動作的方式 | 先查 `gMap`（模型實際擁有的動作群組），用 `L2D_ALIASES` 別名表把檔名清乾淨後比對，找不到就退回播模型第一個可用動作 | 直接從 `GESTURES` 這個寫死在 `L2DGesturePlayer.js` 裡的 JS 物件查 `name` | 
| 動作內容從哪來 | 模型自己的 `motions/*.motion3.json` 檔案（外部資源，模型換了動作就換了） | 寫死在程式碼裡的參數 keyframe（跟載入哪個模型無關，程式碼不變） |
| **是否相容任何模型** | ✅ 是——只要模型有對應（或別名對得上）的動作檔就能播，沒有就自然退回待機動作，不會出錯 | ❌ 否——`GESTURES` 裡每個參數 ID（例如 `PARAM_ARM_L_ROTATE`）都是寫死的字串，只有**剛好擁有這些參數 ID**的模型才會有反應，對不上的模型會靜默失敗（不報錯，但角色不動） |
| 呼叫範例 | `L2D.play('skill2')`、`L2D.play('happy', 300)` | `L2DGesturePlayer.play('victory')`、`L2DGesturePlayer.play(null, 'c2')`、`L2DGesturePlayer.playAll()` |
| 適合用途 | 播放模型師/官方原本就做好的正式動作（idle、表情、技能動作） | 幫「沒有對應動作檔、但骨架參數夠豐富」的模型，用程式碼即時拼出額外的自訂動作（例如指向、蹲下蓄力等模型本身沒有做成動作檔的姿勢） |

### `L2D.play()` 詳細機制（`lib/live2d.js` 的 `_go()`）

1. 從 `state.gMap`（模型實際載入後，讀 `model.internalModel.settings.motions` 得到的「群組 → 動作檔名清單」）逐一比對。
2. 每個動作檔名先去掉前綴數字（`^\d+_`）、轉小寫，再查 `L2D_ALIASES` 別名表（例如 `'skill_02'` → `'skill2'`、`'happy_01'` → `'happy'`）。
3. 清洗完的 key 等於呼叫時傳入的 `name`，就播放 `model.motion(group, index, 3)`（`3` = FORCE 優先度，立刻打斷目前動作）。
4. 完全找不到對應時，退回播放模型第一個可用動作（讓角色至少會動，不會呆住）。

這一整套完全建立在「模型本身有沒有這個動作檔」上，**跟模型的骨架參數命名無關**——所以不管換成哪個模型，`L2D.play('wait')` 之類的呼叫都不會「壞掉」，最差就是退回播放別的動作。

### `L2DGesturePlayer.play()` 詳細機制

1. `GESTURES` 是一份寫死在程式碼裡的動作字典，每個動作是一組 `{ t, params }` 關鍵幀（或 `random_1` 那種 `type:'fn'` 的程序化版本）。
2. 呼叫 `play(name, charKey)` 時：
   - `name` 沒帶 → 從 `Object.keys(GESTURES)` 隨機挑一個。
   - `charKey` 沒帶 → `c1`、`c2` 兩個角色都套用；有帶 `'c1'`/`'c2'` → 只套用該角色。
3. 內部 `_hookChar()` 直接把該角色 `coreModel.update` 換成自訂函式，每一幀用線性插值把 `frames` 裡指定的參數 ID（例如 `PARAM_ARM_L_ROTATE`）推向目標值，播完再還原成原本的 `update`。
4. **關鍵限制**：`cm.setParameterValueById(id, value)` 只有在該模型的 moc3 裡真的存在這個 `id` 字串時才有效；對不上的話，Cubism runtime 內部找不到該參數，這行呼叫會被 `_hookChar` 裡的 `try{}catch{}` 靜默吞掉——**不報錯，但角色完全不會動**。

新增的 `playAll(charKey?, gapMs?)` 是依序把 `GESTURES` 裡所有動作跑一輪（每個播完自己的時長 + `gapMs` 緩衝才接下一個），方便一次驗證一個模型能不能吃這整批動作。

---

## 二、076（納茲）vs 1009109 資料夾結構比較

### 檔案結構

```
076/                              1009109/
├─ c_7001.moc3                    └─ 1009109/                    ← 注意：多一層同名資料夾
├─ c_7001.model3.json                ├─ 1009109.moc3
├─ motions/                          ├─ 1009109.model3.json
│  ├─ c_7001.motion3.json (idle)     ├─ .physics3.json           ← 注意：檔名沒有「1009109」前綴
│  └─ skill_02.motion3.json (自製)   ├─ motions/                 ← 29 個官方風格動作檔
├─ textures/texture_00.png           │  ├─ 00_Anger_01~03
└─ 納茲.md                           │  ├─ 00_Appeal_01~02
                                      │  ├─ 00_Cry_01~02
                                      │  ├─ 00_Happy_01~02
                                      │  ├─ 00_Pride_01
                                      │  ├─ 00_Puzzle_01
                                      │  ├─ 00_Sad_01
                                      │  ├─ 00_Serious_01
                                      │  ├─ 00_Shame_01
                                      │  ├─ 00_Surprise_01~02
                                      │  ├─ 00_Upset_01
                                      │  ├─ 00_Wait_01
                                      │  ├─ 20_Expression_*（12 個表情動作）
                                      │  └─ bound / bound_double / bound_down
                                      └─ textures/texture_00.png
```

`manifest.json`／`names.json` 裡 1009109 的路徑寫的是 `1009109/1009109/1009109.model3.json`——這**不是路徑寫錯**，資料夾本身真的多包了一層同名子資料夾。`generate-manifest.js` 是照實際掃到的路徑寫入的，跟 076 那種「檔案直接放在角色資料夾底下」的排法不一樣，屬於這批素材本身帶進來的結構差異，兩種排法程式都吃得下（`L2D_CFG.char1.model` 只是一個路徑字串），不影響功能，只是找檔案時要記得多點一層。

### 動作檔數量與命名規則

| | 076（納茲） | 1009109 |
|---|---|---|
| 動作檔數量 | 2 個（1 個原廠 idle + 1 個手動做的 `skill_02`） | 29 個（涵蓋 13 種身體情緒動作 + 12 種表情動作 + 3 種彈跳動作） |
| 命名規則 | 自訂（`c_7001` 這種型號碼，非人類可讀） | `00_情緒_編號.motion3.json` / `20_Expression_情緒_編號.motion3.json`，跟 `lib/live2d.js` 的 `L2D_ALIASES` 別名表幾乎是照著同一套慣例設計的（`anger_01`→`anger`、`happy_01`→`happy`、`bound_double`→`boundx2`⋯都對得上） |
| Physics（次要動態，如頭髮/衣物自然擺動） | ❌ 沒有 `Physics3.json`，`model3.json` 裡雖然寫了 `"Physics": ".physics3.json"` 但實際上這個檔案不存在——次要擺動效果要嘛沒做、要嘛是手動關鍵幀在動作檔裡做出來的 | ⚠️ 有 `.physics3.json`，但檔名開頭是點、沒有 `1009109` 前綴（跟 1014107/1024100 的「`型號.physics3.json`」命名不一致），是這批素材本身命名不統一，`model3.json` 裡的參照字串跟實際檔名是對得上的，不影響載入 |
| Groups（EyeBlink/LipSync 參數群組） | `"Groups": []`（空的，沒有登記） | 有登記 `EyeBlink`（`PARAM_EYE_R_OPEN`/`PARAM_EYE_L_OPEN`）、`LipSync`（`PARAM_MOUTH_OPEN_Y`） |

### 骨架參數命名慣例——這是兩者最關鎮的差別

用 `076/納茲.md`／`077/露西.md` 記錄的實測結果，加上直接讀取 moc3 二進位裡內嵌的參數 ID 字串表交叉驗證：

| | 076（納茲）／077（露西） | 1009109（跟 1014107、1024100 一致） |
|---|---|---|
| 命名風格 | **CamelCase**：`ParamAngleX`、`ParamBodyAngleX`、`ParamMouthOpenY`、`ParamHairFront`⋯外加大量沒有人類可讀名稱的 `Param17`~`Param47`（火焰/魔法陣特效專用，各角色各自獨立定義） | **SCREAMING_SNAKE_CASE**：`PARAM_ANGLE_X`、`PARAM_BODY_ANGLE_X`、`PARAM_ARM_L_ROTATE`、`PARAM_SHOULDER_R_ROTATE`、`PARAM_HAND_L_ROTATE`、`PARAM_STRETCH`、`PARAM_SHOLDER_POSITION`（注意這個模型的參數本身就沒有 U，是原始命名就這樣，不是打字錯）、`PARAM_POSITION_X/Y`、`PARAM_ROTATION_Z` |
| 手臂/肩膀/手掌相關參數 | ❌ 完全沒有（角色的招式是靠火焰粒子/魔法陣光芒參數做出來的，原始建模沒有綁手臂 IK） | ✅ 齊全（`PARAM_ARM_R_ROTATE`、`PARAM_ARM_L_ROTATE`、`PARAM_SHOULDER_R_ROTATE`、`PARAM_SHOULDER_L_ROTATE`、`PARAM_HAND_R_ROTATE`、`PARAM_HAND_L_ROTATE` 等都實際存在於 moc3） |

**結論：`L2DGesturePlayer.js` 的 `GESTURES` 字典（`crouch`/`pointing`/`victory`/`surprise`/`slump`/`tremble`/`random_2`~`random_10` 這些用固定 keyframe 寫死參數 ID 的動作）是照著 1009109／1014107／1024100 這一系列模型的參數命名設計的，而不是目前 `L2D_CFG` 預設載入的納茲（076）/露西（077）。** 在納茲/露西身上呼叫這些動作，`PARAM_ARM_L_ROTATE` 這類 ID 完全找不到對應目標，會被靜默吞掉、角色不會動；唯一例外是 `random_1`（`type:'fn'`），因為它是動態讀取「當下這個角色實際擁有的參數清單」去亂數，不寫死任何一個 ID，所以換成哪個角色都會有反應。

如果之後想讓納茲/露西也能吃這套手勢庫，兩個方向都可行：

1. 只用兩邊都有的參數（`ParamAngleX/Y/Z`、`ParamBodyAngleX/Y/Z`）重新設計一組簡化版動作，放棄手臂/肩膀類的效果。
2. 把 `L2D_CFG.char1`/`char2` 換成 `1009109`/`1014107`/`1024100` 其中之一（moc3 裡確認齊全的三個模型），`GESTURES` 完全不用改。

---

## 三、自行驗證的方法

兩種完全不同的環境，不要搞混：**F12** 是瀏覽器開發者工具的 Console 分頁，要先把 `host.html`/`player.html` 開起來、角色載入完成後才能查（查的是「當下這個頁面實際跑起來的模型」）；**cmd/終端機** 是 VS Code 的 Terminal 或 PowerShell，用 `node` 指令執行，完全不用開瀏覽器（直接讀 moc3 檔案本身，跟頁面有沒有在跑無關）。底下用標題明確標出每段指令要貼在哪裡。

---

### 方法 A：F12 瀏覽器 Console（要先開好 host.html/player.html，角色載入完成）

#### ⚠️ 先看陷阱：不要用 `getParameterIndex()` 判斷參數存不存在

`getParameterIndex()` **永遠不會回傳 -1**。去反解 `lib/cubism4.min.js` 內嵌的原始碼可以看到：真的找到參數才會在迴圈裡 `return e`；找不到的話，會把這個字串登記進 `_notExistParameterId`、配一個「假索引」（`真實參數數量 + 目前已登記的假參數數量`）並快取起來，下次查同一個字串就回傳同一個假索引，**永遠有回傳值，不會是 -1**：

```js
getParameterIndex(t) {
  const i = this._model.parameters.count;
  for (let e = 0; e < i; ++e) if (t == this._parameterIds[e]) return e;
  return t in this._notExistParameterId
    ? this._notExistParameterId[t]
    : (e = this._model.parameters.count + Object.keys(this._notExistParameterId).length,
       this._notExistParameterId[t] = e, this._notExistParameterValues[e] = 0, e);
}
```

實測時可以親眼驗證這個陷阱：連續查幾個明顯是打錯/不存在的字串（例如 `'PARAM_ARM_L_ROTAT'`、`'PARAM_ARM_L_ROTA'`），會發現**每一個都拿到一個新的、遞增的數字**，而不是 -1——這就是假登記索引在動。所以角色一/角色二要分開測（`L2D._c1`/`L2D._c2` 是各自獨立的模型，參數表不共用），但**不能只看 `getParameterIndex()` 有沒有回傳數字**來判斷參數是否真的存在。

#### 正確做法：直接查真實參數清單（貼到 F12 Console）

```js
const cm = L2D._c2.model.internalModel.coreModel;
[...cm._model.parameters.ids].includes('PARAM_ARM_L_ROTATE');   // true/false 才是可信的結果
```
把 `_c2` 換成 `_c1` 就是查角色一，兩個角色要分開查。

#### 列出模型全部參數 ID（貼到 F12 Console）

```js
[...L2D._c2.model.internalModel.coreModel._model.parameters.ids]
```

---

### 方法 B：cmd/終端機（Node.js，不用開瀏覽器）

moc3 是二進位格式，但參數/部件 ID 這類字串是以純 ASCII 直接內嵌在檔案裡供 runtime 查表用，所以不需要真的解析整個 moc3 結構，抓可印出字元的片段就能拿到完整參數清單，結果不會有方法 A 那個假索引陷阱的問題（直接讀檔案，沒有 `getParameterIndex()` 那層包裝）。這份文件裡的所有結論都是用這個方法交叉驗證過的，不是憑猜測——已經包成一支可重複使用的工具腳本：[`scan-params.js`](scan-params.js)。

**開啟方式**：VS Code 的 Terminal 或 PowerShell，**不是**瀏覽器 F12 Console——因為它用 `fs` 讀本機檔案，瀏覽器不允許網頁程式碼這樣做。指令裡的路徑是相對於執行 `node` 指令當下的資料夾，記得先切到專案根目錄 `c:\question` 再執行下面的指令。

#### 總體查詢：列出這個模型全部參數 ID（cmd/終端機）

```
node live2d_my_like/scan-params.js <moc3 檔案路徑>
```
範例：
```
node live2d_my_like/scan-params.js live2d_my_like/1009109/1009109/1009109.moc3
node live2d_my_like/scan-params.js live2d_my_like/076/c_7001.moc3
node live2d_my_like/scan-params.js live2d_my_like/077/c_7002.moc3
node live2d_my_like/scan-params.js live2d_my_like/1014107/1014107.moc3
node live2d_my_like/scan-params.js live2d_my_like/1024100/1024100.moc3
```

#### 單一查詢：只問這個模型有沒有某一個參數 ID（cmd/終端機）

在總體查詢的路徑後面**多帶一個參數**（要查的參數 ID 字串）：
```
node live2d_my_like/scan-params.js <moc3 檔案路徑> <參數 ID>
```
範例（實測結果）：
```
$ node live2d_my_like/scan-params.js live2d_my_like/076/c_7001.moc3 PARAM_ARM_L_ROTATE
live2d_my_like/076/c_7001.moc3
PARAM_ARM_L_ROTATE → ❌ 不存在

$ node live2d_my_like/scan-params.js live2d_my_like/1009109/1009109/1009109.moc3 PARAM_ARM_L_ROTATE
live2d_my_like/1009109/1009109/1009109.moc3
PARAM_ARM_L_ROTATE → ✅ 存在

$ node live2d_my_like/scan-params.js live2d_my_like/076/c_7001.moc3 ParamAngleX
live2d_my_like/076/c_7001.moc3
ParamAngleX → ✅ 存在
```
帶第二個參數就是單一查詢模式（只印一行 ✅/❌，不印全部清單）；只帶路徑、不帶第二個參數就是總體查詢模式。想幫其他角色（例如把 `L2D_CFG.char1`/`char2` 換成別的模型之前）先確認某個 `L2DGesturePlayer` 動作能不能用，就用單一查詢把 `GESTURES` 裡會用到的每個 `PARAM_XXX` 都查一遍即可，不用自己手動掃。

---

### 快速選哪個方法？

| 想做的事 | 用哪個方法 |
|---|---|
| 確認頁面上「當下這個角色」實際套用的模型有沒有某參數 | 方法 A（F12），要先開好頁面 |
| 還沒開頁面、單純想知道某個 moc3 檔案有哪些參數 | 方法 B（cmd），不用開瀏覽器 |
| 想幫 `L2DGesturePlayer.js` 的 `GESTURES` 設計新動作、確認要用的參數 ID 存不存在 | 方法 B（cmd）的單一查詢，最快 |
| 想順手拖滑桿看某參數實際控制什麼視覺效果 | 方法 A（F12）搭配 `Live2d-model-master/index.html` 的 Parameter 檢查器（見各角色專屬 `.md` 文件第四節） |

---

## 四、獨立特殊動作指令（F12 測試用）

這節收的是**沒有走 `L2DGesturePlayer.js`／`GESTURES` 正式系統**、單純在 F12 Console 直接操作 `coreModel`／PIXI `model` 物件做出來的測試指令——除了 `chatter` 已經正式收錄進 `GESTURES`，其他都還是「貼上去試效果」的階段，還沒烤成正式動作。全部要在 `host.html`/`player.html` 開好、角色載入完成後才能貼（跟第三節方法 A 一樣的前提）。

### 4.1 `chatter`：碎嘴子（已正式收錄，這裡只留指令）

完整定義在 `multi/L2DGesturePlayer.js` 的 `GESTURES`，設計過程/更正紀錄記在 `076/納茲.md` 第五節，露西的交叉引用在 `077/露西.md` 第五節。

```js
L2DGesturePlayer.play('chatter')          // 不帶 charKey → 納茲＋露西同時碎念（已實測確認）
L2DGesturePlayer.play('chatter', 'c1')    // 只測納茲
L2DGesturePlayer.play('chatter', 'c2')    // 只測露西
```

### 4.2 對角線來回飛行（單角色／雙角色同步／雙角色交叉路徑）

角色一走左上↔右下、角色二走右上↔左下，兩條對角線會在畫面正中央交叉而過；`easeInOut` 緩動跟 `MagicShotVFX.js` 魔法球飛行用的是同一條曲線。

```js
window._flyStop = { c1: false, c2: false };

// 每個角色各自的對角線起訖點
const FLY_PATHS = {
  c1: (mw, mh) => [{ x: 0, y: 0 }, { x: window.innerWidth - mw, y: window.innerHeight - mh }],
  c2: (mw, mh) => [{ x: window.innerWidth - mw, y: 0 }, { x: 0, y: window.innerHeight - mh }],
};

function _flyOneLoop(charKey, legs, durationMs) {
  const m = L2D['_' + charKey].model;
  const mw = m.width, mh = m.height;
  const [pointA, pointB] = (FLY_PATHS[charKey] || FLY_PATHS.c1)(mw, mh);
  const easeIO = t => t < .5 ? 2*t*t : -1 + (4 - 2*t)*t;

  window._flyStop[charKey] = false;
  let leg = 0;

  function runLeg() {
    if (leg >= legs || window._flyStop[charKey]) return;
    const from = leg % 2 === 0 ? pointA : pointB;
    const to   = leg % 2 === 0 ? pointB : pointA;
    const start = performance.now();

    function tick(now) {
      if (window._flyStop[charKey]) return;
      const t  = Math.min(1, (now - start) / durationMs);
      const et = easeIO(t);
      m.x = from.x + (to.x - from.x) * et;
      m.y = from.y + (to.y - from.y) * et;
      if (t < 1) requestAnimationFrame(tick);
      else { leg++; runLeg(); }
    }
    requestAnimationFrame(tick);
  }
  runLeg();
}

function flyLoop(charKey, legs = 10, durationMs = 1500) {
  const chars = charKey ? [charKey] : ['c1', 'c2'];
  chars.forEach(c => _flyOneLoop(c, legs, durationMs));
}

flyLoop();   // 貼完這一整段馬上執行：不帶參數 → 兩角色同時起跑，各自 10 趟（5 來回）
```

用法：
```js
flyLoop();                // 兩角色同時跑，交叉路徑，各 10 趟
flyLoop('c1');             // 只跑角色一
flyLoop('c2');             // 只跑角色二
flyLoop('c1', 6, 1000);    // 角色一跑 6 趟、每趟 1 秒
```

停止／復原：
```js
window._flyStop.c1 = true;    // 只停角色一
window._flyStop.c2 = true;    // 只停角色二
L2D._fit(L2D._c1, L2D_CFG.char1, 'left');    // 復原角色一位置
L2D._fit(L2D._c2, L2D_CFG.char2, 'right');   // 復原角色二位置
```
