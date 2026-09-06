#!/usr/bin/env bash
# launchers/rpi/還原線上.sh  ——  撤銷 離線化.sh 對 multi/host.html、multi/player.html 的改動。
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$HERE/lib.sh"
ROOT="$(rpi_root)"

if git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  git -C "$ROOT" checkout -- multi/host.html multi/player.html
  echo "[OK] 已用 git 還原 multi/host.html、multi/player.html。"
else
  sed -i \
    -e 's#\.\./lib/vendor/qrcode\.min\.js#https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js#g' \
    -e 's#\.\./lib/vendor/mqtt\.min\.js#https://unpkg.com/mqtt/dist/mqtt.min.js#g' \
    "$ROOT/multi/host.html" "$ROOT/multi/player.html"
  echo "[OK] 已用 sed 還原（非 git 環境）。"
fi
