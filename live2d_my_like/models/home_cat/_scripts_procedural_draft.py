"""
第一版嘗試：純程式化（PIL/numpy/scipy，無 AI 圖像生成）把 kuroneko_00.png
從黑貓配色改成橘虎斑+白毛家貓配色。

方法：
- 用 alpha 通道做 connected-component 分割，把 atlas 拆成一個一個獨立 Piece。
- 對每個 Piece 轉 HSV，只換 Hue/Saturation，保留原始的 Value（明暗）通道，
  這樣原本畫師畫的漸層陰影/高光會被完整保留，只是「顏色」變了，不是整個重畫。
- 額外疊加程序化的鯖魚虎斑條紋（用正弦波產生周期性暗紋）。
- 依照四象限個別觀察到的 Piece 位置（人工標記），分類套用：
  FUR（毛色+虎斑）/ EAR_OUTER（純橘無紋）/ EAR_INNER、PINK_KEEP（維持粉色系）/
  NOSE（改粉紅）/ EYE（改琥珀）/ PAW_WHITE（全白）/ LEG_SOCK（漸層白襪）/
  CHIN_WHITE（全白）/ KEEP（維持原樣，鬍鬚/牙齒/絨毛）

這是「維持原插畫筆觸風格、只換色」的做法，不是照片級寫實（那需要 AI 圖像生成，
本機沒有這個工具）。輸出成 kuroneko_00_draft_v1.png，不覆蓋 kuroneko_00.png。
"""

import colorsys
import os

import numpy as np
from PIL import Image
from scipy import ndimage

BASE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(BASE, "kuroneko_00.png")
OUT = os.path.join(BASE, "kuroneko_00_draft_v1.png")

QUAD_SIZE = 1024

# 人工標記的角色區塊（象限本地座標 0-1024），依先前對 4 張象限圖的目視分析整理。
# 格式: (role, x0, y0, x1, y1)
HINTS = {
    "TL": [],  # 單一大片頭部，用預設 FUR 規則即可
    "TR": [
        ("FACE_FRONT", 0, 0, 470, 840),      # 臉正面盾形，需要中線白色
        ("TAIL", 470, 0, 800, 1010),          # 尾巴主體，只有環紋不要白
        ("FUR", 340, 690, 530, 910),          # 尾根小片
        ("CHIN_WHITE", 1120, 940, 1024 * 2, 1024),  # 交界處，容忍越界
        ("CHIN_WHITE", 150, 940, 300, 1024),
        ("KEEP", 870, 560, 1010, 640),        # 犬齒
        ("EYE", 870, 670, 1000, 810),         # 虹膜綠色圓
        ("KEEP", 850, 0, 1024, 130),          # 鬍鬚線稿
        ("KEEP", 800, 870, 1024, 1024),       # 鬍鬚線稿
    ],
    "BL": [
        ("FACE_FRONT", 0, 10, 660, 600),      # 口鼻橢圓，需要中線白色
        ("EAR_OUTER", 660, 10, 880, 320),     # 耳外側三角
        ("LEG_SOCK", 630, 320, 890, 810),     # 前臂上段
        ("NOSE", 480, 670, 620, 790),         # 鼻子
        ("PINK_KEEP", 835, 655, 950, 805),    # 粉色橢圓片
        ("LEG_SOCK", 10, 800, 540, 1024),     # 前肢下段
        ("PAW_WHITE", 540, 830, 770, 1024),   # 前掌
        ("FUR", 780, 850, 1024, 1024),        # 身體側面弧片
        ("KEEP", 10, 590, 530, 680),          # 鬍鬚線稿
    ],
    "BR": [
        ("LEG_SOCK", 0, 0, 280, 620),         # 後腿 1
        ("LEG_SOCK", 220, 0, 570, 620),       # 後腿 2
        ("EAR_OUTER", 565, 70, 780, 390),
        ("EAR_INNER", 800, 100, 1010, 420),
        ("EAR_INNER", 800, 380, 1010, 620),
        ("PAW_WHITE", 565, 400, 810, 600),
        ("KEEP", 680, 0, 1024, 130),          # 眉毛/絨毛
        ("KEEP", 370, 570, 620, 850),         # 眉毛/絨毛
        ("PINK_KEEP", 565, 840, 810, 1024),   # 舌頭
        ("FUR", 0, 860, 350, 1024),           # 臀部
        ("PAW_WHITE", 780, 660, 1024, 850),
        ("PAW_WHITE", 780, 850, 1024, 1024),
        ("KEEP", 0, 580, 350, 800),           # 鬍鬚線稿
    ],
}

