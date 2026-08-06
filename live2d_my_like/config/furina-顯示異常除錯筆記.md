# 🩺 furina（芙宁娜）模型顯示不出來——除錯筆記

> [!IMPORTANT]
> **本文件目的**
>
> 記錄 `models/furina/芙宁娜.model3.json` 載入後畫面空白（角色完全不顯示）的排查過程、根因，
> 以及最後的修法。
>
> ✅ **已修復**（`lib/live2d.js` 的 `_patchClippingMaskOverflow()`）。
>
> ⚠️ 排查過程中有一輪判斷是錯的（一開始以為是材質解析度太大），保留下來是因為那個排查過程
> 本身有參考價值（怎麼一步步證明「材質太大」這個理論是錯的）。

---

## 🚀 30 秒快速看懂（TL;DR）

> [!TIP]
> - **真正的根因**：這個模型需要 **85 組裁切遮罩（clipping mask）**，但 Cubism 4 官方渲染邏輯每個
>   遮罩貼圖只支援 **4 色版 × 16 塊 = 64 組**上限。
> - 🚨 **第一版修法只擋住了崩潰，沒解決根本問題**：官方分配演算法是「總數平均除以 4」
>   （85÷4≈21），只要平均下來每個色版還是超過 16，**全部 4 個色版都會判定超標、全部 85 組
>   一起分配失敗**（不是只有「超出 64 的那一小部分」壞掉）——這就是為什麼一開始眼睛也變成
>   白眼：眼睛的遮罩跟胸口的遮罩一樣，都在這「全滅」的 85 組裡面。
> - **第二版修法（目前版本）**：把分配演算法從「平均分攤」換成「貪婪填滿」（色版 0 先填到 16
>   個上限，滿了才輪到色版 1，依此類推），最多可以讓 **64 組**正確分配到色版，只剩真正超過
>   64 上限的 **21 組**維持不準確。實測：**眼睛完全恢復正常**，胸口那塊白色方塊還在（它屬於
>   真正超標的 21 組之一）。
> - 兩版修法都是在 `lib/live2d.js` 加執行期補丁，`lib/all.min.js` 本身一個位元組都沒改。
> - 這個模型資料夾裡有 `livehimeConfig/`、`.vtube.json`、`cc_芙宁娜.cfg`——是某套 VTuber 直播
>   軟體的匯出檔，複雜度（991 個 drawable、215 個 part）遠超一般網頁 Live2D 模型規格，這就是
>   為什麼會撞上遮罩數量上限。

---

## ⭐ 核心重點總結

- ⭐ 材質已經從 8192×8192（36MB）縮到 2048×2048（2.9MB），這個改動保留（減少下載體積），但
  **不是**讓模型顯示出來的關鍵——真正的修法是下面的裁切遮罩補丁。
- ⭐ 真正卡住的地方：`setupClippingContext → drawMesh → setupShaderProgram` 讀取
  `getChannelFlagAsColor(undefined)` 回傳的 `undefined`，再讀它的 `.R` 屬性直接 throw，整段
  渲染中止，被上層默默吞掉——肉眼只看到空白畫面，狀態列卻顯示「已載入」。
- ⭐ 對照組（`076` 納茲模型）用同一套流程完全正常顯示，證明問題是**這個模型特有**的，不是
  專案渲染管線整體壞掉。
- ⭐ 修法是**執行期補丁**（monkey patch），不改 `lib/all.min.js` 本身——`getChannelFlagAsColor`
  查不到色版時回傳 `{R:0,G:0,B:0,A:0}` 假色版，而不是讓呼叫端對 `undefined` 取屬性炸掉。
- ⭐ 補丁只在遮罩數量真的超標時才會被用到，對其他所有正常模型完全沒有副作用（`getChannelFlagAsColor`
  原本就會回傳有效物件，不會走到防呆分支）。

---

## 🔍 診斷過程（含一開始判斷錯誤的部分）

