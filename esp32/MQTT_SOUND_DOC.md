# MQTT 答題音效系統說明文件

## 系統概述

透過 MQTT 將瀏覽器答題結果即時傳送至 ESP32，由 DFPlayer Mini MP3 模組根據答題狀況播放對應音效。模組採用非阻塞設計，即使 MQTT 連線失敗，遊戲也能正常運行。

---

## 架構圖

```
瀏覽器 (HTML)
  └─ MQTTSound.js
       │  判斷答題結果 → 決定播放指令
       │  WebSocket (port 9001)
       ▼
  MQTT Broker (Mosquitto)
       │  TCP (port 1883)
       ▼
  ESP32 (MQTT_QUIZ_SOUND.ino)
       └─ DFPlayer Mini → 喇叭
```

---

## 檔案清單

| 檔案 | 說明 |
|------|------|
| `MQTTSound.js` | 瀏覽器端 MQTT 音效模組 |
| `MQTT_QUIZ_SOUND.ino` | ESP32 Arduino 程式 |
| `MQTT_SOUND.json` | Node-RED 測試流程 |
| `index.html` | 含 MQTT 狀態徽章 |
| `style.css` | 狀態徽章樣式 |
| `main.js` | 遊戲主程式（掛鉤點） |

---

## 硬體接線

### DFPlayer Mini ↔ ESP32

| DFPlayer Mini | ESP32 |
|---------------|-------|
| TX | GPIO 16（RX2） |
| RX | 1kΩ → GPIO 17（TX2） |
| VCC | 5V |
| GND | GND |
| SPK_1 / SPK_2 | 喇叭 |

> **注意**：DFPlayer RX 腳位必須串聯 1kΩ 電阻，避免損壞模組。

---

## SD 卡音檔命名

使用 `playMp3Folder(N)` 按**檔名**定址，與 FAT 寫入順序無關，可靠度更高。

SD 卡結構：在根目錄建立 `MP3` 資料夾，音檔放入其中。

```
SD 卡/
└── MP3/
    ├── 0001.mp3
    ├── 0002.mp3
    ├── 0003.mp3
    ├── 0004.mp3
    ├── 0005.mp3
    ├── 0006.mp3
    └── 0010.mp3
```

| 檔名 | playMp3Folder(N) | 觸發來源 | 觸發條件 |
|------|-----------------|---------|---------|
| `MP3/0001.mp3` | playMp3Folder(1)  | TRACK_1 | 答對一題（連對未達門檻） |
| `MP3/0002.mp3` | playMp3Folder(2)  | TRACK_2 | 答錯一題（連錯未達門檻） |
| `MP3/0003.mp3` | playMp3Folder(3)  | TRACK_3 | 連對達門檻（播一次） |
| `MP3/0004.mp3` | playMp3Folder(4)  | TRACK_4 | 連錯達門檻（播一次） |
| `MP3/0005.mp3` | playMp3Folder(5)  | TRACK_5 | 結算：正確率 ≤ 門檻值 |
| `MP3/0006.mp3` | playMp3Folder(6)  | TRACK_6 | 結算：正確率 > 門檻值 |
| `MP3/0010.mp3` | playMp3Folder(10) | 啟動 | ESP32 上電確認音，播一次 |

> `MP3/0007.mp3` ~ `MP3/0009.mp3` 保留未使用，可日後擴充。

---

## MQTT 主題對照

| 方向 | Topic | Payload | 說明 |
|------|-------|---------|------|
| 瀏覽器 → ESP32 | `quiz/sound` | `TRACK_1` ~ `TRACK_6` | 播放指令 |
| ESP32 → Broker | `home/quiz_sound/status` | `online` | ESP32 上線通知（retained） |

---

## 播放邏輯

### 答題中

```
答對（連對 < 3 題）→ TRACK_1（播一次）
答對（連對 = 3 題）→ TRACK_3（播一次）
答對（連對 > 3 題）→ 不重複發送（TRACK_3 已觸發過）
答對（正在連錯中）→ TRACK_1（play 自動中斷前一首）

答錯（連錯 < 3 題）→ TRACK_2（播一次）
答錯（連錯 = 3 題）→ TRACK_4（播一次）
答錯（連錯 > 3 題）→ 不重複發送
答錯（正在連對中）→ TRACK_2（play 自動中斷前一首）
```

### 結算

```
正確率 > 50% → TRACK_6
正確率 ≤ 50% → TRACK_5
```

> 門檻值可在 `MQTTSound.js` 的 `MQTTS_CFG.finish.passThreshold` 修改。

### 每局重置

按下「再玩一次」時，連對／連錯計數與 streakMode 全部歸零。

---

## MQTTSound.js 設定變數

```js
const MQTTS_CFG = {

  // ── 連線設定 ──────────────────────────────
  brokerIP:    '192.168.0.171', // Broker 的 IP 位址
  wsPort:      9001,            // Broker 的 WebSocket 埠號
  topic:       'quiz/sound',    // 發布給 ESP32 的 MQTT 主題
  initTimeout: 2000,            // 連線等待上限（毫秒）

  // ── 連續答題門檻 ──────────────────────────
  streakCount: 3,               // 連續答對／答錯幾題後觸發特殊音效

  // ── 答題中音效規則 ────────────────────────
  rules: {
    correct:       'TRACK_1',  // 答對一題
    wrong:         'TRACK_2',  // 答錯一題
    streakCorrect: 'TRACK_3',  // 連對達門檻
    streakWrong:   'TRACK_4',  // 連錯達門檻
  },

  // ── 結算音效規則 ──────────────────────────
  finish: {
    passThreshold: 50,          // 通過門檻（%）
    pass:          'TRACK_6',   // 正確率 > 門檻
    fail:          'TRACK_5',   // 正確率 ≤ 門檻
  },

};
```

