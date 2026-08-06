# 🎭 Live2D 角色指令說明

> [!IMPORTANT]
> **本文件目的**
>
> 這份文件回答兩個問題：
> 1. `L2D.play()`（`lib/live2d.js`）跟 `L2DGesturePlayer.trigger()`（`multi/L2DGesturePlayer.js`，實務上都打短版的 `L2D.trigger()` 別名）這兩套指令系統差在哪。
> 2. `live2d_my_like/models/076`（納茲）跟 `live2d_my_like/models/1009109` 在資料夾/模型結構上的差別，以及這個差別為什麼直接決定了上面那套指令能不能用。
>
> 兩套指令名字很像、都能讓角色動起來，但底層機制完全不同，混著用很容易誤判「這個角色是不是壞掉了」——**實際上通常只是指令系統跟角色的參數命名對不起來**。

---

## 🚀 30 秒快速看懂（TL;DR）

> [!TIP]
> - `L2D.play(name)` 播的是**模型自帶的動作檔**，任何模型都安全，找不到就自動退回待機動作，**不會報錯**。
> - `L2D.trigger(name, charKey)`（= `L2DGesturePlayer.trigger()`）是**直接改骨架參數**的自訂動作，**只對特定模型系列有效**（1009109／1014107／1024100）；對納茲／露西這類沒有手臂骨架的模型會**靜默失敗**（不報錯，角色也不會動）。
> - 根本原因：納茲(076)／露西(077) 的參數命名是 CamelCase（`ParamAngleX`），1009109 系列是 SCREAMING_SNAKE_CASE（`PARAM_ANGLE_X`）+ **有完整手臂/肩膀骨架**。
> - 想知道某模型有沒有某參數？不用開瀏覽器，直接 `node live2d_my_like/config/scan-params.js <moc3路徑> <參數ID>`——比 F12 更快更準，沒有 Cubism 3/4 `getParameterIndex()` 假索引的陷阱。

---

## ⭐ 核心重點總結

- ⭐ `L2D.play()` 相容任何模型；`L2D.trigger()` / `GESTURES` 只相容「剛好有對應骨架參數」的模型。
- ⭐ Cubism 2 模型的「idle」自動待機，靠的是 `model.json` 裡 key **剛好叫字串 `"idle"`**，跟檔案內容、檔名都無關。
- ⭐ 納茲／露西沒有手臂 IK 骨架，`L2DGesturePlayer.js` 的手勢庫在它們身上大多會靜默失敗；唯一例外是 `random_1`（動態讀參數，不寫死 ID）。
- ⭐ F12 查 Cubism 3/4 參數別用 `getParameterIndex()` 判斷存在與否——它**永遠不回傳 -1**，要改用 `includes()`；Cubism 2 沒有這個陷阱。
- ⭐ 不開瀏覽器也能查參數：`node live2d_my_like/config/scan-params.js <moc3路徑> [參數ID]`，結果比瀏覽器 Console 更可信。

---

## 📖 如何使用本文件（標示說明）

| 標示 | 意義 |
|:---:|---|
| 🚨 | 必看、容易踩坑 |
| ⚠️ | 注意事項 |
| 💡 | 重點整理 |
| 🧠 | 原理解析 |
| 🔍 | 除錯技巧 / 驗證方法 |
| 📌 | 本節結論 |
| ⭐ | 核心重點 |
| 📎 | 延伸閱讀 / 相關檔案 |
| 📋 | Cheat Sheet |

---

## 🧭 快速導航

