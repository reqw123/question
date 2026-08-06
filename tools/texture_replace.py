#!/usr/bin/env python3
"""
texture_replace.py — Live2D 材質置換工具（為 girl120_test 換皮流程設計，其他模型也能用）

用途：
    讀取 model3.json 找出所有 texture、備份、驗證新貼圖是否符合原規格
    （解析度、透明背景），並在確認通過後才真正寫入置換。

安全設計（呼應「不能修改任何原始檔案／不能改變 UV 座標」的要求）：
    1. 只在傳入的 model_dir 裡操作，絕不假設或去動別的資料夾。
    2. backup 動作只新增備份檔，不會刪除或覆蓋任何既有檔案。
    3. replace 動作寫入前一定先驗證新貼圖的解析度／Alpha 色版跟原圖完全一致，
       任何不符就直接拒絕——UV 座標是綁在「這張圖的像素尺寸」上的，
       解析度一旦跑掉，貼圖跟 Mesh 的對應關係就全部跑掉。
    4. 沒有 --apply 旗標時，replace 只做驗證＋印出「將會做什麼」，不寫入任何檔案。
    5. 真的執行置換（--apply）之前，一定會先確保原始 texture 已經有備份。

用法：
    python tools/texture_replace.py analyze <model_dir>
    python tools/texture_replace.py backup  <model_dir>
    python tools/texture_replace.py replace <model_dir> <texture_index> <new_png_path> [--apply]

範例：
    python tools/texture_replace.py analyze live2d_my_like/models/girl120_test
    python tools/texture_replace.py backup  live2d_my_like/models/girl120_test
    python tools/texture_replace.py replace live2d_my_like/models/girl120_test 0 new_texture.png
    python tools/texture_replace.py replace live2d_my_like/models/girl120_test 0 new_texture.png --apply
"""

import argparse
import json
import shutil
import sys
from pathlib import Path

# Windows 主控台預設編碼常常不是 UTF-8（例如繁中 Big5 950），會把腳本裡的中文註解/訊息印成亂碼；
# 強制 stdout/stderr 用 UTF-8，不管在哪種終端機執行都印得出正確的中文。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

try:
    from PIL import Image
except ImportError:
    Image = None  # analyze/replace 的驗證步驟會在缺少 Pillow 時明確報錯，不會靜默略過


def load_model3_json(model_dir: Path) -> tuple[Path, dict]:
    """在 model_dir 底下找唯一一個 *.model3.json，讀取並回傳 (路徑, 內容字典)。"""
    candidates = list(model_dir.glob("*.model3.json"))
    if not candidates:
        raise FileNotFoundError(f"{model_dir} 底下找不到 *.model3.json")
    if len(candidates) > 1:
        raise RuntimeError(f"{model_dir} 底下有多個 *.model3.json，無法自動判斷要用哪一個：{candidates}")
    path = candidates[0]
    with open(path, "r", encoding="utf-8") as f:
        return path, json.load(f)


def list_textures(model_dir: Path) -> list[Path]:
    """回傳 model3.json 裡列出的所有 texture 絕對路徑，順序就是 model3.json 裡的順序（= texture index）。"""
    _, data = load_model3_json(model_dir)
    tex_list = data.get("FileReferences", {}).get("Textures", [])
    return [model_dir / rel for rel in tex_list]


def analyze(model_dir: Path) -> None:
    """列出這個模型的 texture 清單跟每張圖的基本規格。純讀取，不修改任何東西。"""
    model3_path, data = load_model3_json(model_dir)
    textures = list_textures(model_dir)
    refs = data.get("FileReferences", {})

    print(f"model3.json : {model3_path}")
    print(f"Moc         : {refs.get('Moc')}")
    print(f"Physics     : {refs.get('Physics')}")
    print(f"Texture 數量 : {len(textures)}")
    for i, tex in enumerate(textures):
        if not tex.exists():
            print(f"  [{i}] {tex}  ⚠️ 檔案不存在")
            continue
        if Image is None:
            print(f"  [{i}] {tex}  （未安裝 Pillow，無法讀取解析度／色彩模式；pip install pillow）")
            continue
        with Image.open(tex) as im:
            has_alpha = "A" in im.mode
            print(f"  [{i}] {tex}")
            print(f"       解析度={im.width}x{im.height}  色彩模式={im.mode}  含透明背景={'是' if has_alpha else '否 ⚠️'}")


