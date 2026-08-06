#!/usr/bin/env python3
"""
cat_reskin.py — 把 girl120_test 的材質貼圖，程式化改色成橘色虎斑貓花色。

**這一版的顏色不是憑感覺調的，是直接從 home_cat.jpg（你家貓的正面照）實測取樣算出來的**
（第一版被指出「有照片卻沒真的拿來用」，這裡修正）：

    毛色（cheek/leg/body 多點平均）：HSV ≈ (23°, 40%, 中低明度)
      取樣座標（原圖像素）：(280,850) (300,950) (550,520) (400,1150) (650,1100) (400,1100)
    鼻子（鼻頭）：HSV ≈ (15°, 40%, 46%)——比毛色更偏紅、更粉，不是毛色的橘
      取樣座標：(435,815) (445,825) (430,830)
    白毛（腳掌）：HSV ≈ (64°, 2%, 81%)——幾乎無彩度的淺灰白，不是死白
      取樣座標：(340,1370)
    眼睛虹膜：這張照片室內光線偏暗，實測色偏暗（HSV≈(20°,35%,32%)左右，跟毛色很接近，
      不是想像中鮮豔的琥珀色）——而且目前找不到眼睛對應的可換色區域（見 TEXTURE_ANALYSIS.md
      第 6 節），這版仍然沒有處理眼睛顏色。

方法（色相位移＋程式化條紋疊加＋從照片萃取的毛髮紋理，不是重新手繪）：

    1. 用 HSV 色彩空間找出目前「皮膚色」的像素（乳白/淺褐/淺粉色系）。
       SKIN_HUE_RANGE / SKIN_SAT_RANGE 這兩個範圍是實際從 body/leg/face/tail/tongue
       等已確認區域取樣算出來的（見 girl120_test/TEXTURE_ANALYSIS.md），不是隨便猜的數字。
    2. 只對落在這個範圍內的像素做色相／飽和度調整（位移到上面實測算出的貓咪橘色），
       Value（明暗）完全不動，原本的陰影／高光／線稿明暗結構因此完整保留。
    3. 在調整過的像素上，依每個連通區塊自己的長軸方向疊加一層週期性條紋
       （模擬虎斑紋——沿長軸而不是整張圖統一方向，四肢/尾巴的條紋才會跟
       身體弧度一致，不會變成整張圖同一個方向的怪異平行線）。
    4. **新增**：從 home_cat.jpg 裁一小塊乾淨的毛髮照片，取出它的「高頻細節」
       （原圖減去模糊版本＝局部明暗雜訊，代表毛流本身的粗糙質感，不含整體光影），
       重複貼滿整張 Atlas，疊加在皮膚色區域的明度上——讓平塗色塊多一點毛絨顆粒感，
       不是完全來自想像的紋理，是真的從你家貓的照片轉貼過去的。
    5. Alpha 色版全程原封不動，不透明/透明的邊界跟原圖一模一樣。

    只輸出到一個新檔案，**不會覆蓋 textures/texture_00.png**；要正式套用
    請另外用 tools/texture_replace.py 的 replace 指令（會驗證解析度／透明背景）。

用法：
    python tools/cat_reskin.py <來源png> <輸出png> [參考照片路徑]

範例：
    python tools/cat_reskin.py \
        live2d_my_like/models/girl120_test/textures/texture_00.png \
        live2d_my_like/models/girl120_test/texture_00_catpreview.png \
        live2d_my_like/models/girl120_test/reference_photos/cat_front.jpg
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# 皮膚色範圍（0~1 標準化），取樣自 body/leg/face/tail/tongue 等區域的實測 HSV
SKIN_HUE_RANGE = (0.0, 45.0 / 360.0)   # 0°~45°
SKIN_SAT_RANGE = (0.03, 0.60)          # 3%~60%（涵蓋淺色填色跟深色線稿描邊）

# 目標貓咪橘色——實測 home_cat.jpg 毛色平均約 23°，飽和度 33%~45%。
# 這裡刻意比純photo實測值稍微再飽和一點（照片室內光偏暗、偏灰），
# 但不像上一版拉到 85% 那麼誇張，比較貼近實際看到的橘貓毛色。
TARGET_HUE = 23.0 / 360.0
SAT_BOOST  = 1.6
SAT_MAX    = 0.62

# 從真實照片萃取毛髮紋理用的參數
FUR_GRAIN_ENABLED = True
FUR_PATCH_BBOX    = (370, 1030, 470, 1150)  # home_cat.jpg 裡一塊乾淨腿部毛髮（無條紋交界/無反光）
FUR_GRAIN_BLUR    = 3.0     # 高斯模糊半徑，決定「細節」跟「整體光影」的分界頻率
FUR_GRAIN_STRENGTH = 0.08   # 疊加強度（明度的相對變化比例）——第一版 0.16 太強，蓋掉了條紋看起來像編織紋，調低

# 條紋週期改成「每個區塊的長軸跨度 / 期望條紋數」，而不是固定像素數——
# 這樣大區塊（身體、尾巴）跟小區塊（耳朵）的條紋粗細會依比例縮放，
# 不會出現小區塊條紋擠成一團的問題。長軸跨度太短（例如耳朵尖端的小碎片）
# 直接用最小週期夾住，避免週期趨近 0 造成除法炸掉。
STRIPES_PER_REGION = 4.5      # 每個區塊的長軸上大約疊幾條條紋
STRIPE_PERIOD_MIN  = 10.0     # 週期最小值（像素），避免極小區塊條紋密到看起來像雜訊
STRIPE_DARKEN      = 0.30     # 條紋最深處讓 V（明度）降低的比例
MIN_REGION_PIXELS  = 80       # 小於這個像素數的連通區塊不套條紋（避免雜訊/反鋸齒殘留被當成區塊）

# 白毛（襪子／胸口）：細長區塊（長寬比夠大，像四肢/尾巴）才做，
# 比較兩端「垂直於長軸方向」的分布寬度，較寬／較圓的那一端視為「腳掌端」，
# 只把那一端一小段染白，另一端（通常是跟身體/關節相接、線稿有縫線記號的那端）不動。
WHITE_TIP_MIN_ASPECT   = 1.8   # 長寬比門檻，太接近正方形的區塊不當作「四肢」處理
WHITE_TIP_FRACTION     = 0.22  # 從腳掌端往回算，這個比例長度的範圍做白化
WHITE_TIP_END_SAMPLE   = 0.15  # 判斷「哪一端比較寬」時，各自取頭尾這個比例的點來算寬度


def build_skin_mask(hsv: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """依 HSV 找出「目前是皮膚色」的像素遮罩，只有這個範圍內的像素會被改色。"""
    h, s = hsv[..., 0], hsv[..., 1]
    return (
        (alpha > 0)
        & (h >= SKIN_HUE_RANGE[0]) & (h <= SKIN_HUE_RANGE[1])
        & (s >= SKIN_SAT_RANGE[0]) & (s <= SKIN_SAT_RANGE[1])
    )


def _region_axes(xs: np.ndarray, ys: np.ndarray):
    """回傳 (中心點, 長軸單位向量, 短軸單位向量, 投影到長軸的座標, 投影到短軸的座標)。"""
    pts = np.stack([xs, ys], axis=1).astype(np.float64)
    center = pts.mean(axis=0)
    centered = pts - center
    cov = np.cov(centered.T)
    eigvals, eigvecs = np.linalg.eigh(cov)
    order = np.argsort(eigvals)[::-1]
    main_axis = eigvecs[:, order[0]]
    minor_axis = eigvecs[:, order[1]]
    proj_main = centered @ main_axis
    proj_minor = centered @ minor_axis
    return center, main_axis, minor_axis, proj_main, proj_minor


def stripe_pattern(mask: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """
    對每個獨立連通區塊，沿著各自的長軸方向（PCA 主軸）產生週期性條紋（0~1，1=最深）。
    週期依區塊長軸跨度等比例縮放，大小區塊的條紋疏密看起來會一致。
    回傳 (條紋強度圖, 白毛端遮罩)：白毛端遮罩見 white_tip_mask()。
    """
    labeled, n = ndimage.label(mask, structure=np.ones((3, 3)))
    stripe = np.zeros(mask.shape, dtype=np.float64)
    white_tip = np.zeros(mask.shape, dtype=bool)

    for i in range(1, n + 1):
        ys, xs = np.where(labeled == i)
        if len(xs) < MIN_REGION_PIXELS:
            continue
        center, main_axis, minor_axis, proj_main, proj_minor = _region_axes(xs, ys)

        span = proj_main.max() - proj_main.min()
        period = max(span / STRIPES_PER_REGION, STRIPE_PERIOD_MIN)
        phase = (proj_main / period) * 2 * np.pi
        stripe[ys, xs] = np.sin(phase) * 0.5 + 0.5

        # 長寬比夠大才當作「四肢/尾巴」處理白毛端
        minor_span = proj_minor.max() - proj_minor.min()
        aspect = span / max(minor_span, 1e-6)
        if aspect < WHITE_TIP_MIN_ASPECT:
            continue

        lo, hi = proj_main.min(), proj_main.max()
        end_len = max((hi - lo) * WHITE_TIP_END_SAMPLE, 1.0)
        near_lo = proj_main <= (lo + end_len)
        near_hi = proj_main >= (hi - end_len)
        width_lo = proj_minor[near_lo].std() if near_lo.any() else 0.0
        width_hi = proj_minor[near_hi].std() if near_hi.any() else 0.0
        # 較寬／較圓的那一端視為腳掌端；門檻附近（兩端寬度太接近）就不判斷，避免瞎猜
        if width_lo < 1e-6 and width_hi < 1e-6:
            continue
        paw_is_hi = width_hi > width_lo

        cutoff = hi - (hi - lo) * WHITE_TIP_FRACTION if paw_is_hi else lo + (hi - lo) * WHITE_TIP_FRACTION
        tip_sel = (proj_main >= cutoff) if paw_is_hi else (proj_main <= cutoff)
        white_tip[ys[tip_sel], xs[tip_sel]] = True

    return stripe, white_tip


# 鼻子候選區域（見 region_previews 的連通區塊分析 #24：實心圓潤的橘粉色小色塊，
# 中信心判斷——還沒經過即時渲染驗證，如果之後確認猜錯了，這裡只要改座標重跑即可，
# 不影響其他任何區域）。bbox 格式 (x0, y0, x1, y1)，包含端點。
NOSE_BBOX = (986, 1160, 1087, 1247)
# 實測 home_cat.jpg 鼻頭 HSV ≈ (15°, 40%, 46%)——比毛色（23°）更偏紅一點，
# 不是上一版憑感覺設的鮮豔洋紅（350°）
NOSE_HUE = 15.0 / 360.0
NOSE_SAT = 0.42

# 白毛目標飽和度／明度（把選中的白毛端像素往這個方向拉，而不是直接設成純白，
# 保留原本的陰影結構，看起來才不會像貼了一塊死白色貼紙）。
# 實測 home_cat.jpg 腳掌白毛 HSV ≈ (64°, 2%, 81%)——是淺灰白，不是死白（明度上限
# 從上一版的 1.0 降到 0.9，比較接近實測值）。
WHITE_TIP_SAT_MUL = 0.12
WHITE_TIP_VAL_MUL = 1.12
WHITE_TIP_VAL_MAX = 0.9


def load_fur_grain(photo_path: Path, patch_bbox: tuple, canvas_size: int, seed: int = 20260803) -> np.ndarray:
    """
    從真實照片裁一小塊乾淨毛髮，量測它的紋理顆粒大小／強度（不是直接複製貼上像素），
    再用這組量到的統計特性去生成一張跟畫布同尺寸、真正沒有週期性的隨機雜訊。

    第一版直接 np.tile() 重複貼同一塊、第二版改成隨機翻轉貼一格一格，
    兩版最後都還是看得出規律的網格/編織紋——因為只要是「同一塊內容重複出現」，
    人眼就是抓得到規律，翻轉/鏡射並不會真的打散週期性。
    這裡換一個做法：只從真實照片量測「顆粒大小」（用來決定要模糊到多細）跟
    「強度」（細節層的標準差），然後生成全新的隨機白雜訊、用同樣的模糊半徑處理，
    讓它的粗細跟真實毛髮紋理一致，但每個像素都是獨立隨機生成、不是複製貼上同一塊，
    保證不會有網格重複的問題。粗細/強度兩個數字是從你家貓的照片量出來的，
    不是憑空設定，這點跟「有沒有用到照片」這件事沒有妥協。
    """
    patch = Image.open(photo_path).convert("L").crop(patch_bbox)
    patch_arr = np.array(patch).astype(np.float64)
    blurred_patch = np.array(patch.filter(ImageFilter.GaussianBlur(FUR_GRAIN_BLUR))).astype(np.float64)
    detail = patch_arr - blurred_patch
    target_std = detail.std()  # 從真實照片量到的「紋理強度」

    rng = np.random.RandomState(seed)
    white_noise = rng.standard_normal((canvas_size, canvas_size)) * 255.0
    noise_img = Image.fromarray(np.clip(white_noise + 128, 0, 255).astype(np.uint8), "L")
    blurred_noise = np.array(noise_img.filter(ImageFilter.GaussianBlur(FUR_GRAIN_BLUR))).astype(np.float64)
    grain = blurred_noise - blurred_noise.mean()  # 跟真實照片同一套「模糊半徑決定顆粒大小」的邏輯
    grain_std = grain.std()
    if grain_std > 1e-6:
        grain = (grain / grain_std) * target_std  # 正規化成標準差 1，再乘上從照片量到的真實強度
    return grain / 255.0  # 縮放到 0~1 圖片色階的量級，供 FUR_GRAIN_STRENGTH 再統一調整整體強弱


def reskin(src_path: Path, dst_path: Path, reference_photo: Path = None) -> None:
    img = Image.open(src_path).convert("RGBA")
    arr = np.array(img).astype(np.float64)
    alpha = arr[..., 3]

    rgb_u8 = arr[..., :3].astype(np.uint8)
    hsv = np.array(Image.fromarray(rgb_u8, "RGB").convert("HSV")).astype(np.float64) / 255.0

    mask = build_skin_mask(hsv, alpha)

    # 鼻子候選區域整塊從「一般皮膚色遮罩」裡挖掉——鼻子是獨立覆蓋成粉紅色（見下方），
    # 不該被一般的橘色調整/虎斑條紋邏輯處理到，不然鼻子會長出不該有的條紋。
    nx0, ny0, nx1, ny1 = NOSE_BBOX
    nose_mask_full = np.zeros_like(mask)
    nose_mask_full[ny0:ny1 + 1, nx0:nx1 + 1] = alpha[ny0:ny1 + 1, nx0:nx1 + 1] > 0
    mask = mask & ~nose_mask_full

    print(f"皮膚色遮罩涵蓋像素數: {int(mask.sum())} / {mask.size} ({mask.sum() / mask.size * 100:.1f}%)")

    stripe, white_tip = stripe_pattern(mask)
    print(f"白毛端（腳掌/尾尖推測區域）像素數: {int(white_tip.sum())}")

    new_hsv = hsv.copy()
    new_hsv[..., 0] = np.where(mask, TARGET_HUE, hsv[..., 0])
    new_hsv[..., 1] = np.where(mask, np.clip(hsv[..., 1] * SAT_BOOST, 0, SAT_MAX), hsv[..., 1])
    darken = np.where(mask, 1.0 - stripe * STRIPE_DARKEN, 1.0)
    new_v = np.clip(hsv[..., 2] * darken, 0, 1)

    if FUR_GRAIN_ENABLED and reference_photo is not None and reference_photo.exists():
        grain = load_fur_grain(reference_photo, FUR_PATCH_BBOX, arr.shape[0])
        new_v = np.where(mask, np.clip(new_v * (1.0 + grain * FUR_GRAIN_STRENGTH), 0, 1), new_v)
        print(f"已疊加從 {reference_photo.name} 萃取的毛髮紋理（strength={FUR_GRAIN_STRENGTH}）")
    elif FUR_GRAIN_ENABLED:
        print("⚠️ 沒有提供參考照片路徑，跳過毛髮紋理疊加，只做色相/條紋處理")

    new_hsv[..., 2] = new_v

    # 白毛端：飽和度大幅降低、明度略微提高，模擬白色毛尖，且蓋在條紋效果之後
    # （腳掌/尾尖不應該有虎斑條紋，白毛通常是純色）
    new_hsv[..., 1] = np.where(white_tip, hsv[..., 1] * WHITE_TIP_SAT_MUL, new_hsv[..., 1])
    new_hsv[..., 2] = np.where(white_tip, np.clip(hsv[..., 2] * WHITE_TIP_VAL_MUL, 0, WHITE_TIP_VAL_MAX), new_hsv[..., 2])

    # 鼻子：只調整 Hue/Saturation，Value 保留原圖本來的明暗（不是 stripe 處理過的版本，
    # 因為上面已經把這塊從 mask 挖掉，new_hsv[...,2] 這裡本來就還是原始值，不用再處理）
    new_hsv[ny0:ny1 + 1, nx0:nx1 + 1, 0] = np.where(
        nose_mask_full[ny0:ny1 + 1, nx0:nx1 + 1], NOSE_HUE, new_hsv[ny0:ny1 + 1, nx0:nx1 + 1, 0]
    )
    new_hsv[ny0:ny1 + 1, nx0:nx1 + 1, 1] = np.where(
        nose_mask_full[ny0:ny1 + 1, nx0:nx1 + 1], NOSE_SAT, new_hsv[ny0:ny1 + 1, nx0:nx1 + 1, 1]
    )

    new_hsv_u8 = (np.clip(new_hsv, 0, 1) * 255).astype(np.uint8)
    new_rgb = np.array(Image.fromarray(new_hsv_u8, "HSV").convert("RGB")).astype(np.float64)

    out = arr.copy()
    out[..., :3] = new_rgb
    out[..., 3] = alpha  # alpha 完全不動，透明邊界跟原圖一致

    Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), "RGBA").save(dst_path)
    print(f"已輸出: {dst_path}")


def main() -> None:
    if len(sys.argv) not in (3, 4):
        print("用法: python tools/cat_reskin.py <來源png> <輸出png> [參考照片路徑]")
        sys.exit(1)
    ref = Path(sys.argv[3]) if len(sys.argv) == 4 else None
    reskin(Path(sys.argv[1]), Path(sys.argv[2]), ref)


if __name__ == "__main__":
    main()
