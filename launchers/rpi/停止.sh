#!/usr/bin/env bash
# launchers/rpi/停止.sh —— 停掉 launchers/serve-lan.js 起的靜態伺服器。
# （若伺服器是從「啟動-網頁遊戲.sh」的終端機視窗開的，直接關那個視窗即可，
#   這支是給「視窗不小心關了、但 node 還在背景」的情況收尾用。）
set -uo pipefail

if pkill -f "serve-lan\.js"; then
  echo "已停止 serve-lan.js。"
else
  echo "沒有找到執行中的 serve-lan.js。"
fi
