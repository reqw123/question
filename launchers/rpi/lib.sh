# launchers/rpi/lib.sh — 共用函式，被同資料夾其他腳本 source。
# 本身不可執行，只提供 shell 函式。

# 專案根目錄：這支 lib.sh 在 launchers/rpi/，往上兩層就是專案根。
rpi_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd
}

# 取這台機器在區域網路上的第一個 IPv4（排除 127.x）。
# 掃不到就退回 127.0.0.1（純本機還是能開，只是別台裝置連不進來）。
rpi_lan_ip() {
  local ip
  ip="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' | grep -v '^127\.' | head -n1)"
  if [ -z "$ip" ]; then
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
  fi
  printf '%s\n' "${ip:-127.0.0.1}"
}

# rpi_port_open <host> <port> — TCP 埠有沒有人在聽。用 bash 內建 /dev/tcp，不需額外套件。
rpi_port_open() {
  timeout 1 bash -c ": < /dev/tcp/$1/$2" 2>/dev/null
}
