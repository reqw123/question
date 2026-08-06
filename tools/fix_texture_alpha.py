#!/usr/bin/env python3
"""
fix_texture_alpha.py — 幫沒有 Alpha 通道的 Live2D 貼圖補上透明背景

背景（為什麼需要這支腳本）：
    部分模型的 texture_01.png 是純 RGB，完全沒有 Alpha 通道（PNG mode='RGB'）。
    這種圖丟給 Cubism/pixi-live2d-display 渲染時，貼圖之間的留白區域不會真的
    透明，畫面上會看到色塊邊緣、白色/黑色描邊等問題。

    這支腳本只單純負責「背景透明化」這一步：判斷背景色、用連通區域填色
    （flood fill）把跟畫面外圍相連的背景整片挖成透明，不動任何角色素材
    本身的顏色。想找出「圖裡有哪些獨立部件、哪些多餘的殘留物要整塊去掉」，
    那是另一支工具 atlas_region_finder.py 的事（背景透明化之後才能跑，
    該腳本現在也會自動偵測、需要的話自動先呼叫這裡的邏輯，不用手動分兩步）。

原理：
    背景色通常集中在四個角落，先取樣確認四個角落顏色一致（不一致就代表
    這張圖背景不單純，直接中止、不亂猜），再從其中一個角落當種子點做
    flood fill——只有「跟角落連通、顏色跟背景在容許誤差內」的像素才會
    被挖透明。即使某個角色素材內部剛好也有接近背景色的像素（例如白色
    衣服、黑色瞳孔），只要沒有直接連到最外圍背景，就不會被誤刪。

用法：
    python tools/fix_texture_alpha.py <輸入圖路徑> [--output <輸出圖路徑>] [--tolerance 15]

    --output 省略：原地覆寫輸入檔，執行前自動備份成「<檔名>_backup_original.png」。
              適合處理專案裡既有、路徑固定的模型貼圖檔。
    --output 有指定：結果另外存成一個新檔案，完全不動輸入檔本身。
              適合處理 AI 生成圖——例如 nano banana／其他 AI 工具產出的圖通常
              沒有 alpha 通道，輸入圖給原始 AI 輸出檔，輸出圖指到要放進模型
              資料夾的最終檔名，兩份分開存、互不覆蓋。

範例：
    # 原地修正專案裡既有的貼圖（自動備份）
    python tools/fix_texture_alpha.py live2d_my_like/models/1064100/textures/texture_01.png

    # AI 生成圖：輸入是 AI 輸出的原圖，輸出另存到模型資料夾
    python tools/fix_texture_alpha.py _nano_banana_output/texture01_raw.png \
        --output live2d_my_like/models/1064100/textures/texture_01.png

安全設計：
    - 原地覆寫模式一定先把原檔備份成「<檔名>_backup_original.png」（已存在就不
      重複備份，避免第二次執行時把第一次的備份洗成已經改過的版本）。
    - 指定 --output 時輸入檔完全不會被動到，本身就是天然的備份。
    - 只處理「背景透明化」，不改變任何角色素材本身的顏色或形狀。
"""

import argparse
import os
import sys
from collections import deque

from PIL import Image

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def detect_background_color(px, w, h, tolerance=15):
    """
    取四個角落顏色，彼此都在容許誤差內才回傳（用第一個角落當基準比對，
    不要求逐位元組完全相等——壓縮雜訊常常讓背景色有 ±1、±2 的細微差異，
    嚴格比對反而會誤判成「角落不一致」）；差太多就回傳 None，代表沒辦法
    自動判斷背景色。
    """
    corners = [px[0, 0][:3], px[w - 1, 0][:3], px[0, h - 1][:3], px[w - 1, h - 1][:3]]
    base = corners[0]
    for c in corners[1:]:
        if any(abs(a - b) > tolerance for a, b in zip(c, base)):
            return None
    return base