### 1️⃣ 檔案本身異常肥大（觀察沒錯，但不是根因）

```
live2d_my_like/models/furina/芙宁娜.moc3              91,471,616 bytes（≈ 91 MB）
live2d_my_like/models/furina/芙宁娜.8192/texture_00.png  35,900,049 bytes（≈ 36 MB，8192×8192）
```

`model3.json` 本身格式沒問題，`Moc`/`Textures`/`Physics`/`DisplayInfo` 四個路徑都對得上。

### 2️⃣ ❌ 第一輪判斷（已證明錯誤）：以為是材質太大讓 WebGL 記憶體配置失敗

用 `viewer.html` 載入後，檢查 `internalModel.textureManager.textures` 讀到空陣列——**這個檢查方式
本身是錯的**：這個版本的 pixi-live2d-display 根本沒有 `textureManager` 這個屬性，查到的「空陣列」
只是屬性路徑寫錯導致的預設值，不是材質真的沒載入的證據。

> [!CAUTION]
> 這是這次排查踩到的一個陷阱：查證據的時候用錯屬性路徑，得到一個看起來很合理、但其實毫無意義的
> 「空陣列」，順著這個錯誤方向做了一輪材質縮圖，最後才發現查錯地方。

### 3️⃣ 動手縮小材質，證明跟材質大小無關

把 `texture_00.png` 從 8192×8192（36MB）縮到 2048×2048（2.9MB，備份原檔於
`texture_00.original_8192.png.bak`），重新載入後用正確的屬性路徑（`curModel.textures`）確認材質
**真的成功載入**（`valid:true, w:2048, h:2048`）——但畫面依然空白。這排除了材質解析度是根因的
可能性。

### 4️⃣ 🧠 逐層排查渲染管線，抓到真正的崩潰點

依序檢查、逐一排除：Part 透明度（抽樣全部正常是 `1`）、Drawable 透明度（991 個裡 610 個是 `1`、
分佈正常，不是全部關閉）、Drawable/Part 數量（991／215，遠超一般模型的幾十個）。

手動呼叫 `app.renderer.render(app.stage)` 強制觸發一次渲染（繞過平常包住 render loop 的
try/catch），截到真正被吞掉的例外：

```
TypeError: Cannot read properties of undefined (reading 'R')
    at pe.setupShaderProgram (lib/all.min.js)
    at Se.drawMesh (lib/all.min.js)
    at ce.setupClippingContext (lib/all.min.js)   ← 問題在這裡
    at Se.doDrawModel (lib/all.min.js)
```

對照組驗證：`076` 納茲模型用同一套流程完全正常顯示，證明問題只發生在 furina，不是渲染管線整體
故障。

### 5️⃣ 🧠 反解 `lib/all.min.js` 原始碼，找到精確機制

直接讀 `lib/all.min.js` 裡 `setupClippingContext`/`setupLayoutBounds`/`getChannelFlagAsColor` 的
邏輯：

```js
class ce {
  getChannelFlagAsColor(t) { return this._channelColors[t] }   // this._channelColors 只有 4 個元素（R/G/B/A）
  ...
}
```

`setupLayoutBounds(usingClipCount)` 把總遮罩數平均分配到 4 個色版，每個色版依實際分配到的數量
`t` 決定切幾塊佈局：

```js
// t<=1：整塊 / t<=2：切半 / t<=4：2x2 / t<=9：3x3 / t<=16（supportMoreMaskDivisions 開）：4x4
// t>16（或沒開 supportMoreMaskDivisions 時 t>9）：
else Tt("not supported mask count : {0}", t)   // ← 只印警告，這個分支完全沒有迴圈把 drawable 排進色版！
```

超出上限的那個色版分支完全沒有內層迴圈，代表：(1) 那批 drawable 的 `_layoutChannelNo` 永遠是
`undefined`；(2) 索引游標 `s`（指向 `_clippingContextListForMask` 的共用游標）沒有跟著推進，
導致後續色版的分配也跟著錯位。furina 實測 `_clippingContextListForMask.length` 是 **85**，遠超
`4×16=64` 的上限。

