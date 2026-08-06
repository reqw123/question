# AI 生成圖缺少 Alpha 通道 — 處理說明

## 問題是什麼

AI 圖片生成工具（例如 nano banana／Gemini 這類）輸出的 PNG，幾乎都是純
**RGB**，沒有 Alpha（透明）通道。這種圖直接放進 Live2D 模型的 texture
資料夾，畫面上背景不會真的透明，會看到色塊邊緣、白色/黑色描邊等問題——
這個專案裡好幾個模型（1014107、1033113、1034107、1044100、1074100…）
的 `texture_01.png` 都是同一種毛病。

## 用哪支腳本：`fix_texture_alpha.py`

負責把「純 RGB、沒有 alpha」的圖，補上一個正確的透明背景。

```
python tools/fix_texture_alpha.py <輸入圖路徑> [--output <輸出圖路徑>] [--tolerance 15]
```

| 參數 | 說明 |
|---|---|
| 輸入圖路徑（必填） | 要處理的 AI 生成圖 PNG |
| `--output` | 輸出圖路徑。**省略**＝原地覆寫輸入檔（自動先備份成 `<檔名>_backup_original.png`）。**有指定**＝結果另存新檔，輸入檔完全不動 |
| `--tolerance` | 背景色容許誤差，預設 `15`（AI 生成圖背景通常會有壓縮雜訊，不會每個像素都完全同色，不用調） |

### 情境一：AI 生成圖是全新檔案，處理完要放進模型資料夾

輸入輸出分開指定，原始 AI 輸出保留不動，方便之後想重跑或比對：

```bash
python tools/fix_texture_alpha.py \
    _nano_banana_output/texture01_raw.png \
    --output live2d_my_like/models/1064100/textures/texture_01.png
```

### 情境二：要直接修正專案裡已經存在的貼圖檔

不用給 `--output`，直接原地修正（會自動備份）：

```bash
python tools/fix_texture_alpha.py live2d_my_like/models/1064100/textures/texture_01.png
```

## 原理（一句話）

四個角落顏色一致就當作背景色，從角落做 flood fill，只有「跟畫面外圍
連通、顏色在容許誤差內」的像素才會被挖透明——角色素材內部就算剛好有
接近背景色的像素（白色衣服、黑色瞳孔），只要沒連到最外圍，就不會被
誤刪。只處理背景透明化，不會改動任何角色素材本身的顏色或形狀。

## 下一步：找出貼圖裡有哪些獨立部件

背景透明化之後，如果還要找出貼圖裡「這塊是不是多餘的、要整塊去掉」，
用 `atlas_region_finder.py`（這支工具現在也會自動偵測，圖片還沒補 alpha
時會自動先呼叫上面這套邏輯，不用手動分兩步跑）：

```bash
python tools/atlas_region_finder.py <texture_png_path> <輸出資料夾>
```

會在輸出資料夾裡列出所有獨立連通區塊，各自裁切成小圖（`區塊_00_面積NNN.png`
這種檔名），照面積排序、附一份 `REGIONS.md` 清單，看小圖清單指出編號即可，
不用再自己來回猜座標。

## 什麼情況不適用這支腳本

如果是「AI 重新畫了一份已存在角色的貼圖」（例如照原本 kuroneko 的樣子
用 AI 重繪成 home_cat），且**有一份原廠正確 alpha 的貼圖可以參照**，
應該用 `live2d_my_like/models/home_cat/apply_alpha_mask.py` 而不是這支——
那支是直接把「已知正確」的 alpha 遮罩套用到 AI 重繪的新圖上，確保
Piece 邊界逐像素精準對齊原本的 UV，比這支單純用顏色判斷背景更準確、
更適合「重繪既有角色」這種場景。這支 `fix_texture_alpha.py` 是給
**完全沒有任何原廠 alpha 可以參照**的情況用的。