QUAD_ORIGIN = {
    "TL": (0, 0),
    "TR": (QUAD_SIZE, 0),
    "BL": (0, QUAD_SIZE),
    "BR": (QUAD_SIZE, QUAD_SIZE),
}

ORANGE_H, ORANGE_S = 30 / 360, 0.74
STRIPE_H, STRIPE_S = 18 / 360, 0.75
AMBER_H, AMBER_S = 42 / 360, 0.72
SALMON_H, SALMON_S = 8 / 360, 0.45
EAR_INNER_H, EAR_INNER_S = 10 / 360, 0.28


def rgb_to_hsv_arr(rgb):
    r, g, b = rgb[..., 0] / 255.0, rgb[..., 1] / 255.0, rgb[..., 2] / 255.0
    hsv = np.zeros_like(rgb, dtype=np.float64)
    maxc = np.maximum(np.maximum(r, g), b)
    minc = np.minimum(np.minimum(r, g), b)
    v = maxc
    delta = maxc - minc
    s = np.where(maxc == 0, 0, delta / np.where(maxc == 0, 1, maxc))
    rc = np.where(delta == 0, 0, (maxc - r) / np.where(delta == 0, 1, delta))
    gc = np.where(delta == 0, 0, (maxc - g) / np.where(delta == 0, 1, delta))
    bc = np.where(delta == 0, 0, (maxc - b) / np.where(delta == 0, 1, delta))
    h = np.zeros_like(v)
    h = np.where(maxc == r, bc - gc, h)
    h = np.where(maxc == g, 2.0 + rc - bc, h)
    h = np.where(maxc == b, 4.0 + gc - rc, h)
    h = (h / 6.0) % 1.0
    h = np.where(delta == 0, 0, h)
    return h, s, v


def hsv_to_rgb_arr(h, s, v):
    i = np.floor(h * 6.0)
    f = h * 6.0 - i
    p = v * (1.0 - s)
    q = v * (1.0 - f * s)
    t = v * (1.0 - (1.0 - f) * s)
    i = i.astype(int) % 6

    r = np.select(
        [i == 0, i == 1, i == 2, i == 3, i == 4, i == 5],
        [v, q, p, p, t, v],
    )
    g = np.select(
        [i == 0, i == 1, i == 2, i == 3, i == 4, i == 5],
        [t, v, v, q, p, p],
    )
    b = np.select(
        [i == 0, i == 1, i == 2, i == 3, i == 4, i == 5],
        [p, p, t, v, v, q],
    )
    rgb = np.stack([r, g, b], axis=-1)
    return np.clip(rgb * 255.0, 0, 255)


def recolor_preserve_v(rgb, target_h, target_s, s_scale=1.0, v_floor=0.62, v_gain=0.40):
    """換色但保留原本明暗分佈的『形狀』：v_floor 是最暗處會被抬升到的亮度，
    v_gain 是原始明暗變化保留的幅度。黑貓原本 V 值很低（接近黑），
    直接沿用會讓橘色變成深咖啡色，所以這裡把整個 V 值範圍往上平移。"""
    h, s, v = rgb_to_hsv_arr(rgb.astype(np.float64))
    new_h = np.full_like(h, target_h)
    new_s = np.clip(s * s_scale + target_s * (1 - s_scale), 0, 1)
    new_v = np.clip(v_floor + v_gain * v, 0, 1)
    return hsv_to_rgb_arr(new_h, new_s, new_v)


def whiten(rgb, amount):
    h, s, v = rgb_to_hsv_arr(rgb.astype(np.float64))
    new_s = s * (1 - amount)
    floor = 0.72
    new_v = np.clip(floor + (1 - floor) * v, 0, 1)
    return hsv_to_rgb_arr(h, new_s, new_v)