之後 `setupShaderProgram` 執行：
```js
const i = f._layoutChannelNo;                              // undefined
const r = f.getClippingManager().getChannelFlagAsColor(i);  // this._channelColors[undefined] → undefined
this.gl.uniform4f(t.uniformChannelFlagLocation, r.R, ...);  // r.R → TypeError
```

> 📌 這不是 pixi-live2d-display 的 bug，是 **Cubism 4 官方渲染框架本身的硬性上限**（每張遮罩貼圖
> 最多 4 色版 × 16 分割）；官方遇到超標的處理方式是「印警告、優雅降級（那批 drawable 就不裁切/
> 不完整）」，但這裡下游程式碼沒有對「沒分配到色版」的情況做防呆，才會演變成整個模型的渲染
> 直接中止，而不是「只有超標的那幾個 drawable 不裁切」。

---

## ✅ 修法第一版：執行期防呆（只擋崩潰，沒解決分配問題）

```js
// lib/live2d.js — _patchClippingMaskOverflow()，在每個角色 _load() 完成後呼叫一次
const original = proto.getChannelFlagAsColor;
proto.getChannelFlagAsColor = function (idx) {
  return original.call(this, idx) || { R: 0, G: 0, B: 0, A: 0 };
};
```

效果：查不到色版時回傳全 0 的假色版，而不是讓呼叫端對 `undefined` 取屬性炸掉——**畫面從完全
空白變成可以顯示**，但因為官方「平均分攤」的分配演算法本身沒修，這一版**全部 85 組遮罩仍然
一組都沒有被正確分配**（只是不再崩潰而已），眼睛、胸口都受影響，只是眼睛的白色比較不明顯、
容易被忽略，胸口的白色方塊比較顯眼才先被注意到。

---

## 🧠 追問「眼睛也不見了」才發現的更深問題

用 console 統計 `_clippingContextListForMask` 裡有幾組 `_layoutChannelNo` 是 `undefined`：

```js
const cmgr = model.internalModel.renderer._clippingManager;
cmgr._clippingContextListForMask.filter(c => c._layoutChannelNo === undefined).length;
// → 85（總共也是 85，代表「全部」都沒分配到，不是「超出上限的一小部分」）
```

**根因**：官方 `setupLayoutBounds(usingClipCount)` 的分配方式是「總數平均除以 4」
（`e = ~~(usingClipCount/4)`），不是「先填滿一個色版到 16 再填下一個」。furina 需要 85 組，
`85÷4≈21`，平均下來**每個色版都超過 16 的上限**，所以官方判定「這個色版超標」的分支（只印
警告、完全沒有迴圈把 drawable 排進色版）**同時命中全部 4 個色版**——85 組遮罩無一例外，
沒有任何一組拿到正確的佈局。眼睛的遮罩剛好也在這 85 組裡面，所以第一版補丁上線後畫面能顯示，
但眼睛跟胸口都還是「查不到色版、回傳假色版」的殘缺狀態，只是眼睛的殘缺看起來像「白眼」，
沒有胸口的白方塊那麼顯眼。

## ✅ 修法第二版：把「平均分攤」換成「貪婪填滿」

```js
// lib/live2d.js — _patchClippingMaskOverflow() 裡新增，取代官方的 setupLayoutBounds
const MAX_PER_CHANNEL = 16;
proto.setupLayoutBounds = function (usingClipCount) {
  const list = this._clippingContextListForMask;
  let s = 0;
  for (let r = 0; r < 4 && s < usingClipCount; r++) {
    const t = Math.min(usingClipCount - s, MAX_PER_CHANNEL);   // ← 先填滿到 16，不是平均分攤
    if (t === 0) continue;
    // t==1 / t==2 / t<=4 / t<=9 / t<=16 五個分支，佈局公式跟官方原版完全相同
    // （整塊 / 對半 / 2x2 / 3x3 / 4x4），只是分配策略從「平均分攤」換成「貪婪填滿」
    ...
  }
  // s..usingClipCount-1（真正超過 4×16=64 上限的部分）故意不指定 _layoutChannelNo，
  // 交給第一版的 getChannelFlagAsColor 防呆處理，不會讓渲染崩潰。
};
```

