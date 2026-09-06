#!/usr/bin/env bash
# launchers/rpi/啟動-網頁遊戲.sh
# ─────────────────────────────────────────────────────────────────────────────
# Raspberry Pi 上「一鍵開多人搶答網頁遊戲」，對應 Windows 的
# launchers/啟動-網頁遊戲.bat。做的事：
#   1. 確認 Node.js 在
#   2. 確認 MQTT broker 的 WebSocket 埠（9001）有回應（沒有只警告，不擋）
#   3. 用專案內建、零套件相依的 launchers/serve-lan.js 把整個專案目錄
#      服務在 http://<區網IP>:8080/
#   4. 自動開瀏覽器到主持人畫面 http://<區網IP>:8080/multi/host.html
#      （刻意用區網 IP 而不是 localhost：host.html 會用 location.hostname
#       自動推導 MQTT broker 位址與玩家加入網址，用 IP 開玩家 QR 才會正確）
#      要開哪一頁、用哪個瀏覽器、要不要開，都可用下面的環境變數自訂
#   5. 保持前景；關閉這個終端機視窗或按 Ctrl+C 即停止伺服器
#
# 環境變數（選用）：
#   PORT=8080        靜態伺服器埠
#   KIOSK=1          Chromium 用全螢幕 kiosk 模式開（適合 Pi 當專用主持機）
#   PAGE=host        自動開哪一頁：host（預設）｜ player ｜ none（不開瀏覽器）
#   URL=<完整網址>   直接指定要開的網址，蓋過 PAGE（例如接大螢幕投影的專用頁）
#   BROWSER=chromium 指定用哪個瀏覽器指令（預設自動偵測 chromium → firefox）
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"
ROOT="$(rpi_root)"
cd "$ROOT"

PORT="${PORT:-8080}"
WS_PORT=9001
KIOSK="${KIOSK:-0}"
PAGE="${PAGE:-host}"
LAN_IP="$(rpi_lan_ip)"

echo "============================================================"
echo "  多人搶答系統 — 網頁遊戲（Raspberry Pi）"
echo "  專案位置 : $ROOT"
echo "  區網 IP  : $LAN_IP"
echo "============================================================"
echo

# ── 1. Node.js ──────────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  echo "[錯誤] 找不到 Node.js。請先安裝："
  echo "        sudo apt install -y nodejs"
  read -rp "按 Enter 關閉..." _
  exit 1
fi
echo "[OK] Node.js $(node --version)"

# ── 2. MQTT broker（WebSocket 9001）─────────────────────────────────────────
if rpi_port_open 127.0.0.1 "$WS_PORT"; then
  echo "[OK] 偵測到 MQTT broker WebSocket 埠 $WS_PORT"
else
  echo "[!] 127.0.0.1:$WS_PORT 沒有回應 —— Mosquitto 可能沒啟動，或沒開 WebSocket listener。"
  echo "    設定方式（見 launchers/rpi/mosquitto-quiz.conf）："
  echo "      sudo cp \"$HERE/mosquitto-quiz.conf\" /etc/mosquitto/conf.d/quiz.conf"
  echo "      sudo systemctl restart mosquitto"
  echo "    （沒有 broker 遊戲無法連線，但還是先把網站開起來讓你檢查畫面）"
fi
echo

# ── 3. 靜態伺服器 ───────────────────────────────────────────────────────────
SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    echo
    echo "已停止靜態伺服器（PID $SERVER_PID）。"
  fi
}
trap cleanup EXIT INT TERM

if rpi_port_open 127.0.0.1 "$PORT"; then
  echo "[OK] 埠 $PORT 已經有伺服器在跑，沿用它。"
else
  echo "[..] 啟動 launchers/serve-lan.js（埠 $PORT）..."
  PORT="$PORT" node "$ROOT/launchers/serve-lan.js" &
  SERVER_PID=$!
  for _ in $(seq 1 24); do
    if rpi_port_open 127.0.0.1 "$PORT"; then break; fi
    sleep 0.25
  done
  if rpi_port_open 127.0.0.1 "$PORT"; then
    echo "[OK] 伺服器就緒（PID $SERVER_PID）"
  else
    echo "[錯誤] 伺服器沒有在預期時間內起來，請看上面有沒有錯誤訊息。"
    read -rp "按 Enter 關閉..." _
    exit 1
  fi
fi
echo

HOST_URL="http://$LAN_IP:$PORT/multi/host.html"
PLAYER_URL="http://$LAN_IP:$PORT/multi/player.html"
echo "  主持人畫面 : $HOST_URL"
echo "  玩家畫面   : $PLAYER_URL"
echo "               （玩家通常直接掃主持畫面上的 QR，不用手動輸入）"
echo

# ── 4. 開瀏覽器 ─────────────────────────────────────────────────────────────
# 要開哪個網址：URL 直接指定 > PAGE 選 host/player > 預設 host。PAGE=none 就不開。
OPEN_URL=""
case "${URL:-}" in
  "") case "$PAGE" in
        host)   OPEN_URL="$HOST_URL" ;;
        player) OPEN_URL="$PLAYER_URL" ;;
        none)   OPEN_URL="" ;;
        *)      echo "[!] PAGE=$PAGE 無法辨識，改用 host。"; OPEN_URL="$HOST_URL" ;;
      esac ;;
  *)  OPEN_URL="$URL" ;;
esac

if [ -z "$OPEN_URL" ]; then
  echo "[i] PAGE=none，不自動開瀏覽器。請自行開啟上面的網址。"
else
  # 瀏覽器指令：BROWSER 環境變數優先，否則自動偵測
  BROWSER_CMD="${BROWSER:-}"
  if [ -z "$BROWSER_CMD" ]; then
    for b in chromium-browser chromium firefox-esr firefox; do
      if command -v "$b" >/dev/null 2>&1; then BROWSER_CMD="$b"; break; fi
    done
  fi

  if [ -n "$BROWSER_CMD" ] && command -v "$BROWSER_CMD" >/dev/null 2>&1; then
    BROWSER_ARGS=(--new-window)
    if [ "$KIOSK" = "1" ]; then BROWSER_ARGS=(--kiosk --start-fullscreen); fi
    echo "[..] 用 $BROWSER_CMD 開啟： $OPEN_URL"
    "$BROWSER_CMD" "${BROWSER_ARGS[@]}" "$OPEN_URL" >/dev/null 2>&1 &
  elif command -v xdg-open >/dev/null 2>&1; then
    echo "[..] 用系統預設瀏覽器開啟： $OPEN_URL"
    xdg-open "$OPEN_URL" >/dev/null 2>&1 &
  else
    echo "[!] 找不到瀏覽器，請自己打開： $OPEN_URL"
  fi
fi
echo

# ── 5. 前景等待 ─────────────────────────────────────────────────────────────
if [ -n "$SERVER_PID" ]; then
  echo "伺服器執行中。關閉這個視窗、或按 Ctrl+C 即停止。"
  wait "$SERVER_PID"
else
  echo "（伺服器不是這個視窗啟動的，這個視窗可以直接關閉，遊戲不受影響。）"
  read -rp "按 Enter 關閉..." _
fi
