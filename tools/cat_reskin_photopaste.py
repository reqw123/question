#!/usr/bin/env python3
"""
cat_reskin_photopaste.py — 實驗版：直接把 home_cat.jpg 的真實照片像素「貼」進材質裡，
而不是像 cat_reskin.py 那樣只做 HSV 色相位移＋程式化條紋。

使用者明確要求「你嘗試直接貼上，我看看效果」，這支腳本就是那個實驗結果，
用來對照 cat_reskin.py（v2 程式化換色版）給使用者比較判斷。

做法（跟 cat_reskin.py 共用同一套皮膚色遮罩/白毛端偵測邏輯，只有「填色來源」不同）：

    1. 遮罩範圍完全沿用 cat_reskin.py 的 build_skin_mask()/stripe_pattern()，
       確保換色範圍跟形狀/Alpha 邊界的規則一致（不動輪廓、不動透明邊界）。
    2. 填色不再是單一色相位移，而是真的從 home_cat.jpg 裁下三塊乾淨照片（額頭虎斑紋、
       白色腳掌、鼻頭），做鏡射無縫拼貼（mirror-tile）鋪滿對應遮罩範圍，
       Hue/Saturation 直接來自照片像素，Value 用「原圖明暗結構」跟「照片自身明暗變化」
       按比例混合（PHOTO_V_INFLUENCE），保留原本的線稿/高光可見度。
    3. 這是直接貼真實照片像素，不是統計數字算出來的單一顏色——代價是照片
       裁片會因為鋪滿整張 2048×2048 Atlas 而重複出現（貼紙感/花磚感），
       這正是使用者要求「先看看效果」的部分，讓她親眼判斷是否比 v2 更好。

用法：
    python tools/cat_reskin_photopaste.py <來源png(通常是textures_backup的原圖)> <輸出png> <參考照片路徑>

範例：
    python tools/cat_reskin_photopaste.py \
        live2d_my_like/models/girl120_test/textures_backup/texture_00.png \
        live2d_my_like/models/girl120_test/texture_00_photopaste_preview.png \
        live2d_my_like/models/girl120_test/reference_photos/cat_front.jpg
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, str(Path(__file__).parent))
from cat_reskin import build_skin_mask, stripe_pattern, NOSE_BBOX  # 共用同一套遮罩邏輯

# 三塊裁自 home_cat.jpg 的「乾淨」照片區域（bbox 格式 (x0,y0,x1,y1)，原圖像素座標）。
# 挑選標準：無鬍鬚/反光/陰影過重干擾，且看得到真實花紋（額頭這塊有清楚的「M」虎斑紋）。
FUR_STRIPE_PATCH_BBOX = (370, 460, 700, 600)   # 額頭虎斑紋（主要身體/四肢用色來源）
WHITE_PATCH_BBOX       = (280, 1300, 420, 1420)  # 腳掌白毛
NOSE_PATCH_BBOX        = (400, 760, 520, 880)    # 鼻頭

# 貼片放大倍率——放大可以減少 2048×2048 Atlas 上重複出現的次數（降低貼紙感），
# 代價是照片本身的細節會被放大得比較模糊。1.0 = 原始像素密度。
PATCH_UPSCALE = 2.2

# Value（明暗）混合權重：0 = 完全保留原圖明暗結構（形狀/線稿最清楚，但看不出照片本身的光影變化）；
# 1 = 完全套用照片本身的明暗（花紋最真實，但原本角色的線稿/高光會被蓋掉一部分）。
PHOTO_V_INFLUENCE = 0.55


def _mirror_tile(patch_rgb: np.ndarray, canvas_size: int) -> np.ndarray:
    """把一塊照片裁片鏡射拼成 2x2 無縫磚塊，再重複鋪滿整個畫布，避免貼合處出現硬邊接縫。"""
    flip_h = patch_rgb[:, ::-1]
    flip_v = patch_rgb[::-1, :]
    flip_hv = patch_rgb[::-1, ::-1]
    top = np.concatenate([patch_rgb, flip_h], axis=1)
    bottom = np.concatenate([flip_v, flip_hv], axis=1)
    seamless = np.concatenate([top, bottom], axis=0)  # (2h, 2w, 3)

    sh, sw = seamless.shape[:2]
    reps_y = int(np.ceil(canvas_size / sh)) + 1
    reps_x = int(np.ceil(canvas_size / sw)) + 1
    tiled = np.tile(seamless, (reps_y, reps_x, 1))
    return tiled[:canvas_size, :canvas_size]


def load_photo_tile(photo_path: Path, bbox: tuple, canvas_size: int, upscale: float = PATCH_UPSCALE) -> np.ndarray:
    """裁出照片指定區域，放大後鏡射拼貼鋪滿畫布，回傳 HSV（0~1）陣列。"""
    patch = Image.open(photo_path).convert("RGB").crop(bbox)
    if upscale != 1.0:
        w, h = patch.size
        patch = patch.resize((max(1, int(w * upscale)), max(1, int(h * upscale))), Image.BICUBIC)
    patch_rgb = np.array(patch)
    tiled_rgb = _mirror_tile(patch_rgb, canvas_size)
    tiled_hsv = np.array(Image.fromarray(tiled_rgb, "RGB").convert("HSV")).astype(np.float64) / 255.0
    return tiled_hsv


def _apply_photo_paste(base_hsv: np.ndarray, region_mask: np.ndarray, photo_hsv: np.ndarray) -> np.ndarray:
    """
    在 region_mask 範圍內，用 photo_hsv 的 H/S 直接取代，V 則跟原圖 V 依 PHOTO_V_INFLUENCE 混合。
    回傳更新後的完整 HSV 陣列（region_mask 以外的像素完全不動）。
    """
    out = base_hsv.copy()
    photo_v = photo_hsv[..., 2]
    photo_v_mean = photo_v[region_mask].mean() if region_mask.any() else photo_v.mean()
    photo_v_norm = np.where(photo_v_mean > 1e-6, photo_v / max(photo_v_mean, 1e-6), 1.0)

    orig_v = base_hsv[..., 2]
    blended_v = np.clip(orig_v * (1.0 - PHOTO_V_INFLUENCE + PHOTO_V_INFLUENCE * photo_v_norm), 0, 1)

    out[..., 0] = np.where(region_mask, photo_hsv[..., 0], out[..., 0])
    out[..., 1] = np.where(region_mask, photo_hsv[..., 1], out[..., 1])
    out[..., 2] = np.where(region_mask, blended_v, out[..., 2])
    return out


def reskin(src_path: Path, dst_path: Path, reference_photo: Path) -> None:
    img = Image.open(src_path).convert("RGBA")
    arr = np.array(img).astype(np.float64)
    alpha = arr[..., 3]
    canvas_size = arr.shape[0]

    rgb_u8 = arr[..., :3].astype(np.uint8)
    hsv = np.array(Image.fromarray(rgb_u8, "RGB").convert("HSV")).astype(np.float64) / 255.0

    mask = build_skin_mask(hsv, alpha)

    nx0, ny0, nx1, ny1 = NOSE_BBOX
    nose_mask_full = np.zeros_like(mask)
    nose_mask_full[ny0:ny1 + 1, nx0:nx1 + 1] = alpha[ny0:ny1 + 1, nx0:nx1 + 1] > 0
    body_mask = mask & ~nose_mask_full

    _, white_tip = stripe_pattern(body_mask)
    fur_mask = body_mask & ~white_tip

    print(f"身體/毛色範圍像素數: {int(fur_mask.sum())}；白毛端: {int(white_tip.sum())}；鼻子: {int(nose_mask_full.sum())}")

    new_hsv = hsv.copy()

    fur_photo_hsv = load_photo_tile(reference_photo, FUR_STRIPE_PATCH_BBOX, canvas_size)
    new_hsv = np.where(
        fur_mask[..., None], _apply_photo_paste(new_hsv, fur_mask, fur_photo_hsv), new_hsv
    )

    white_photo_hsv = load_photo_tile(reference_photo, WHITE_PATCH_BBOX, canvas_size)
    new_hsv = np.where(
        white_tip[..., None], _apply_photo_paste(new_hsv, white_tip, white_photo_hsv), new_hsv
    )

    nose_photo_hsv = load_photo_tile(reference_photo, NOSE_PATCH_BBOX, canvas_size)
    new_hsv = np.where(
        nose_mask_full[..., None], _apply_photo_paste(new_hsv, nose_mask_full, nose_photo_hsv), new_hsv
    )

    new_hsv_u8 = (np.clip(new_hsv, 0, 1) * 255).astype(np.uint8)
    new_rgb = np.array(Image.fromarray(new_hsv_u8, "HSV").convert("RGB")).astype(np.float64)

    out = arr.copy()
    out[..., :3] = new_rgb
    out[..., 3] = alpha  # alpha 全程不動，透明邊界跟原圖一致

    Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGBA").save(dst_path)
    print(f"已輸出（直接貼照片像素版）: {dst_path}")
    print("提醒：這是實驗性做法，小塊照片鋪滿整張 Atlas 會有重複花磚感，屬於已知取捨，供比較判斷用。")


def main() -> None:
    if len(sys.argv) != 4:
        print("用法: python tools/cat_reskin_photopaste.py <來源png> <輸出png> <參考照片路徑>")
        sys.exit(1)
    reskin(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]))


if __name__ == "__main__":
    main()