def flood_fill_background(px, w, h, bg_color, tolerance, seed=(0, 0)):
    """從 seed 開始，抓出跟背景色連通（4-方向）的所有像素座標。"""
    def is_bg(r, g, b):
        return all(abs(c - t) <= tolerance for c, t in zip((r, g, b), bg_color))

    visited = set()
    q = deque([seed])
    pixels = []
    while q:
        x, y = q.popleft()
        if x < 0 or x >= w or y < 0 or y >= h or (x, y) in visited:
            continue
        r, g, b, a = px[x, y]
        if not is_bg(r, g, b):
            continue
        visited.add((x, y))
        pixels.append((x, y))
        q.append((x + 1, y))
        q.append((x - 1, y))
        q.append((x, y + 1))
        q.append((x, y - 1))
    return pixels


def fix_alpha(path, tolerance=15, quiet=False, output=None):
    """
    對單一貼圖檔案執行背景透明化。回傳 (是否有修改, 透明像素數)。

    output 省略時（預設）：原地覆寫 path，動手前自動備份成
        「<檔名>_backup_original.png」（已存在就不重複備份，避免第二次執行時
        把第一次的備份洗成已經改過的版本）——適合處理專案裡既有、路徑固定的
        模型貼圖檔。

    output 有指定時：結果寫到 output，完全不動 path 本身（path 自己就是
        原始備份，不用額外再存一份）——適合處理 AI 生成圖這種場景：輸入是
        AI 產出的原圖（例如 nano banana 輸出的 texture01.png），不想被就地
        覆寫，想另外存一份補好 alpha 的版本到指定的輸出路徑。
        已經有 alpha 通道的圖也會原樣複製一份到 output，確保呼叫端一定
        找得到輸出檔案。
    """
    img = Image.open(path).convert("RGBA")
    w, h = img.size
    px = img.load()

    corners_alpha = [px[0, 0][3], px[w - 1, 0][3], px[0, h - 1][3], px[w - 1, h - 1][3]]
    if all(a == 0 for a in corners_alpha):
        if not quiet:
            print(f"[略過] {path} 四個角落已經是透明的，看起來已經處理過了。")
        if output is not None:
            img.save(output)
            if not quiet:
                print(f"（原樣複製到 {output}）")
        return False, 0

    bg_color = detect_background_color(px, w, h, tolerance=tolerance)
    if bg_color is None:
        print(f"[中止] {path} 四個角落顏色不一致，無法自動判斷背景色，請手動處理。")
        return False, 0

    if output is None:
        backup_path = os.path.splitext(path)[0] + "_backup_original.png"
        if not os.path.exists(backup_path):
            Image.open(path).save(backup_path)
            if not quiet:
                print(f"已備份原始檔案到 {backup_path}")

    pixels = flood_fill_background(px, w, h, bg_color, tolerance)
    for x, y in pixels:
        r, g, b, a = px[x, y]
        px[x, y] = (r, g, b, 0)
    img.save(output if output is not None else path)

    if not quiet:
        print(f"完成：{output if output is not None else path}")
        print(f"  背景色: {bg_color}  容許誤差: ±{tolerance}")
        print(f"  透明化像素數: {len(pixels)} / {w * h} ({len(pixels) / (w * h) * 100:.1f}%)")
    return True, len(pixels)


def main():
    parser = argparse.ArgumentParser(description="幫沒有 Alpha 通道的貼圖補上透明背景")
    parser.add_argument("path", help="輸入圖片路徑（要處理的貼圖 PNG）")
    parser.add_argument("--output", help="輸出圖片路徑；省略則原地覆寫輸入檔（會自動備份原檔）")
    parser.add_argument("--tolerance", type=int, default=15, help="背景色容許誤差（預設 15）")
    args = parser.parse_args()

    if not os.path.exists(args.path):
        sys.exit(f"找不到檔案：{args.path}")

    fix_alpha(args.path, tolerance=args.tolerance, output=args.output)


if __name__ == "__main__":
    main()
