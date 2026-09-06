# launchers/rpi —— 在 Raspberry Pi 上跑「多人搶答網頁遊戲」

Windows 版的啟動流程在 `launchers/`（`.bat` + `setup.ps1`）。這個資料夾是 **Raspberry Pi 專用**
的對應版本，目標是：**整個專案原封不動 clone 到 Pi，再雙擊一個桌面圖示就能開場**。

只涵蓋 `multi/`（多人搶答系統）。`desktop-pet/`、`host-app/`、`single/` 不在範圍內。

---

## 這個資料夾裝了什麼

| 檔案 | 作用 | 對應 Windows |
|---|---|---|
| `安裝.sh` | 一次性設定：檢查相依、建立桌面圖示 | `一鍵安裝.bat` / `setup.ps1` |
| `啟動-網頁遊戲.sh` | 每次開場：起靜態伺服器、開主持人畫面瀏覽器 | `啟動-網頁遊戲.bat` |
| `停止.sh` | 收尾：停掉背景的靜態伺服器 | 關掉 cmd 視窗 |
| `mosquitto-quiz.conf` | Mosquitto 的 WebSocket listener 設定範例 | 見技術文件 |
| `lib.sh` | 共用 shell 函式（不可執行） | — |
| `離線化.sh` / `還原線上.sh` | 選用：把 2 個 CDN 檔案本地化（見下方「離線場地」） | — |

**不改動專案任何既有檔案**（`離線化.sh` 例外，且可完全復原）。

---

## 架構（跟 Windows 版一樣）

```
Raspberry Pi（接螢幕、桌面環境）
├── Mosquitto            :1883 原生 MQTT / :9001 MQTT over WebSocket
├── serve-lan.js (Node)  :8080 靜態檔案伺服器，把整個專案目錄服務出去
└── Chromium             開 http://<Pi 區網IP>:8080/multi/host.html  ← 主持人畫面

玩家手機 ── 掃主持畫面的 QR ──▶ http://<Pi 區網IP>:8080/multi/player.html
         ── MQTT/WebSocket ──▶ ws://<Pi 區網IP>:9001
```

Live2D / PIXI 全部在**玩家與主持人的瀏覽器**裡跑，跟 Pi 的效能無關。Pi 只當 broker + 檔案伺服器，
Pi 3 就夠；Pi 4 以上才建議讓 Pi 自己也開 `host.html` 當主持畫面。

---

## 安裝步驟

### 1. 前置（你需要自己先裝好）

```bash
sudo apt update
sudo apt install -y nodejs mosquitto xdg-utils
```

### 2. 設定 Mosquitto 的 WebSocket

```bash
cd /path/to/question          # 專案 clone 下來的位置
sudo cp launchers/rpi/mosquitto-quiz.conf /etc/mosquitto/conf.d/quiz.conf
sudo systemctl enable --now mosquitto
sudo systemctl restart mosquitto
ss -ltn | grep -E '1883|9001'   # 兩個埠都要有人在聽
```

### 3. 跑安裝腳本

```bash
bash launchers/rpi/安裝.sh
```

會檢查相依、在**桌面**與**應用程式選單**放一個「多人搶答 - 網頁遊戲」圖示。
（腳本可重複執行，不會壞。）

---

## 每次開場

**雙擊桌面的「多人搶答 - 網頁遊戲」圖示。** 第一次會問要不要信任，選「信任並啟動 / Trust and Launch」。

會開一個終端機視窗（顯示狀態）+ 一個 Chromium 視窗（主持人畫面）。
**關掉那個終端機視窗 = 停止伺服器**，跟 Windows 版關 cmd 視窗一樣。

### 自動開哪一頁 / 用哪個瀏覽器 —— 都可自訂

預設會用偵測到的 Chromium／Firefox 開一個新視窗到**主持人畫面**（`multi/host.html`），
跟 Windows 版 `.bat` 的 `start "" "http://.../host.html"` 一樣。用環境變數改：

```bash
bash launchers/rpi/啟動-網頁遊戲.sh                    # 預設：開 host.html
KIOSK=1 bash launchers/rpi/啟動-網頁遊戲.sh            # Chromium 全螢幕 kiosk（Pi 當專用主持機）
PAGE=player bash launchers/rpi/啟動-網頁遊戲.sh        # 改開 player.html
PAGE=none bash launchers/rpi/啟動-網頁遊戲.sh          # 只起伺服器，不開瀏覽器
URL='http://192.168.1.50:8080/multi/host.html' bash launchers/rpi/啟動-網頁遊戲.sh  # 指定完整網址
BROWSER=firefox bash launchers/rpi/啟動-網頁遊戲.sh    # 指定瀏覽器指令
PORT=9090 bash launchers/rpi/啟動-網頁遊戲.sh          # 換靜態伺服器的埠
```

沒有偵測到瀏覽器時退回 `xdg-open`（系統預設瀏覽器）；再不行就只印出網址。

要讓桌面圖示帶固定選項（例如永遠 kiosk）：編輯 `安裝.sh` 產生的 `.desktop`，
把 `Exec=bash "…/啟動-網頁遊戲.sh"` 改成 `Exec=env KIOSK=1 bash "…/啟動-網頁遊戲.sh"`。

---

## 離線場地（選用）

`multi/host.html` 從 cdnjs 載 `qrcode.min.js`，`host.html` 與 `player.html` 從 unpkg 載 `mqtt.min.js`。
玩家裝置**只要有網路、載過一次就會被瀏覽器快取**，一般不用理。

只有在「玩家的手機也完全連不到網際網路」的封閉場地，才需要：

```bash
bash launchers/rpi/離線化.sh      # Pi 此時要有網路（用來下載那 2 個檔到 lib/vendor/）
# ...活動結束後想還原：
bash launchers/rpi/還原線上.sh
```

`離線化.sh` 會改寫 `multi/host.html`、`multi/player.html` 的 3 行 `<script src>`，這是唯一會動到既有檔案的地方，`還原線上.sh` 可完全復原。

---

## 疑難排解

| 症狀 | 原因 / 處理 |
|---|---|
| 玩家掃 QR 進去連不上、一直轉圈 | Mosquitto 沒開 9001。`ss -ltn \| grep 9001`，沒有就回去做「安裝步驟 2」 |
| 主持畫面 QR 指向 `localhost` | 沒用啟動腳本、自己開了 `http://localhost:8080/...`。改用 `http://<Pi區網IP>:8080/...`（啟動腳本會自動這樣開） |
| QR 圖沒出現 | 場地無網路且沒跑 `離線化.sh`（cdnjs 的 qrcode.min.js 抓不到） |
| 雙擊桌面圖示沒反應 | 檔案總管沒信任 `.desktop`：對圖示按右鍵 →「允許執行 / 信任」，或終端機直接跑 `啟動-網頁遊戲.sh` |
| `serve-lan.js` 說埠被佔用 | 已有一個在跑。`bash launchers/rpi/停止.sh` 後重試，或用 `PORT=` 換埠 |
| Pi 重開機後遊戲沒了 | 這套是「手動雙擊啟動」。要開機自動起，可把 `啟動-網頁遊戲.sh` 包成 systemd user service（本資料夾未附，需要再說） |