def add_tabby_stripes(rgb, mask, strength=0.28, period=46, angle_deg=12, offset=(0, 0)):
    h_arr, w_arr = mask.shape
    yy, xx = np.mgrid[0:h_arr, 0:w_arr]
    xx = xx + offset[0]
    yy = yy + offset[1]
    theta = np.deg2rad(angle_deg)
    proj = xx * np.cos(theta) + yy * np.sin(theta)
    # 加一點低頻擾動，讓條紋間距不要死板均勻（更像真實虎斑而非布紋）
    wobble = 6 * np.sin(2 * np.pi * (yy * np.cos(theta) - xx * np.sin(theta)) / (period * 3.7))
    wave = np.sin(2 * np.pi * (proj + wobble) / period)
    stripe = np.clip(wave, 0, None) ** 7  # 高次方 -> 窄帶暗紋，中間留大片底色空隙
    stripe = stripe * strength

    h_, s_, v_ = rgb_to_hsv_arr(rgb.astype(np.float64))
    new_v = np.clip(v_ * (1 - stripe), 0, 1)
    new_s = np.clip(s_ + stripe * 0.15, 0, 1)
    out = hsv_to_rgb_arr(h_, new_s, new_v)
    result = rgb.astype(np.float64).copy()
    result[mask] = out[mask]
    return result