def backup_textures(model_dir: Path) -> None:
    """把目前所有 texture 複製一份到 model_dir/textures_backup/。可重複執行——已存在的備份不會被覆蓋。"""
    textures = list_textures(model_dir)
    backup_dir = model_dir / "textures_backup"
    backup_dir.mkdir(exist_ok=True)
    for tex in textures:
        if not tex.exists():
            print(f"⚠️ 跳過（來源不存在）: {tex}")
            continue
        dest = backup_dir / tex.name
        if dest.exists():
            print(f"已存在備份，略過：{dest}")
            continue
        shutil.copy2(tex, dest)
        print(f"已備份：{tex} -> {dest}")


def _validate_new_texture(original: Path, new: Path) -> list[str]:
    """檢查新貼圖是否符合「原解析度／原透明背景」的硬性要求。回傳錯誤訊息清單，空清單代表通過。"""
    errors: list[str] = []
    if Image is None:
        errors.append("未安裝 Pillow（pip install pillow），無法驗證，一律視為不通過")
        return errors
    if not original.exists():
        errors.append(f"原始貼圖不存在，無法比對規格：{original}")
        return errors
    if not new.exists():
        errors.append(f"新貼圖檔案不存在：{new}")
        return errors
    with Image.open(original) as orig_im, Image.open(new) as new_im:
        if orig_im.size != new_im.size:
            errors.append(
                f"解析度不符：原本 {orig_im.size[0]}x{orig_im.size[1]} vs 新圖 "
                f"{new_im.size[0]}x{new_im.size[1]}（必須完全一致，否則 UV 座標會對不上）"
            )
        if "A" not in new_im.mode:
            errors.append(f"新圖沒有 Alpha 透明色版（色彩模式={new_im.mode}），必須是含透明背景的格式（RGBA）")
    return errors


def replace_texture(model_dir: Path, index: int, new_png: Path, apply: bool) -> None:
    """
    置換第 index 張 texture。

    預設是 dry-run：只驗證新圖規格＋印出「將會做什麼」，不動任何檔案。
    只有明確帶 --apply 才會真的寫入，而且寫入前一定會先確保原始檔案已備份。
    """
    textures = list_textures(model_dir)
    if index < 0 or index >= len(textures):
        raise IndexError(f"texture index {index} 超出範圍（這個模型只有 {len(textures)} 張 texture）")
    original = textures[index]

    errors = _validate_new_texture(original, new_png)
    if errors:
        print("❌ 驗證失敗，不會進行置換：")
        for e in errors:
            print(f"   - {e}")
        sys.exit(1)

    print(f"✅ 驗證通過：{new_png} 可以安全置換 {original}（解析度／透明背景都符合原規格）")

    if not apply:
        print("（dry-run：沒有帶 --apply，不會寫入任何檔案）")
        print("若確定要套用，重新執行時加上 --apply：")
        print(f"  python {Path(__file__).name} replace {model_dir} {index} {new_png} --apply")
        return

    # 真的要寫入前，強制先確保這張原始 texture 已經有備份——備份永遠優先於覆蓋
    backup_dir = model_dir / "textures_backup"
    backup_dir.mkdir(exist_ok=True)
    backup_dest = backup_dir / original.name
    if not backup_dest.exists():
        shutil.copy2(original, backup_dest)
        print(f"（尚未有備份，已先自動備份：{backup_dest}）")

    shutil.copy2(new_png, original)
    print(f"✅ 已置換：{original}（檔名／路徑不變，只換了像素內容）")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Live2D 材質置換工具（保留 Rig/Mesh/Motion/Physics/Parameter，只換 texture 像素內容）"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_analyze = sub.add_parser("analyze", help="列出這個模型的 texture 清單與規格，不修改任何東西")
    p_analyze.add_argument("model_dir", type=Path)

    p_backup = sub.add_parser("backup", help="備份目前所有 texture 到 model_dir/textures_backup/")
    p_backup.add_argument("model_dir", type=Path)

    p_replace = sub.add_parser("replace", help="驗證並置換一張 texture（預設 dry-run，需要 --apply 才會真的寫入）")
    p_replace.add_argument("model_dir", type=Path)
    p_replace.add_argument("texture_index", type=int, help="要換第幾張 texture（0 起算，對應 model3.json 的 Textures 清單順序）")
    p_replace.add_argument("new_png", type=Path, help="要換上去的新 PNG 檔路徑")
    p_replace.add_argument("--apply", action="store_true", help="真的寫入置換；不帶這個旗標只會驗證＋印出計畫")

    args = parser.parse_args()

    if args.command == "analyze":
        analyze(args.model_dir)
    elif args.command == "backup":
        backup_textures(args.model_dir)
    elif args.command == "replace":
        replace_texture(args.model_dir, args.texture_index, args.new_png, args.apply)


if __name__ == "__main__":
    main()
