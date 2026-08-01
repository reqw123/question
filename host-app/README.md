# host-app

多人搶答「主持人畫面」的桌面殼層（Electron）。獨立模組，**不修改**專案任何既有檔案 —— 只是用一個桌面視窗載入現有的 `http://127.0.0.1:5500/multi/host.html`（VS Code Live Server），跟平常用瀏覽器開一模一樣（同一份頁面、同源、同樣的 MQTT broker IP 自動偵測邏輯）。

## 前置需求

跟平常用瀏覽器開 `host.html` 的前置需求完全相同：

1. VS Code 開啟 `multi/host.html`，按右下角「Go Live」（或右鍵「Open with Live Server」），確認網址是 `http://127.0.0.1:5500/multi/host.html`
2. 確認 MQTT broker 已啟動（Node-RED / Mosquitto 等）

> 若你的 Live Server port 不是 5500（VS Code 設定 `liveServer.settings.port` 被改過），請改 `main.js` 裡的 `HOST_URL`。

## 執行

```bash
cd host-app
npm install   # 已裝過可省略
npm start
```

## 設計說明

- 不內嵌、不重寫任何問答遊戲或 Live2D 邏輯，純粹是瀏覽器視窗的替代品
- 不會自動幫你啟動 Caddy 或 MQTT broker（避免把後端服務生命週期綁死在這個桌面程式上，維持低耦合）
- 玩家端（`multi/player.html`）維持原本的手機瀏覽器 + 掃 QR code 加入方式，不受影響