def process_quadrant(name, quad_rgb, quad_alpha):
    h, w = quad_alpha.shape
    alpha_mask = quad_alpha > 0
    structure = ndimage.generate_binary_structure(2, 2)
    labels, n = ndimage.label(alpha_mask, structure=structure)
    hsv_h, hsv_s, hsv_v = rgb_to_hsv_arr(quad_rgb.astype(np.float64))

    out_rgb = quad_rgb.astype(np.float64).copy()

    hint_boxes = HINTS[name]

    def hint_role(cy, cx):
        for role, x0, y0, x1, y1 in hint_boxes:
            if x0 <= cx < x1 and y0 <= cy < y1:
                return role
        return None

    for lbl in range(1, n + 1):
        comp_mask = labels == lbl
        area = comp_mask.sum()
        if area < 8:
            continue
        ys, xs = np.where(comp_mask)
        cy, cx = ys.mean(), xs.mean()
        mean_h = hsv_h[comp_mask].mean()
        mean_s = hsv_s[comp_mask].mean()
        mean_v = hsv_v[comp_mask].mean()

        role = hint_role(cy, cx)
        if role is None:
            # fallback 啟發式分類
            if area < 4000 and 0.28 < mean_h < 0.45 and mean_s > 0.15:
                role = "EYE"
            elif mean_s < 0.12 and mean_v > 0.55:
                role = "KEEP"
            elif 0.9 < mean_h or mean_h < 0.06:
                if mean_s > 0.25:
                    role = "PINK_KEEP"
                else:
                    role = "FUR"
            else:
                role = "FUR"

        if role == "KEEP":
            continue
        elif role == "EYE":
            out_rgb[comp_mask] = recolor_preserve_v(
                quad_rgb, AMBER_H, AMBER_S, s_scale=0.25
            )[comp_mask]
        elif role == "PINK_KEEP":
            out_rgb[comp_mask] = recolor_preserve_v(
                quad_rgb, SALMON_H, SALMON_S, s_scale=0.4
            )[comp_mask]
        elif role == "NOSE":
            out_rgb[comp_mask] = recolor_preserve_v(
                quad_rgb, 6 / 360, 0.42, s_scale=0.08, v_floor=0.78, v_gain=0.22
            )[comp_mask]
        elif role == "EAR_INNER":
            out_rgb[comp_mask] = recolor_preserve_v(
                quad_rgb, EAR_INNER_H, EAR_INNER_S, s_scale=0.35, v_floor=0.68, v_gain=0.32
            )[comp_mask]
        elif role == "EAR_OUTER":
            base = recolor_preserve_v(quad_rgb, ORANGE_H, ORANGE_S, s_scale=0.15)
            out_rgb[comp_mask] = base[comp_mask]
        elif role == "CHIN_WHITE" or role == "PAW_WHITE":
            base = recolor_preserve_v(quad_rgb, ORANGE_H, ORANGE_S * 0.3, s_scale=0.15)
            base = whiten(base, amount=0.88)
            out_rgb[comp_mask] = base[comp_mask]
        elif role == "LEG_SOCK":
            base = recolor_preserve_v(quad_rgb, ORANGE_H, ORANGE_S, s_scale=0.2)
            base = add_tabby_stripes(
                base, comp_mask, strength=0.38, period=60, angle_deg=8,
                offset=QUAD_ORIGIN[name],
            )
            y0, y1 = ys.min(), ys.max()
            grad = np.zeros((h, w))
            span = max(y1 - y0, 1)
            grad_col = np.clip(((np.arange(h) - y0) / span - 0.55) / 0.45, 0, 1) ** 1.4
            grad[:, :] = grad_col[:, None]
            grad = grad * comp_mask
            whitened = whiten(base, amount=0.85)
            blend = grad[..., None]
            out_rgb[comp_mask] = (
                base * (1 - blend) + whitened * blend
            )[comp_mask]
        elif role == "TAIL":
            base = recolor_preserve_v(quad_rgb, ORANGE_H, ORANGE_S, s_scale=0.2)
            out_rgb[comp_mask] = add_tabby_stripes(
                base, comp_mask, strength=0.42, period=95, angle_deg=90,
                offset=QUAD_ORIGIN[name],
            )[comp_mask]
        elif role == "FACE_FRONT":
            base = recolor_preserve_v(quad_rgb, ORANGE_H, ORANGE_S, s_scale=0.2)
            base = add_tabby_stripes(
                base, comp_mask, strength=0.36, period=72, angle_deg=25,
                offset=QUAD_ORIGIN[name],
            )
            x0, x1 = xs.min(), xs.max()
            cx_mid = (x0 + x1) / 2
            span = max((x1 - x0) / 2, 1)
            xx = np.arange(w)
            dist = np.abs(xx - cx_mid) / span
            band = np.clip(1 - dist / 0.28, 0, 1) ** 1.5
            y0, y1 = ys.min(), ys.max()
            yy = np.arange(h)
            ygrad = np.clip((yy - y0) / max(y1 - y0, 1), 0, 1)
            ygrad = 0.35 + 0.65 * ygrad
            blend2d = (band[None, :] * ygrad[:, None]) * comp_mask
            whitened = whiten(base, amount=0.8)
            blend = blend2d[..., None]
            out_rgb[comp_mask] = (base * (1 - blend) + whitened * blend)[comp_mask]
        else:  # FUR
            base = recolor_preserve_v(quad_rgb, ORANGE_H, ORANGE_S, s_scale=0.2)
            out_rgb[comp_mask] = add_tabby_stripes(
                base, comp_mask, strength=0.4, period=72, angle_deg=15,
                offset=QUAD_ORIGIN[name],
            )[comp_mask]

    return np.clip(out_rgb, 0, 255).astype(np.uint8)


def main():
    img = Image.open(SRC).convert("RGBA")
    arr = np.array(img)
    w, h = img.size
    qw = qh = QUAD_SIZE
    out = np.zeros_like(arr)

    quads = {
        "TL": (0, 0),
        "TR": (qw, 0),
        "BL": (0, qh),
        "BR": (qw, qh),
    }
    for name, (ox, oy) in quads.items():
        quad_rgb = arr[oy:oy + qh, ox:ox + qw, 0:3]
        quad_alpha = arr[oy:oy + qh, ox:ox + qw, 3]
        new_rgb = process_quadrant(name, quad_rgb, quad_alpha)
        out[oy:oy + qh, ox:ox + qw, 0:3] = new_rgb
        out[oy:oy + qh, ox:ox + qw, 3] = quad_alpha

    result = Image.fromarray(out, mode="RGBA")
    result.save(OUT)
    print(f"輸出: {OUT}  尺寸: {result.size}")


if __name__ == "__main__":
    main()
