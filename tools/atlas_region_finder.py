#!/usr/bin/env python3
"""
atlas_region_finder.py — 用連通區塊分析（connected-component）找出 Texture Atlas 裡
實際獨立的貼圖「島」，比單純用肉眼看整張圖準確很多。

原理：
    Live2D 的 Atlas 是把每個部件的貼圖各自「打包」進同一張圖，部件跟部件之間
    通常會留一圈透明像素當間隔（不然貼圖邊緣會互相滲色）。所以只要找出
    Alpha 色版裡「彼此不相連的不透明色塊」，每一塊幾乎都對應恰好一個
    Drawable（或是同一個 Part 底下緊貼在一起的幾個 Drawable）。

    這比「打開整張圖用肉眼猜哪塊是耳朵、哪塊是尾巴」準確非常多，因為
    這裡是先用程式切開，再一塊一塊單獨看小圖辨認，不會被旁邊不相干的
    色塊干擾判斷。

前置需求（已自動處理，不用手動分兩步）：
    這支工具是拿 Alpha 色版（alpha > 0）當遮罩去切連通區塊，所以圖片本身
    要先有正確的透明背景才有意義——如果貼圖還是純 RGB（沒有 Alpha 通道）
    或四個角落根本不是透明的，代表背景還沒挖透明。這種情況本腳本會自動
    呼叫 fix_texture_alpha.py 的同一套邏輯先把背景透明化，再繼續往下做
    連通區塊分析，不需要每次都先手動跑一次 fix_texture_alpha.py。

輸出：
    在 model_dir 底下建立 region_previews/，把每個連通區塊各自裁切存成一張
    PNG（檔名用「區塊_編號_面積NNN.png」，面積越大代表這塊區域在畫面上
    通常越重要），並印出一份依面積排序的清單。

用法：
    python tools/atlas_region_finder.py <texture_png_path> <輸出資料夾>

範例：
    python tools/atlas_region_finder.py \
        live2d_my_like/models/girl120_test/textures/texture_00.png \
        live2d_my_like/models/girl120_test/region_previews
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fix_texture_alpha import fix_alpha  # noqa: E402  （前置需求：背景透明化，見上方說明）


def _ensure_alpha(png_path: Path) -> None:
    """圖片還沒有透明背景就先補上，補完直接覆寫原檔（fix_alpha 內部會先備份）。"""
    img = Image.open(png_path)
    needs_fix = img.mode != "RGBA"
    if not needs_fix:
        px = img.load()
        w, h = img.size
        corners_alpha = [px[0, 0][3], px[w - 1, 0][3], px[0, h - 1][3], px[w - 1, h - 1][3]]
        needs_fix = not all(a == 0 for a in corners_alpha)
    if needs_fix:
        print(f"[前置處理] {png_path} 背景還沒透明化，先自動處理...")
        changed, _ = fix_alpha(str(png_path))
        if not changed:
            print(f"[警告] {png_path} 背景透明化失敗（可能四個角落顏色不一致），"
                  f"連通區塊分析可能不準確，仍繼續嘗試。")


def find_regions(png_path: Path, out_dir: Path, min_area: int = 80, padding: int = 4) -> None:
    """
    讀取 png_path，依 Alpha 色版做連通區塊分析，把每個區塊裁切存檔到 out_dir。

    min_area  過濾雜訊用——面積小於這個像素數的區塊（例如反鋸齒殘留的單一像素）不輸出。
    padding   裁切時每邊多留幾像素，方便肉眼看清楚邊界，不影響分析結果本身。
    """
    _ensure_alpha(png_path)

    img = Image.open(png_path).convert("RGBA")
    arr = np.array(img)
    alpha = arr[:, :, 3]

    # 8-連通（含對角）比 4-連通更不容易把同一個部件因為斜角相連而誤判成兩塊
    structure = np.ones((3, 3), dtype=int)
    mask = alpha > 0
    labeled, num_features = ndimage.label(mask, structure=structure)

    print(f"讀取: {png_path}  尺寸: {img.width}x{img.height}")
    print(f"找到 {num_features} 個獨立連通區塊（min_area={min_area} 以下視為雜訊已過濾）")

    out_dir.mkdir(parents=True, exist_ok=True)

    regions = []
    for label_id in range(1, num_features + 1):
        ys, xs = np.where(labeled == label_id)
        area = len(xs)
        if area < min_area:
            continue
        x0, x1 = int(xs.min()), int(xs.max())
        y0, y1 = int(ys.min()), int(ys.max())
        regions.append((area, x0, y0, x1, y1))

    # 面積由大到小排序——通常面積越大的區塊（身體、頭髮）視覺上越重要，優先看
    regions.sort(key=lambda r: -r[0])

    summary_lines = ["# Atlas 連通區塊清單（依面積排序）", ""]
    summary_lines.append("| # | 面積(px) | 寬x高 | 座標(x0,y0)-(x1,y1) | 裁切檔案 |")
    summary_lines.append("|---|---|---|---|---|")

    for i, (area, x0, y0, x1, y1) in enumerate(regions):
        px0, py0 = max(0, x0 - padding), max(0, y0 - padding)
        px1, py1 = min(img.width, x1 + padding + 1), min(img.height, y1 + padding + 1)
        crop = img.crop((px0, py0, px1, py1))
        w, h = x1 - x0 + 1, y1 - y0 + 1
        fname = f"區塊_{i:02d}_面積{area}.png"
        crop.save(out_dir / fname)
        summary_lines.append(f"| {i} | {area} | {w}x{h} | ({x0},{y0})-({x1},{y1}) | {fname} |")
        print(f"  [{i:2d}] area={area:6d}  size={w}x{h}  bbox=({x0},{y0})-({x1},{y1})  -> {fname}")

    (out_dir / "REGIONS.md").write_text("\n".join(summary_lines), encoding="utf-8")
    print(f"\n已輸出 {len(regions)} 個區塊到 {out_dir}，清單見 {out_dir / 'REGIONS.md'}")


def main() -> None:
    if len(sys.argv) != 3:
        print("用法: python tools/atlas_region_finder.py <texture_png_path> <輸出資料夾>")
        sys.exit(1)
    find_regions(Path(sys.argv[1]), Path(sys.argv[2]))


if __name__ == "__main__":
    main()
