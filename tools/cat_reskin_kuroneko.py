#!/usr/bin/env python3
"""
cat_reskin_kuroneko.py — 把 kuroneko_test（黑貓、寫實四足比例 Live2D 模型）的材質，
程式化改色成橘色虎斑貓花色，用 home_cat.jpg 實測的顏色為準。

跟 girl120_test 那個「貓耳擬人少女」模型不同，kuroneko 這個模型本身就是**寫實四足貓的比例**
（圓形頭、四肢、尾巴、耳朵都是貓的形狀，不是人形），所以換色後不會有「形狀對不上」的問題
——這是使用者提供 kuroneko 的材質 Atlas 圖（貓咪 Live2D 骨架圖）之後，重新選定的换皮對象。

方法（沿用 cat_reskin.py 驗證過的 HSV 色相位移＋程式化條紋，這次額外加上眼睛換色）：

    1. 這個模型的毛色是深藍黑色（實測 HSV 約 246°~350° 色相、11%~25% 飽和度、17%~40% 明度），
       跟鼻子/舌頭（粉紅，明度 75%~89%）、耳內（藕色，明度 48%~55%）、獠牙（純白）、
       眼睛虹膜（綠色，明度 87%）在「明度」上有清楚的分界，用明度+飽和度雙門檻就能
       乾淨切出「毛色」範圍，不會誤傷這些已經是合理顏色、不需要換色的部件。
    2. 毛色範圍內：色相位移到橘色（跟 cat_reskin.py 用同一組實測 home_cat.jpg 數值），
       飽和度從原本很低的個位數/十位數拉到目視合理的橘貓飽和度（原本太低沒辦法只靠等比例
       縮放就變顯眼，這裡用「乘＋加」的方式而不是純乘，避免顏色太淡看不出來是橘貓）。
    3. 沿用 cat_reskin.py 的 stripe_pattern()（PCA 找每個連通區塊的長軸，疊加週期性虎斑條紋、
       偵測四肢/尾巴的「腳掌端」做白毛)。
    4. **新增**：眼睛虹膜（綠色小圓，色相約 138°）是這個模型裡少數能明確、安全辨識的區域
       （不像 girl120 那次怎麼找都找不到眼睛對應區域），額外把它從綠色調成琥珀/金黃色，
       更接近 home_cat.jpg 實測的貓眼顏色。
    5. 鼻子/舌頭/耳內/獠牙/鬍鬚全部落在毛色遮罩之外，維持原圖顏色不動——這些本來就已經是
       合理的顏色（粉紅鼻子/舌頭、白色獠牙鬍鬚），不需要換色。
    6. Alpha 色版全程不動，透明邊界跟原圖一模一樣。

    只輸出到新檔案，不會覆蓋 kuroneko_00.png；要正式套用請用 tools/texture_replace.py。

用法：
    python tools/cat_reskin_kuroneko.py <來源png> <輸出png> [參考照片路徑]
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, str(Path(__file__).parent))
from cat_reskin import stripe_pattern, load_fur_grain  # 共用連通區塊條紋/毛髮紋理邏輯

# 毛色範圍：明度、飽和度雙門檻（見檔頭說明的實測數據）
FUR_VALUE_MAX = 0.45
FUR_SAT_MAX = 0.35

# 目標橘色（跟 cat_reskin.py 同一組實測 home_cat.jpg 數值）
TARGET_HUE = 27.0 / 360.0
SAT_MULT = 3.6
SAT_ADD = 0.24
SAT_MAX = 0.78

# 這個模型原本是黑貓，毛色明度刻意做得很低（17%~40%）——直接套用色相位移的話，
# 明度沒跟著拉高，看起來會是「深棕色」而不是橘貓的鮮豔橘色，所以額外做明度提升，
# 用乘法（而不是直接設定固定值）保留原本高光/陰影的相對明暗結構。
VALUE_BOOST = 2.8
VALUE_MAX = 0.97

# 條紋參數（沿用 cat_reskin.py 的邏輯與預設）
STRIPE_DARKEN = 0.28
MIN_REGION_PIXELS = 80

# 白毛端（腳掌/尾尖）——這個模型的四肢圓柱形狀，「較寬/較圓的一端」判斷邏輯
# 抓到的是肩膀端而不是腳掌端（跟 cat_reskin.py 原本設計的四肢形狀不同），
# 這版先關閉自動白毛端偵測，避免抓錯端；之後看即時渲染結果再決定要不要
# 手動指定腳掌端方向。
WHITE_TIP_ENABLED = False
WHITE_TIP_SAT_MUL = 0.15
WHITE_TIP_VAL_MUL = 1.15
WHITE_TIP_VAL_MAX = 0.92

# 眼睛虹膜換色：原本綠色（色相約 110°~160°、飽和度 15%~40%、明度 >70%）
EYE_HUE_RANGE = (100.0 / 360.0, 165.0 / 360.0)
EYE_SAT_RANGE = (0.12, 0.45)
EYE_VALUE_MIN = 0.65
EYE_TARGET_HUE = 45.0 / 360.0   # 琥珀/金黃色
EYE_SAT_BOOST = 1.3
EYE_SAT_MAX = 0.55

# 毛髮紋理（沿用 cat_reskin.py 的 home_cat.jpg 取樣patch）
FUR_GRAIN_ENABLED = True
FUR_PATCH_BBOX = (370, 1030, 470, 1150)
FUR_GRAIN_STRENGTH = 0.07


def build_fur_mask(hsv: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    return (alpha > 0) & (v <= FUR_VALUE_MAX) & (s <= FUR_SAT_MAX)


def build_eye_mask(hsv: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    return (
        (alpha > 0)
        & (h >= EYE_HUE_RANGE[0]) & (h <= EYE_HUE_RANGE[1])
        & (s >= EYE_SAT_RANGE[0]) & (s <= EYE_SAT_RANGE[1])
        & (v >= EYE_VALUE_MIN)
    )


def reskin(src_path: Path, dst_path: Path, reference_photo: Path = None) -> None:
    img = Image.open(src_path).convert("RGBA")
    arr = np.array(img).astype(np.float64)
    alpha = arr[..., 3]

    rgb_u8 = arr[..., :3].astype(np.uint8)
    hsv = np.array(Image.fromarray(rgb_u8, "RGB").convert("HSV")).astype(np.float64) / 255.0

    fur_mask = build_fur_mask(hsv, alpha)
    eye_mask = build_eye_mask(hsv, alpha)
    print(f"毛色範圍像素數: {int(fur_mask.sum())} / {fur_mask.size} ({fur_mask.sum()/fur_mask.size*100:.1f}%)")
    print(f"眼睛虹膜範圍像素數: {int(eye_mask.sum())}")

    stripe, white_tip = stripe_pattern(fur_mask)
    print(f"白毛端（腳掌/尾尖推測區域）像素數: {int(white_tip.sum())}")

    new_hsv = hsv.copy()

    # 毛色：色相→橘色，飽和度拉高，明度依條紋輕微變暗
    new_hsv[..., 0] = np.where(fur_mask, TARGET_HUE, hsv[..., 0])
    new_hsv[..., 1] = np.where(
        fur_mask, np.clip(hsv[..., 1] * SAT_MULT + SAT_ADD, 0, SAT_MAX), hsv[..., 1]
    )
    darken = np.where(fur_mask, 1.0 - stripe * STRIPE_DARKEN, 1.0)
    boost = np.where(fur_mask, VALUE_BOOST, 1.0)
    new_v = np.clip(hsv[..., 2] * darken * boost, 0, 1)
    new_v = np.where(fur_mask, np.minimum(new_v, VALUE_MAX), new_v)

    if FUR_GRAIN_ENABLED and reference_photo is not None and reference_photo.exists():
        grain = load_fur_grain(reference_photo, FUR_PATCH_BBOX, arr.shape[0])
        new_v = np.where(fur_mask, np.clip(new_v * (1.0 + grain * FUR_GRAIN_STRENGTH), 0, 1), new_v)
        print(f"已疊加從 {reference_photo.name} 萃取的毛髮紋理（strength={FUR_GRAIN_STRENGTH}）")

    new_hsv[..., 2] = new_v

    # 白毛端：飽和度大幅降低、明度略提高（目前偵測邏輯抓錯端，見上方常數說明，預設關閉）
    if WHITE_TIP_ENABLED:
        new_hsv[..., 1] = np.where(white_tip, hsv[..., 1] * WHITE_TIP_SAT_MUL, new_hsv[..., 1])
        new_hsv[..., 2] = np.where(
            white_tip, np.clip(hsv[..., 2] * WHITE_TIP_VAL_MUL, 0, WHITE_TIP_VAL_MAX), new_hsv[..., 2]
        )

    # 眼睛虹膜：綠色→琥珀色，只動色相/飽和度，明度保留原本的高光結構
    new_hsv[..., 0] = np.where(eye_mask, EYE_TARGET_HUE, new_hsv[..., 0])
    new_hsv[..., 1] = np.where(eye_mask, np.clip(hsv[..., 1] * EYE_SAT_BOOST, 0, EYE_SAT_MAX), new_hsv[..., 1])

    new_hsv_u8 = (np.clip(new_hsv, 0, 1) * 255).astype(np.uint8)
    new_rgb = np.array(Image.fromarray(new_hsv_u8, "HSV").convert("RGB")).astype(np.float64)

    out = arr.copy()
    out[..., :3] = new_rgb
    out[..., 3] = alpha  # alpha 完全不動

    Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGBA").save(dst_path)
    print(f"已輸出: {dst_path}")


def main() -> None:
    if len(sys.argv) not in (3, 4):
        print("用法: python tools/cat_reskin_kuroneko.py <來源png> <輸出png> [參考照片路徑]")
        sys.exit(1)
    ref = Path(sys.argv[3]) if len(sys.argv) == 4 else None
    reskin(Path(sys.argv[1]), Path(sys.argv[2]), ref)


if __name__ == "__main__":
    main()
