#!/usr/bin/env bash
# launchers/rpi/離線化.sh  ——  選用，只有在「玩家裝置也連不到網際網路」時才需要。
# ─────────────────────────────────────────────────────────────────────────────
# multi/host.html 會從 cdnjs 載 qrcode.min.js，host.html 與 player.html 會從
# unpkg 載 mqtt.min.js。玩家裝置只要有網路、載過一次就會被瀏覽器快取，通常不用管。
# 但如果是完全封閉、對外沒有網路的場地，這兩個外部檔案抓不到 → QR 出不來、
# MQTT 連不上。這支腳本把那兩個檔抓到 lib/vendor/，並改寫那 3 行 <script>。
#
# ⚠ 這會修改兩個受版本控制的既有檔案（multi/host.html、multi/player.html）。
#   要復原： bash launchers/rpi/還原線上.sh
#   執行前 Pi 本身必須還有網路（用來下載那兩個檔）。
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"
ROOT="$(rpi_root)"
VENDOR="$ROOT/lib/vendor"
mkdir -p "$VENDOR"

echo "[..] 下載 qrcode.min.js（cdnjs, qrcodejs 1.0.0）..."
curl -fsSL "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js" -o "$VENDOR/qrcode.min.js"

echo "[..] 下載 mqtt.min.js（unpkg, mqtt 最新瀏覽器版）..."
curl -fsSL "https://unpkg.com/mqtt/dist/mqtt.min.js" -o "$VENDOR/mqtt.min.js"

echo "[..] 改寫 multi/host.html、multi/player.html 的 <script> 來源為本地路徑..."
sed -i \
  -e 's#https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js#../lib/vendor/qrcode.min.js#g' \
  -e 's#https://unpkg.com/mqtt/dist/mqtt.min.js#../lib/vendor/mqtt.min.js#g' \
  "$ROOT/multi/host.html"
sed -i \
  -e 's#https://unpkg.com/mqtt/dist/mqtt.min.js#../lib/vendor/mqtt.min.js#g' \
  "$ROOT/multi/player.html"

echo
echo "[OK] 離線化完成。lib/vendor/ 下已有 qrcode.min.js 與 mqtt.min.js。"
echo "     復原成線上版： bash \"$HERE/還原線上.sh\""
