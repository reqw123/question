#!/usr/bin/env bash
# launchers/rpi/安裝.sh
# ─────────────────────────────────────────────────────────────────────────────
# Raspberry Pi 一次性設定，對應 Windows 的 一鍵安裝.bat / launchers/setup.ps1。
# 這支只負責「多人搶答網頁遊戲」需要的東西，不碰 desktop-pet / host-app。
#
# 做的事：
#   1. 把 launchers/rpi/*.sh 設成可執行
#   2. 檢查 Node.js（沒有就印出安裝指令）
#   3. 檢查 Mosquitto 與 WebSocket 埠 9001（沒有就印出安裝／設定指令）
#   4. 在桌面與應用程式選單建立「多人搶答 - 網頁遊戲」圖示（雙擊即啟動）
#
# 不改動專案任何既有檔案。可重複執行。
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"
ROOT="$(rpi_root)"

echo "多人搶答系統 — Raspberry Pi 安裝"
echo "專案位置：$ROOT"
echo

# ── 1. 可執行權限 ───────────────────────────────────────────────────────────
chmod +x "$HERE"/*.sh
echo "[OK] launchers/rpi/*.sh 已設為可執行"

# ── 2. Node.js ──────────────────────────────────────────────────────────────
if command -v node >/dev/null 2>&1; then
  echo "[OK] Node.js $(node --version)"
else
  echo "[X] 找不到 Node.js —— 網頁遊戲的靜態伺服器（serve-lan.js）需要它。"
  echo "    安裝： sudo apt install -y nodejs"
fi

# ── 3. Mosquitto ────────────────────────────────────────────────────────────
if command -v mosquitto >/dev/null 2>&1; then
  echo "[OK] 已安裝 mosquitto"
  if rpi_port_open 127.0.0.1 9001; then
    echo "[OK] MQTT WebSocket 埠 9001 有回應"
  else
    echo "[!] mosquitto 已安裝，但埠 9001 沒回應 —— 需要啟用 WebSocket listener："
    echo "      sudo cp \"$HERE/mosquitto-quiz.conf\" /etc/mosquitto/conf.d/quiz.conf"
    echo "      sudo systemctl enable --now mosquitto"
    echo "      sudo systemctl restart mosquitto"
  fi
else
  echo "[X] 找不到 mosquitto —— 多人連線的核心。安裝＋設定："
  echo "      sudo apt install -y mosquitto"
  echo "      sudo cp \"$HERE/mosquitto-quiz.conf\" /etc/mosquitto/conf.d/quiz.conf"
  echo "      sudo systemctl enable --now mosquitto"
fi
echo

# ── 4. 桌面圖示 ─────────────────────────────────────────────────────────────
DESKTOP_DIR="$( { command -v xdg-user-dir >/dev/null 2>&1 && xdg-user-dir DESKTOP; } || echo "$HOME/Desktop" )"
mkdir -p "$DESKTOP_DIR"

LAUNCHER="$HERE/啟動-網頁遊戲.sh"
ICON="$ROOT/multi/default_avatar.png"
[ -f "$ICON" ] || ICON="utilities-terminal"

write_desktop_entry() {
  local target="$1"
  cat > "$target" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=多人搶答 - 網頁遊戲
Name[en]=Quiz - Web Game
Comment=檢查 MQTT broker、啟動區網靜態伺服器、開啟主持人畫面
Exec=bash "$LAUNCHER"
Path=$ROOT
Terminal=true
Icon=$ICON
Categories=Game;Network;
EOF
  chmod +x "$target"
}

DESKTOP_FILE="$DESKTOP_DIR/多人搶答 - 網頁遊戲.desktop"
write_desktop_entry "$DESKTOP_FILE"
# 讓檔案管理員信任這個 .desktop（各桌面環境機制不同，失敗不影響功能）
gio set "$DESKTOP_FILE" metadata::trusted true 2>/dev/null || true
echo "[OK] 桌面圖示： $DESKTOP_FILE"

APPS_DIR="$HOME/.local/share/applications"
mkdir -p "$APPS_DIR"
write_desktop_entry "$APPS_DIR/quiz-multi-web.desktop"
update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
echo "[OK] 應用程式選單： $APPS_DIR/quiz-multi-web.desktop"
echo

echo "============================================================"
echo "安裝完成。"
echo
echo "啟動方式（擇一）："
echo "  · 雙擊桌面的「多人搶答 - 網頁遊戲」圖示"
echo "  · 應用程式選單 → 遊戲 → 多人搶答 - 網頁遊戲"
echo "  · 終端機： bash \"$LAUNCHER\""
echo
echo "第一次雙擊桌面圖示若被詢問，選「信任並啟動 / Trust and Launch」。"
echo "============================================================"