1. [🆚 一、L2D.play() vs L2DGesturePlayer.trigger()](#一l2dplay-vs-l2dgestureplayertrigger)
   - [快速對照表](#快速對照表)
   - [`L2D.play()` 詳細機制（`lib/live2d.js` 的 `_go()`）](#l2dplay-詳細機制liblive2djs-的-go)
   - [⚠️ Cubism 2 專屬：`idle` 群組名稱＝自動待機播放的開關](#cubism-2-專屬idle-群組名稱自動待機播放的開關)
   - [`L2DGesturePlayer.trigger()` 詳細機制](#l2dgestureplayertrigger-詳細機制)
2. [🧬 二、076（納茲）vs 1009109 資料夾結構比較](#二076納茲vs-1009109-資料夾結構比較)
   - [檔案結構](#檔案結構)
   - [動作檔數量與命名規則](#動作檔數量與命名規則)
   - [骨架參數命名慣例——這是兩者最關鍵的差別](#骨架參數命名慣例——這是兩者最關鍵的差別)
3. [🔍 三、自行驗證的方法](#三自行驗證的方法)
   - [方法 A：F12 瀏覽器 Console（要先開好 host.html/player.html，角色載入完成）](#方法-af12-瀏覽器-console要先開好-hosthtmlplayerhtml角色載入完成)
   - [方法 B：cmd/終端機（Node.js，不用開瀏覽器）](#方法-bcmd終端機nodejs不用開瀏覽器)
   - [快速選哪個方法？](#快速選哪個方法)
4. [🧪 四、獨立特殊動作指令（F12 測試用）](#四獨立特殊動作指令f12-測試用)
   - [4.1 `chatter`：碎嘴子（已正式收錄，這裡只留指令）](#41-chatter碎嘴子已正式收錄這裡只留指令)
   - [4.2 對角線來回飛行（單角色／雙角色同步／雙角色交叉路徑）](#42-對角線來回飛行單角色雙角色同步雙角色交叉路徑)
5. [📋 附錄：常用指令 Cheat Sheet](#附錄常用指令-cheat-sheet)
6. [📎 延伸閱讀 / 相關檔案](#延伸閱讀-相關檔案)

---

## 🆚 一、L2D.play() vs L2DGesturePlayer.trigger()

> 📖 **一句話摘要**：`L2D.play()` 播模型官方動作檔，永遠安全；`L2D.trigger()` 直接改骨架參數，只對特定模型有效。

> 💡 `L2DGesturePlayer.trigger()` 有一個簡易轉發指令 `L2D.trigger(name, charKey)`，
> 效果完全一樣、只是打起來比較短（跟 `L2D.play()` 並排在同一個短物件底下）。
> 詳細原理見本節「`L2DGesturePlayer.trigger()` 詳細機制」開頭的說明。

### 快速對照表

| | `L2D.play(name, delayMs)` | `L2DGesturePlayer.trigger(name?, charKey?)` |
|---|---|---|
| 定義位置 | `lib/live2d.js` | `multi/L2DGesturePlayer.js` |
| 播放的是什麼 | 模型自帶的 **motion3.json 動作檔**（模型師/官方做好的完整動畫） | **直接操控 coreModel 參數**的自訂 keyframe（跟模型本身的動作檔完全無關） |
| 底層呼叫 | `model.motion(group, idx, 3)`（Cubism 官方動作播放 API） | 接管 `coreModel.update`，每幀用 `setParameterValueById()` 手動改參數值再還原 |
| 找動作的方式 | 先查 `gMap`（模型實際擁有的動作群組），用 `L2D_ALIASES` 別名表把檔名清乾淨後比對，找不到就退回播模型第一個可用動作 | 直接從 `GESTURES` 這個寫死在 `L2DGesturePlayer.js` 裡的 JS 物件查 `name` |
| 動作內容從哪來 | 模型自己的 `motions/*.motion3.json` 檔案（外部資源，模型換了動作就換了） | 寫死在程式碼裡的參數 keyframe（跟載入哪個模型無關，程式碼不變） |
| **是否相容任何模型** | ✅ 是——只要模型有對應（或別名對得上）的動作檔就能播，沒有就自然退回待機動作，不會出錯 | ❌ 否——`GESTURES` 裡每個參數 ID（例如 `PARAM_ARM_L_ROTATE`）都是寫死的字串，只有**剛好擁有這些參數 ID**的模型才會有反應，對不上的模型會靜默失敗（不報錯，但角色不動） |
| 呼叫範例 | `L2D.play('skill2')`、`L2D.play('happy', 300)` | `L2D.trigger('victory')`、`L2D.trigger(null, 'c2')`、`L2DGesturePlayer.playAll()`（`playAll` 沒有短版別名，見下方說明） |
| 適合用途 | 播放模型師/官方原本就做好的正式動作（idle、表情、技能動作） | 幫「沒有對應動作檔、但骨架參數夠豐富」的模型，用程式碼即時拼出額外的自訂動作（例如指向、蹲下蓄力等模型本身沒有做成動作檔的姿勢） |

### `L2D.play()` 詳細機制（`lib/live2d.js` 的 `_go()`）

1. 從 `state.gMap`（模型實際載入後，讀 `model.internalModel.settings.motions` 得到的「群組 → 動作檔名清單」）逐一比對。
2. 每個動作檔名先去掉前綴數字（`^\d+_`）、轉小寫，再查 `L2D_ALIASES` 別名表（例如 `'skill_02'` → `'skill2'`、`'happy_01'` → `'happy'`）。
3. 清洗完的 key 等於呼叫時傳入的 `name`，就播放 `model.motion(group, index, 3)`（`3` = FORCE 優先度，立刻打斷目前動作）。
4. 完全找不到對應時，退回播放模型第一個可用動作（讓角色至少會動，不會呆住）。

> 📌 **本節小結**：這一整套完全建立在「模型本身有沒有這個動作檔」上，**跟模型的骨架參數命名無關**——所以不管換成哪個模型，`L2D.play('wait')` 之類的呼叫都不會「壞掉」，最差就是退回播放別的動作。

### ⚠️ Cubism 2 專屬：`idle` 群組名稱＝自動待機播放的開關

> [!CAUTION]
> 跟上面「找不到就退回播第一個動作」這套 `L2D.play()` 自己的 fallback 機制**是兩件不同的事**，這節講的是 pixi-live2d-display 這個第三方套件本身、寫死在程式碼裡的另一條規則。

- 反解 `lib/all.min.js`，Cubism 2 的 motion manager class 建構子裡有這一行：
  ```js
  this.groups = { idle: "idle" };
  ```
- 每一幀的 `update()` 都會檢查「現在有沒有動作在播」，沒有的話就呼叫
  `startRandomMotion(this.groups.idle, IDLE)`，也就是去找 `model.json` 的
  `motions` 物件裡**有沒有一個 key 剛好叫字串 `"idle"`**，有的話就自動從裡面隨機挑一個播放當待機動畫。
- **這個判斷是寫死的字串比對，只認 `"idle"` 這個 key 名稱本身**，跟裡面實際指到哪個 `.mtn`
  檔案、檔案內容是什麼都無關——換句話說，`model.json` 裡只要有 `"idle": [...]` 這個 key，
  不管底下的 `file` 是不是叫 `daiji_idle_01.mtn`，都會被自動待機播放；反過來，把這個 key
  改名成別的（例如 `"skill_01"`），就算內容完全沒變，也不會再自動播放，只能靠手動觸發
  （`curModel.motion('skill_01', 0, ...)` 或 `L2D.play('skill1')`）。

> [!WARNING]
> **只對 Cubism 2 模型有效**（`.moc` + `.mtn` + `model.json`，例如
> `live2d_my_like/models/aek999_1505_destroy`）。實測比對過 Cubism 3/4 的
> `model3.json`（`076/c_7001.model3.json`、`077/c_7002.model3.json`）——兩個都只有
> **一個沒有名字的群組 `""`**，裡面同時放本體動作跟 `skill_02`，完全沒有叫 `"idle"` 的群組，
> 這條「群組名稱＝idle 就自動待機」的規則對它們**根本不適用**——這兩個模型的自動播放，走的是上面
> `L2D.play()` 詳細機制那條「`_go(state, 'wait', 0)` ＋ 別名/fallback」的路，跟 pixi-live2d-display
> 內建的 Cubism 2 idle 偵測是完全不同的兩條機制，不要搞混。

**實例**：`live2d_my_like/models/aek999_1505_destroy/model.json` 目前是：
```json
"motions": {
  "idle": [{ "file": "skill_01.mtn", "fade_in": 0, "fade_out": 0 }],
  "skill_02": [{ "file": "skill_02.mtn", "fade_in": 0, "fade_out": 0 }]
}
```
`idle` 這個 key 名稱特意保留，就是為了讓 `skill_01.mtn`（原本叫 `daiji_idle_01.mtn`）
繼續被自動待機播放；`skill_02` 沒有這個 key 名稱，所以只能手動觸發。

### `L2DGesturePlayer.trigger()` 詳細機制

> [!NOTE]
> **短版別名**：`multi/L2DGesturePlayer.js` 載入時，只要 `L2D`（`lib/live2d.js`）已經先載入好，
> 就會自動掛上 `L2D.trigger(name, charKey)` 等同 `L2DGesturePlayer.trigger(name, charKey)`——
> 跟 `L2D.play()`（播放官方動作）並排在同一個短物件底下，動詞一對比就知道差別，打起來也比較短。
> 兩個名字都能用，`host.html`/`player.html` 的實際呼叫已經改成短版 `L2D.trigger(...)`；
> `playAll(charKey?, gapMs?)`／`stop(charKey?)`／`define(name, def)`／`list()` 這幾個沒有短版別名，
> 還是要打 `L2DGesturePlayer.playAll()` 這樣的完整寫法。

1. `GESTURES` 是一份寫死在程式碼裡的動作字典，每個動作是一組 `{ t, params }` 關鍵幀（或 `random_1` 那種 `type:'fn'` 的程序化版本）。
2. 呼叫 `trigger(name, charKey)` 時：
   - `name` 沒帶 → 從 `Object.keys(GESTURES)` 隨機挑一個。
   - `charKey` 沒帶 → `c1`、`c2` 兩個角色都套用；有帶 `'c1'`/`'c2'` → 只套用該角色。
3. 內部 `_hookChar()` 直接把該角色 `coreModel.update` 換成自訂函式，每一幀用線性插值把 `frames` 裡指定的參數 ID（例如 `PARAM_ARM_L_ROTATE`）推向目標值，播完再還原成原本的 `update`。
4. **關鍵限制**：`cm.setParameterValueById(id, value)` 只有在該模型的 moc3 裡真的存在這個 `id` 字串時才有效；對不上的話，Cubism runtime 內部找不到該參數，這行呼叫會被 `_hookChar` 裡的 `try{}catch{}` 靜默吞掉——**不報錯，但角色完全不會動**。

💡 **重點整理**：新增的 `playAll(charKey?, gapMs?)` 是依序把 `GESTURES` 裡所有動作跑一輪（每個播完自己的時長 + `gapMs` 緩衝才接下一個），方便一次驗證一個模型能不能吃這整批動作。

---

## 🧬 二、076（納茲）vs 1009109 資料夾結構比較

> 📖 **一句話摘要**：兩個角色資料夾層級一致，但動作檔數量、骨架參數命名慣例天差地遠——後者才是決定 `L2DGesturePlayer` 能不能用的關鍵。

### 檔案結構

```
models/076/                      models/1009109/
├─ c_7001.moc3                   ├─ 1009109.moc3
├─ c_7001.model3.json            ├─ 1009109.model3.json
├─ motions/                      ├─ .physics3.json           ← 注意：檔名沒有「1009109」前綴
│  ├─ c_7001.motion3.json (idle) ├─ motions/                 ← 29 個官方風格動作檔
│  └─ skill_02.motion3.json (自製)  │  ├─ 00_Anger_01~03
└─ textures/texture_00.png       │  ├─ 00_Appeal_01~02
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

角色文件（`納茲.md`／`露西.md`）搬到 `live2d_my_like/config/` 底下，不再放在角色資料夾裡，跟 `manifest.json`／`names.json`／`generate-manifest.js` 放一起，跟模型素材本體分開。

兩個角色資料夾層級是一致的（都是「檔案直接放在角色資料夾底下」，沒有多包一層同名子資料夾），`generate-manifest.js` 掃到的路徑會照實際結構寫入。

### 動作檔數量與命名規則

| | 076（納茲） | 1009109 |
|---|---|---|
| 動作檔數量 | 2 個（1 個原廠 idle + 1 個手動做的 `skill_02`） | 29 個（涵蓋 13 種身體情緒動作 + 12 種表情動作 + 3 種彈跳動作） |
| 命名規則 | 自訂（`c_7001` 這種型號碼，非人類可讀） | `00_情緒_編號.motion3.json` / `20_Expression_情緒_編號.motion3.json`，跟 `lib/live2d.js` 的 `L2D_ALIASES` 別名表幾乎是照著同一套慣例設計的（`anger_01`→`anger`、`happy_01`→`happy`、`bound_double`→`boundx2`⋯都對得上） |
| Physics（次要動態，如頭髮/衣物自然擺動） | ❌ 沒有 `Physics3.json`，`model3.json` 裡雖然寫了 `"Physics": ".physics3.json"` 但實際上這個檔案不存在——次要擺動效果要嘛沒做、要嘛是手動關鍵幀在動作檔裡做出來的 | ⚠️ 有 `.physics3.json`，但檔名開頭是點、沒有 `1009109` 前綴（跟 1014107/1024100 的「`型號.physics3.json`」命名不一致），是這批素材本身命名不統一，`model3.json` 裡的參照字串跟實際檔名是對得上的，不影響載入 |
| Groups（EyeBlink/LipSync 參數群組） | `"Groups": []`（空的，沒有登記） | 有登記 `EyeBlink`（`PARAM_EYE_R_OPEN`/`PARAM_EYE_L_OPEN`）、`LipSync`（`PARAM_MOUTH_OPEN_Y`） |

### 骨架參數命名慣例——這是兩者最關鍵的差別

用 `config/076-納茲.md`／`config/077-露西.md` 記錄的實測結果，加上直接讀取 moc3 二進位裡內嵌的參數 ID 字串表交叉驗證：

| | 076（納茲）／077（露西） | 1009109（跟 1014107、1024100 一致） |
|---|---|---|
| 命名風格 | **CamelCase**：`ParamAngleX`、`ParamBodyAngleX`、`ParamMouthOpenY`、`ParamHairFront`⋯外加大量沒有人類可讀名稱的 `Param17`~`Param47`（火焰/魔法陣特效專用，各角色各自獨立定義） | **SCREAMING_SNAKE_CASE**：`PARAM_ANGLE_X`、`PARAM_BODY_ANGLE_X`、`PARAM_ARM_L_ROTATE`、`PARAM_SHOULDER_R_ROTATE`、`PARAM_HAND_L_ROTATE`、`PARAM_STRETCH`、`PARAM_SHOLDER_POSITION`（注意這個模型的參數本身就沒有 U，是原始命名就這樣，不是打字錯）、`PARAM_POSITION_X/Y`、`PARAM_ROTATION_Z` |
| 手臂/肩膀/手掌相關參數 | ❌ 完全沒有（角色的招式是靠火焰粒子/魔法陣光芒參數做出來的，原始建模沒有綁手臂 IK） | ✅ 齊全（`PARAM_ARM_R_ROTATE`、`PARAM_ARM_L_ROTATE`、`PARAM_SHOULDER_R_ROTATE`、`PARAM_SHOULDER_L_ROTATE`、`PARAM_HAND_R_ROTATE`、`PARAM_HAND_L_ROTATE` 等都實際存在於 moc3） |

> [!IMPORTANT]
> **結論**：`L2DGesturePlayer.js` 的 `GESTURES` 字典（`crouch`/`pointing`/`victory`/`surprise`/`slump`/`tremble`/`random_2`~`random_10` 這些用固定 keyframe 寫死參數 ID 的動作）是照著 1009109／1014107／1024100 這一系列模型的參數命名設計的，**而不是**目前 `L2D_CFG` 預設載入的納茲（076）/露西（077）。
>
> 在納茲/露西身上呼叫這些動作，`PARAM_ARM_L_ROTATE` 這類 ID 完全找不到對應目標，會被靜默吞掉、角色不會動；唯一例外是 `random_1`（`type:'fn'`），因為它是動態讀取「當下這個角色實際擁有的參數清單」去亂數，不寫死任何一個 ID，所以換成哪個角色都會有反應。

如果之後想讓納茲/露西也能吃這套手勢庫，兩個方向都可行：

1. 只用兩邊都有的參數（`ParamAngleX/Y/Z`、`ParamBodyAngleX/Y/Z`）重新設計一組簡化版動作，放棄手臂/肩膀類的效果。
2. 把 `L2D_CFG.char1`/`char2` 換成 `1009109`/`1014107`/`1024100` 其中之一（moc3 裡確認齊全的三個模型），`GESTURES` 完全不用改。

---

## 🔍 三、自行驗證的方法

> 📖 **一句話摘要**：F12 查「頁面上實際跑起來的模型」；cmd/終端機查「moc3 檔案本身有什麼」——兩種完全不同的環境，別搞混。

兩種完全不同的環境，不要搞混：**F12** 是瀏覽器開發者工具的 Console 分頁，要先把 `host.html`/`player.html` 開起來、角色載入完成後才能查（查的是「當下這個頁面實際跑起來的模型」）；**cmd/終端機** 是 VS Code 的 Terminal 或 PowerShell，用 `node` 指令執行，完全不用開瀏覽器（直接讀 moc3 檔案本身，跟頁面有沒有在跑無關）。底下用標題明確標出每段指令要貼在哪裡。

---

### 方法 A：F12 瀏覽器 Console（要先開好 host.html/player.html，角色載入完成）

#### 🚨 先看陷阱：不要用 `getParameterIndex()` 判斷參數存不存在（僅限 Cubism 3/4）

> [!CAUTION]
> `getParameterIndex()` **永遠不會回傳 -1**。去反解 `lib/cubism4.min.js` 內嵌的原始碼可以看到：真的找到參數才會在迴圈裡 `return e`；找不到的話，會把這個字串登記進 `_notExistParameterId`、配一個「假索引」（`真實參數數量 + 目前已登記的假參數數量`）並快取起來，下次查同一個字串就回傳同一個假索引，**永遠有回傳值，不會是 -1**。

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

🔍 **Debug 提示**：實測時可以親眼驗證這個陷阱——連續查幾個明顯是打錯/不存在的字串（例如 `'PARAM_ARM_L_ROTAT'`、`'PARAM_ARM_L_ROTA'`），會發現**每一個都拿到一個新的、遞增的數字**，而不是 -1——這就是假登記索引在動。所以角色一/角色二要分開測（`L2D._c1`/`L2D._c2` 是各自獨立的模型，參數表不共用），但**不能只看 `getParameterIndex()` 有沒有回傳數字**來判斷參數是否真的存在。

> ⚠️ 這個陷阱只在 Cubism 3/4 出現。Cubism 2 的 `getParamIndex(id)` 找不到會老實回傳 `-1`，
> 沒有這個問題，見下方「Cubism 2」小節。

> [!CAUTION]
> 🚨 **同一個陷阱也在 Part 身上——`setPartOpacityById()` 一樣不會報錯**。反解
> `lib/cubism4.min.js` 確認過，`setPartOpacityById(id, v)` 內部呼叫的 `getPartIndex(id)`
> 跟上面的 `getParameterIndex()` 是同一套設計，一樣**永遠不會回傳 -1**：
> ```js
> setPartOpacityById(t, e) {
>   const i = this.getPartIndex(t);
>   i < 0 || this.setPartOpacityByIndex(i, e)   // i < 0 這個判斷式永遠不會成立
> }
> getPartIndex(t) {
>   for (let e = 0; e < this._model.parts.count; ++e)
>     if (t == this._partIds[e]) return e;
>   return t in this._notExistPartId
>     ? this._notExistPartId[t]
>     : (/* 配一個假索引，寫進跟畫面無關的幽靈陣列 _notExistPartOpacities，回傳這個假索引 */);
> }
> ```
> 找不到對應 Part 時，`setPartOpacityById()` **不會 throw、不會印警告、畫面上什麼都不會發生**
> ——呼叫「成功」了，只是寫進一個沒人在讀的幽靈陣列。這代表 `try/catch` 完全抓不到「Part ID
> 打錯字」這種情況。`manifest.json` 的 `partOverrides`（見 `config/076-納茲.md` 第六節）
> 套用邏輯（`lib/live2d.js` 的 `_applyPartOverrides()`／`viewer.html` 的
> `applyPartOverrides()`）已經加了對策：呼叫 `setPartOpacityById` 之前，先用
> `getPartCount()`/`_partIds` 撈出這個模型真實擁有的 Part ID 清單、自己手動比對，
> 比對不到才印警告並跳過，不依賴底層 API 的回傳值或例外。

---

#### Cubism 3/4（`.moc3` + `model3.json`，例如納茲/露西/1009109 系列）— 指令都集中在這裡

**查單一參數是否存在（貼到 F12 Console）**：
```js
const cm = L2D._c2.model.internalModel.coreModel;
[...cm._model.parameters.ids].includes('PARAM_ARM_L_ROTATE');   // true/false 才是可信的結果
```

**列出全部參數 ID（貼到 F12 Console）**：
```js
const cm = L2D._c2.model.internalModel.coreModel;
[...cm._model.parameters.ids];   // 這個角色目前擁有的全部參數 ID 陣列
```

**列出全部 Part ID（貼到 F12 Console，已在 `viewer.html` 的 `buildPartInspectorC34()` 實際使用）**：

上面兩段查的都是 **Parameter**（`PARAM_XXX`，負責變形），不會列出 **Part**（負責整組
Drawable 透明度開關，不做變形）——這兩者是分開的資料結構，Cubism 3/4 和 Cubism 2 都一樣，
不是版本差異：
```js
const cm = L2D._c2.model.internalModel.coreModel;
const n = cm.getPartCount();
Array.from({ length: n }, (_, i) => cm._partIds[i]);
```

💡 以上三段都把 `_c2` 換成 `_c1` 就是查角色一，兩個角色要分開查。

---

#### Cubism 2（`.moc` + `model.json`，例如 `aek999_1505_destroy`）— 指令都集中在這裡

⚠️ `_model.parameters.ids` 是 `lib/cubism4.min.js` 專屬的內部結構，Cubism 2 模型的
`coreModel` 完全是另一套私有欄位（`_$5S` 那組），沒有 `_model.parameters` 這個東西，
直接照抄上面 Cubism 3/4 的指令會整段噴錯。

**列出全部參數 ID（貼到 F12 Console，✅ 已實測確認）**：

🧠 **原理解析**：反解 `lib/live2d.min.js` 原始碼可以看到 `getParamIndex()` 內部搜尋的陣列：
```js
y.prototype.getParamIndex = function(aH) {
  for (var aI = this._$pb.length - 1; aI >= 0; --aI) {
    if (this._$pb[aI] == aH) { return aI; }
  }
  return this._$02(aH, 0, y._$tr, y._$lr);
};
```
`this._$pb` 就是參數 ID 陣列本身，跟 Part 用的 `_$F2` 陣列（下面會用到）是同一種設計，
只是換一個私有欄位名字。陣列裡每個元素是 `ak` 這個 ID 包裝類別的實例（`ak.prototype.id = aH`，
且 `ak.prototype.toString` 也正確回傳 `.id`），取字串一樣要拿 `.id`：

```js
const cm = L2D._c1.model.internalModel.coreModel;   // 這裡示範角色一是 Cubism 2 模型的情況
cm._$5S._$pb.map(p => p.id);
```

用 `aek999_1505_destroy` 實測過（角色一載入這個模型時），成功列出參數 ID。
`_$pb.length` 是 `64`，但實際有值的只有 index `0`~`55`（56 個），`56`~`63` 這 8 格
是**陣列本身配置就有的空位（hole）**——`.map()` 對空位不會呼叫回呼函式，結果陣列
對應位置也是空位，DevTools 展開樹狀檢視時會直接跳過不列（摺疊摘要模式才會顯示
`empty × 8` 提示），不是指令寫錯，也不影響 `getParamIndex()` 運作（空位本來就不會被
搜尋比對到）。實際列出的 56 個參數 ID 包含 `PARAM_JC`、`PARAM_EYE_L_OPEN` 這類一般
Parameter，也包含 `VISIBLE:PARTS_01_FACE_001`、`VISIBLE:PARTS_JC` 這些「Part 可見度曲線
偽裝成的 Parameter」——跟 `VISIBLE:` 前綴的機制完全對得上。

> ⚠️ 如果角色一/角色二載入的是 Cubism 3/4 模型（`_$5S` 不存在），這段指令會直接噴
> `TypeError: Cannot read properties of undefined (reading '_$pb')`——這是正常現象，
> 代表這個角色不是 Cubism 2，換成上面 Cubism 3/4 版本的指令即可。

**列出全部 Part ID**：跟 Parameter 一樣，Cubism 2 也是分開的資料結構（`_$F2` 陣列，不是 `_$pb`），
寫法見下方速查表最後一欄；📎 更完整的 Part 除錯筆記（含 `VISIBLE:` 前綴機制）見
`live2d_my_like/Cubism2參數與透明度除錯筆記.md` 第 1、3 節（`aek999_1505_destroy` 除錯過程留下的筆記）。

---

#### 四個組合速查表

| | Parameter（變形） | Part（透明度開關） |
|---|---|---|
| Cubism 3/4 | `[...cm._model.parameters.ids]` | `cm.getPartCount()` + `cm._partIds[i]` |
| Cubism 2 | `cm._$5S._$pb.map(p => p.id)` | `cm._$5S._$F2.map(p => p.getPartsID().id)` |

---

### 方法 B：cmd/終端機（Node.js，不用開瀏覽器）

> 📖 **一句話摘要**：moc3 裡的參數/部件 ID 是純 ASCII 字串，用 `scan-params.js` 直接掃檔案就能拿到完整清單，結果比 F12 更可信（沒有假索引陷阱）。

moc3 是二進位格式，但參數/部件 ID 這類字串是以純 ASCII 直接內嵌在檔案裡供 runtime 查表用，所以不需要真的解析整個 moc3 結構，抓可印出字元的片段就能拿到完整參數清單，結果不會有方法 A 那個假索引陷阱的問題（直接讀檔案，沒有 `getParameterIndex()` 那層包裝）。這份文件裡的所有結論都是用這個方法交叉驗證過的，不是憑猜測——已經包成一支可重複使用的工具腳本：[`scan-params.js`](scan-params.js)。

⚠️ **開啟方式**：VS Code 的 Terminal 或 PowerShell，**不是**瀏覽器 F12 Console——因為它用 `fs` 讀本機檔案，瀏覽器不允許網頁程式碼這樣做。指令裡的路徑是相對於執行 `node` 指令當下的資料夾，記得先切到專案根目錄 `c:\question` 再執行下面的指令。

#### 總體查詢：列出這個模型全部參數 ID（cmd/終端機）

```
node live2d_my_like/config/scan-params.js <moc3 檔案路徑>
```
範例：
```
node live2d_my_like/config/scan-params.js live2d_my_like/models/1009109/1009109.moc3
node live2d_my_like/config/scan-params.js live2d_my_like/models/076/c_7001.moc3
node live2d_my_like/config/scan-params.js live2d_my_like/models/077/c_7002.moc3
node live2d_my_like/config/scan-params.js live2d_my_like/models/1014107/1014107.moc3
node live2d_my_like/config/scan-params.js live2d_my_like/models/1024100/1024100.moc3
```

#### 單一查詢：只問這個模型有沒有某一個參數 ID（cmd/終端機）

在總體查詢的路徑後面**多帶一個參數**（要查的參數 ID 字串）：
```
node live2d_my_like/config/scan-params.js <moc3 檔案路徑> <參數 ID>
```
範例（實測結果）：
```
$ node live2d_my_like/config/scan-params.js live2d_my_like/models/076/c_7001.moc3 PARAM_ARM_L_ROTATE
live2d_my_like/models/076/c_7001.moc3
PARAM_ARM_L_ROTATE → ❌ 不存在

$ node live2d_my_like/config/scan-params.js live2d_my_like/models/1009109/1009109.moc3 PARAM_ARM_L_ROTATE
live2d_my_like/models/1009109/1009109.moc3
PARAM_ARM_L_ROTATE → ✅ 存在

$ node live2d_my_like/config/scan-params.js live2d_my_like/models/076/c_7001.moc3 ParamAngleX
live2d_my_like/models/076/c_7001.moc3
ParamAngleX → ✅ 存在
```

💡 帶第二個參數就是單一查詢模式（只印一行 ✅/❌，不印全部清單）；只帶路徑、不帶第二個參數就是總體查詢模式。想幫其他角色（例如把 `L2D_CFG.char1`/`char2` 換成別的模型之前）先確認某個 `L2DGesturePlayer` 動作能不能用，就用單一查詢把 `GESTURES` 裡會用到的每個 `PARAM_XXX` 都查一遍即可，不用自己手動掃。

---

### 快速選哪個方法？

| 想做的事 | 用哪個方法 |
|---|---|
| 確認頁面上「當下這個角色」實際套用的模型有沒有某參數 | 方法 A（F12），要先開好頁面 |
| 還沒開頁面、單純想知道某個 moc3 檔案有哪些參數 | 方法 B（cmd），不用開瀏覽器 |
| 想幫 `L2DGesturePlayer.js` 的 `GESTURES` 設計新動作、確認要用的參數 ID 存不存在 | 方法 B（cmd）的單一查詢，最快 |
| 想順手拖滑桿看某參數實際控制什麼視覺效果 | 方法 A（F12）搭配 `Live2d-model-master/index.html` 的 Parameter 檢查器（見各角色專屬 `.md` 文件第四節） |

---

## 🧪 四、獨立特殊動作指令（F12 測試用）

> 📖 **一句話摘要**：這節是「還沒烤成正式動作」的實驗性指令，除了 `chatter` 已經正式收錄，其他都是貼上去試效果用的。

這節收的是**沒有走 `L2DGesturePlayer.js`／`GESTURES` 正式系統**、單純在 F12 Console 直接操作 `coreModel`／PIXI `model` 物件做出來的測試指令——除了 `chatter` 已經正式收錄進 `GESTURES`，其他都還是「貼上去試效果」的階段，還沒烤成正式動作。全部要在 `host.html`/`player.html` 開好、角色載入完成後才能貼（跟第三節方法 A 一樣的前提）。

### 4.1 `chatter`：碎嘴子（已正式收錄，這裡只留指令）

完整定義在 `multi/L2DGesturePlayer.js` 的 `GESTURES`，設計過程/更正紀錄記在 `config/076-納茲.md` 第五節，露西的交叉引用在 `config/077-露西.md` 第五節。

```js
L2D.trigger('chatter')          // 不帶 charKey → 納茲＋露西同時碎念（已實測確認）
L2D.trigger('chatter', 'c1')    // 只測納茲
L2D.trigger('chatter', 'c2')    // 只測露西
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

---

## 📋 附錄：常用指令 Cheat Sheet

> 把全文最常回頭查的指令濃縮成一份，半年後回來查的時候直接複製貼上。

```js
// ── F12 Console（Cubism 3/4，例如納茲/露西/1009109 系列）──────────────────
const cm = L2D._c2.model.internalModel.coreModel;      // _c1 查角色一
[...cm._model.parameters.ids].includes('PARAM_ARM_L_ROTATE');  // 查單一參數，true/false 可信
[...cm._model.parameters.ids];                          // 列出全部參數 ID
Array.from({ length: cm.getPartCount() }, (_, i) => cm._partIds[i]);  // 列出全部 Part ID

// ── F12 Console（Cubism 2，例如 aek999_1505_destroy）──────────────────────
const cm2 = L2D._c1.model.internalModel.coreModel;
cm2._$5S._$pb.map(p => p.id);              // 列出全部參數 ID
cm2._$5S._$F2.map(p => p.getPartsID().id); // 列出全部 Part ID

// ── cmd/終端機（不開瀏覽器，先切到專案根目錄 c:\question）─────────────────
// 總體查詢：
// node live2d_my_like/config/scan-params.js <moc3路徑>
// 單一查詢（多帶參數 ID）：
// node live2d_my_like/config/scan-params.js <moc3路徑> <參數ID>

// ── 測試用特殊指令（開好 host.html/player.html 之後貼）────────────────────
L2D.trigger('chatter');   // 碎嘴子，兩角色同時
flyLoop();                // 對角線交叉飛行，兩角色各 10 趟
window._flyStop.c1 = window._flyStop.c2 = true;   // 停止飛行
```

---

## 📎 延伸閱讀 / 相關檔案

文件裡提到的原始碼與檔案，之後追根究柢可以直接回去看：

- `lib/live2d.js` — `L2D.play()` / `_go()` / `L2D_ALIASES` 別名表 / `L2D.trigger()` 短版別名掛載處。
- `multi/L2DGesturePlayer.js` — `GESTURES` 字典、`trigger()` / `playAll()` / `_hookChar()` 實作。
- `live2d_my_like/config/scan-params.js` — 不開瀏覽器直接掃 moc3 參數/部件 ID 的工具腳本。
- `live2d_my_like/config/076-納茲.md`／`077-露西.md` — 各角色參數實測紀錄、`chatter` 動作設計過程。
- `live2d_my_like/Cubism2參數與透明度除錯筆記.md` — Part 透明度／`VISIBLE:` 前綴機制的完整除錯筆記（第 1、3 節）。
- `viewer.html` / `Live2d-model-master/index.html` — Parameter/Part 檢查器，拖滑桿反查參數對應的視覺效果。
- `model.json` / `model3.json` — 各模型的動作/參數/Part 設定檔，`motions`、`Groups`、`Physics` 等欄位定義在這裡。
