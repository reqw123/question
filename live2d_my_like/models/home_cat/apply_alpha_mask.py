"""
UV 安全網：把 AI 生成的貼圖強制套用「原始貼圖」的透明遮罩，
確保 Piece 邊界/大小/位置逐像素不變。支援兩種模式：

模式一（象限模式，原本的用法）：
    AI 生成圖被切成 4 塊象限分開生成，這支腳本負責拼回完整尺寸再套 Alpha。
    1. 把 nano banana 產出的 4 張圖放進 home_cat/_nano_banana_output/，
       檔名必須是：
         quadrant_TL_head_back.png
         quadrant_TR_face_tail.png
         quadrant_BL_muzzle_legs.png
         quadrant_BR_legs_ears_paws.png
    2. 在 home_cat 資料夾下執行：python apply_alpha_mask.py
    3. 產出的 kuroneko_00.png 會直接覆蓋 home_cat 裡目前的檔案
       （第一次執行時，會自動把「目前這份未修改的原始複製品」備份成
       kuroneko_00_original_backup.png，之後重跑腳本都以這份備份的
       Alpha 為準，不會累積誤差）。

模式二（單張整圖模式，--single，新增）：
    AI 一次生成一張完整貼圖（例如 texture01.png、texture02.png），
    不是切象限分開生成，也不一定是 2048×2048（例如 nano banana 常見輸出
    1024×1024）。這支腳本負責把原廠 kuroneko_00.png 的 Alpha 縮放到跟
    輸入圖一樣的尺寸，再套用上去。
        python apply_alpha_mask.py --single <輸入png> [--output <輸出png>] [--alpha-source <原廠png>]
    - --output 省略時直接覆蓋輸入檔本身，並自動把套用前的版本備份成
      「<輸入檔名>_noalpha_backup.png」。
    - --alpha-source 省略時預設用 home_cat 上層 kuroneko 資料夾裡的
      live2d_my_like/models/kuroneko/kuroneko_00.png（原廠、未經任何修改的版本）。

    範例：
        python apply_alpha_mask.py --single texture01.png
        python apply_alpha_mask.py --single texture02.png --output texture02_fixed.png
"""

import argparse
import os
import sys
import numpy as np
from PIL import Image

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

BASE = os.path.dirname(os.path.abspath(__file__))
FINAL = os.path.join(BASE, "kuroneko_00.png")
BACKUP = os.path.join(BASE, "kuroneko_00_original_backup.png")
OUTPUT_DIR = os.path.join(BASE, "_nano_banana_output")
DEFAULT_ALPHA_SOURCE = os.path.join(BASE, "..", "kuroneko", "kuroneko_00.png")

QUADRANTS = {
    "quadrant_TL_head_back.png": (0, 0),
    "quadrant_TR_face_tail.png": (1, 0),
    "quadrant_BL_muzzle_legs.png": (0, 1),
    "quadrant_BR_legs_ears_paws.png": (1, 1),
}


def run_quadrant_mode():
    if not os.path.exists(BACKUP):
        if not os.path.exists(FINAL):
            sys.exit(f"找不到原始檔案：{FINAL}")
        Image.open(FINAL).convert("RGBA").save(BACKUP)
        print(f"已備份未修改的原始貼圖到 {BACKUP}")

    original = Image.open(BACKUP).convert("RGBA")
    w, h = original.size
    qw, qh = w // 2, h // 2
    orig_arr = np.array(original)
    orig_alpha = orig_arr[:, :, 3]

    missing = [f for f in QUADRANTS if not os.path.exists(os.path.join(OUTPUT_DIR, f))]
    if missing:
        sys.exit(
            "缺少以下生成圖，請先放進 "
            + OUTPUT_DIR
            + "：\n"
            + "\n".join(missing)
        )

    canvas = np.zeros((h, w, 4), dtype=np.uint8)
    for fname, (gx, gy) in QUADRANTS.items():
        piece = Image.open(os.path.join(OUTPUT_DIR, fname)).convert("RGBA")
        if piece.size != (qw, qh):
            print(f"[警告] {fname} 尺寸是 {piece.size}，非預期的 {(qw, qh)}，自動縮放。")
            piece = piece.resize((qw, qh), Image.LANCZOS)
        arr = np.array(piece)
        y0, y1 = gy * qh, gy * qh + qh
        x0, x1 = gx * qw, gx * qw + qw
        canvas[y0:y1, x0:x1, 0:3] = arr[:, :, 0:3]

    # 強制套用原始 Alpha，逐像素蓋掉生成圖自己的透明通道
    canvas[:, :, 3] = orig_alpha

    result = Image.fromarray(canvas, mode="RGBA")
    result.save(FINAL)

    _report(orig_alpha, canvas[:, :, 3], FINAL, (w, h), result.size)