**兩版補丁疊在一起**：色版 0 先填到 16 個上限，滿了才輪到色版 1，依此類推，最多 **4×16=64 組**
能拿到跟官方分支邏輯完全相同的正確佈局；真正超過 64 上限的 **21 組**（85-64）依然沒有色版，
但已經有第一版的 `getChannelFlagAsColor` 防呆頂著，不會崩潰。

**實測驗證**（`multi/player.html`，透過 `localStorage['l2d_mylike_p_char1']` 覆蓋成 furina 路徑）：

| 檢查項目 | 第一版（只防呆） | 第二版（貪婪填滿） |
|---|---|---|
| `_layoutChannelNo` 為 `undefined` 的組數 | 85 / 85 | **21 / 85** |
| 眼睛 | ❌ 白眼（無瞳孔） | ✅ 正常（清楚的藍色瞳孔） |
| 胸口 | ❌ 白色方塊 | ⚠️ 仍是白色方塊（屬於真正超標的 21 組） |
| 整體 | 角色可見，細節多處異常 | 角色正確顯示，僅剩少數超標部件有瑕疵 |

角色一正確顯示 furina 完整立繪（帽子、頭髮、服裝、鞋子、眼睛都對），跟角色二（露西）並排顯示
正常。無渲染錯誤、無崩潰。

> 🔍 **Debug 提示**：這個補丁模式（在 `lib/live2d.js` 用執行期 monkey patch 疊加在 `lib/all.min.js`
> 外面，不動原始檔案）跟 `_attachVisibilitySync()`（Cubism 2 的 VISIBLE: 同步坑，見
> `live2d_my_like/Cubism2參數與透明度除錯筆記.md`）是同一套思路，之後如果又遇到其他模型
> 撞上 Cubism SDK 框架本身的邊界情況，可以照這個模式處理：先反解 `lib/all.min.js` 找到精確的
> 崩潰點，再針對那個函式加防呆／改寫分配策略，而不是整段複製改寫整個渲染器。

> ⚠️ **還沒完全解決**：真正超過 64 上限的那 21 組（胸口白方塊就是其中之一）目前還是沒有正確
> 佈局。這個模型需要的 85 組本來就超過 Cubism 4 單張遮罩貼圖的硬性上限（64），要完全修好只能
> 靠 Cubism Editor 減少源模型的裁切遮罩數量到 64 以內，不是純程式碼補丁能突破的天花板。

## 📎 延伸閱讀 / 相關檔案

- `live2d_my_like/models/furina/芙宁娜.model3.json` — 本次診斷/修復對象。
- `live2d_my_like/models/furina/芙宁娜.8192/texture_00.png` — 已縮小到 2048×2048；原始 8192×8192 版本備份在同資料夾 `texture_00.original_8192.png.bak`。
- `lib/live2d.js` — `_patchClippingMaskOverflow()`（本次修法）、`_attachVisibilitySync()`（同類型的 Cubism 2 執行期補丁，先例）。
- `live2d_my_like/viewer.html` — 用來重現問題、逐層檢查 `curModel`/`coreModel`/`internalModel` 狀態的工具。
- `lib/all.min.js` — pixi-live2d-display 渲染器，`setupClippingContext`/`setupLayoutBounds`/`getChannelFlagAsColor` 崩潰點都在這裡（未修改，僅供之後想深入排查/升級版本時參考）。
- `live2d_my_like/config/manifest.json`（id 10）／`names.json` — furina 的收藏庫註冊項目，路徑正確。