---

## MQTTSound.js 公開方法

| 方法 | 呼叫時機 | 說明 |
|------|---------|------|
| `mqttSound.init()` | 遊戲初始化 | 建立 MQTT 連線，非阻塞 |
| `mqttSound.onResult(isCorrect)` | 每題作答後 | 判斷並發布音效指令 |
| `mqttSound.onFinish(correct, total)` | 遊戲結算時 | 計算正確率並發布結算音效 |
| `mqttSound.resetStreak()` | 每局開始時 | 重置所有連勝/連敗計數 |
| `mqttSound.dispose()` | 不再使用時 | 關閉 MQTT 連線 |

---

## main.js 掛鉤點

```js
// init()：遊戲初始化
mqttSound.init();

// startGame()：每局開始
mqttSound.resetStreak();

// showResult(letter)：每題作答後
mqttSound.onResult(correct);

// endGame()：遊戲結算
mqttSound.onFinish(correct, total);
```

---

## UI 狀態徽章

固定顯示於畫面右下角，反映即時連線狀態。

| 樣式 | 顏色 | 文字 | 說明 |
|------|------|------|------|
| `s-off` | 灰 | MQTT | 未連線／初始狀態 |
| `s-broker` | 黃（閃爍） | Broker 已連 | 連上 Broker，等待 ESP32 |
| `s-esp32` | 綠 | ESP32 上線 | 收到 ESP32 retained 狀態訊息 |
| `s-error` | 紅 | 連線失敗 | MQTT 發生錯誤 |

### ESP32 先上線的問題

ESP32 發布 `home/quiz_sound/status: online` 時帶有 `retain=true`，Broker 會永久保存這條訊息。瀏覽器任何時間訂閱後，Broker 立刻推送保留訊息，不受上線順序影響。

---

## Mosquitto Broker 設定

瀏覽器需透過 WebSocket 連線，`mosquitto.conf` 須開啟：

```conf
listener 1883
protocol mqtt

listener 9001
protocol websockets
```

---

## Node-RED 測試流程（MQTT_SOUND.json）

匯入後可手動點擊各 inject 節點測試每個音效指令，右側 debug 面板顯示收到的訊息與 ESP32 連線狀態。

| Inject 節點 | Payload |
|------------|---------|
| ✅ 答對 | `TRACK_1` |
| ❌ 答錯 | `TRACK_2` |
| 🔥 連對達門檻 | `TRACK_3` |
| 💀 連錯達門檻 | `TRACK_4` |
| 📉 結算失敗 | `TRACK_5` |
| 🏆 結算通過 | `TRACK_6` |

---

## 鍵盤模式（無相機時）

相機未連接或無法取得權限時，遊戲仍可正常進行，改用鍵盤答題。

### 答題按鍵對照

| 按鍵 | 對應選項 | 對應手勢 |
|------|---------|---------|
| `A` | 選項 A | 👊 Rock Fist |
| `B` | 選項 B | ✌️ Victory |
| `C` | 選項 C | ☝️ One Finger |
| `D` | 選項 D | ✋ Open Palm |

> 鍵盤輸入僅在「答題中」階段有效，倒數、結果、結算畫面按鍵不觸發，防止誤按。

### 相機狀態指示器（介紹畫面）

頁面載入時自動偵測相機，開始按鈕停用直到確認狀態：

| 顏色 | 文字 | 說明 |
|------|------|------|
| 🟡 閃爍 | 偵測相機中... | 正在請求相機權限 |
| 🟢 | 相機就緒 | 相機可用，手勢模式 |
| 🔴 | 相機未連接 | 無相機，鍵盤模式 |

- 支援熱插拔：相機拔除後狀態即時更新
- 無論相機是否就緒，確認後開始按鈕皆會啟用

---

## 相機來源設定（雙模式）

`main.js` 頂端的 `CAMERA_CFG` 控制相機輸入來源。

```js
const CAMERA_CFG = {
  mode:        'webcam',              // 'webcam' | 'esp32cam'
  esp32camURL: 'http://192.168.0.100', // ESP32-CAM IP（mode='esp32cam' 時填入）
};
```

### 模式比較

| 項目 | webcam | esp32cam |
|------|--------|----------|
| 輸入來源 | `getUserMedia` + MediaPipe Camera class | MJPEG IP 串流（`<img>` 元素）|
| 畫面鏡像 | 是（`scaleX(-1)`） | 否（固定鏡頭） |
| 串流 URL | 瀏覽器自動 | `{esp32camURL}/stream` |
| 啟動確認 | `getUserMedia` 請求 | `fetch {esp32camURL}/` 3 秒逾時 |
| 無法連線時 | 鍵盤 A/B/C/D 備援 | 鍵盤 A/B/C/D 備援 |

### ESP32-CAM 串流 URL

ESP32-CAM 標準韌體串流端點為 `/stream`，即：

```
http://192.168.0.100/stream
```

若使用其他韌體（如 RTSP 或自訂 HTTP），請修改 `_startESP32Cam()` 中的 `streamURL`。

### 切換步驟

1. 將 `CAMERA_CFG.mode` 改為 `'esp32cam'`
2. 將 `CAMERA_CFG.esp32camURL` 填入 ESP32-CAM 的 IP
3. 重新整理頁面；進入遊戲後畫面角落會顯示 ESP32-CAM 串流

---

## Arduino 函式庫需求

| 函式庫 | 用途 |
|--------|------|
| `WiFi.h` | ESP32 Wi-Fi 連線 |
| `PubSubClient` | MQTT TCP 通訊 |
| `DFRobotDFPlayerMini` | DFPlayer Mini 控制 |