def run_single_mode(input_path, output_path, alpha_source_path):
    if not os.path.exists(input_path):
        sys.exit(f"找不到輸入檔案：{input_path}")
    if not os.path.exists(alpha_source_path):
        sys.exit(f"找不到 Alpha 來源檔案：{alpha_source_path}")

    target = Image.open(input_path).convert("RGB")
    w, h = target.size

    alpha_source = Image.open(alpha_source_path).convert("RGBA")
    orig_alpha_full = np.array(alpha_source)[:, :, 3]
    if alpha_source.size != (w, h):
        alpha = np.array(
            Image.fromarray(orig_alpha_full).resize((w, h), Image.LANCZOS)
        )
        print(f"Alpha 來源尺寸 {alpha_source.size} 跟輸入圖 {(w, h)} 不同，已自動縮放。")
    else:
        alpha = orig_alpha_full

    same_file = os.path.abspath(output_path) == os.path.abspath(input_path)
    if same_file:
        backup_path = os.path.splitext(input_path)[0] + "_noalpha_backup.png"
        if not os.path.exists(backup_path):
            Image.open(input_path).save(backup_path)
            print(f"已備份套用 Alpha 前的版本到 {backup_path}")

    out = np.dstack([np.array(target), alpha])
    result = Image.fromarray(out, mode="RGBA")
    result.save(output_path)

    _report(alpha, out[:, :, 3], output_path, (w, h), result.size)


def _report(orig_alpha, new_alpha, out_path, expected_size, actual_size):
    orig_opaque = int((orig_alpha > 0).sum())
    new_opaque = int((new_alpha > 0).sum())

    print(f"輸出完成: {out_path}")
    print(f"尺寸: {actual_size} (應為 {expected_size}: {actual_size == expected_size})")
    print(f"Alpha 來源不透明像素數: {orig_opaque}")
    print(f"輸出不透明像素數: {new_opaque} (應相同: {orig_opaque == new_opaque})")
    if orig_opaque != new_opaque:
        print("[錯誤] 不透明像素數不一致，理論上不該發生，請回報。")


def main():
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--single", metavar="輸入PNG", help="單張整圖模式：套用 Alpha 的目標檔案")
    parser.add_argument("--output", metavar="輸出PNG", help="單張模式專用，省略則覆蓋輸入檔本身")
    parser.add_argument(
        "--alpha-source",
        metavar="原廠PNG",
        default=DEFAULT_ALPHA_SOURCE,
        help="單張模式專用，Alpha 遮罩來源，預設是原廠 kuroneko_00.png",
    )
    args = parser.parse_args()

    if args.single:
        input_path = args.single if os.path.isabs(args.single) else os.path.join(BASE, args.single)
        output_path = args.output or input_path
        if output_path and not os.path.isabs(output_path):
            output_path = os.path.join(BASE, output_path)
        run_single_mode(input_path, output_path, args.alpha_source)
    else:
        run_quadrant_mode()


if __name__ == "__main__":
    main()
