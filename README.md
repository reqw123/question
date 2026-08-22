# question

個人專案集合：Live2D 桌面互動（桌寵助理、多人搶答遊戲）與周邊工具。這份文件是**根目錄每個資料夾/檔案的用途索引**——每個子專案的操作細節、架構決策見它們各自的 README/說明文件；領域用詞、術語見 [`CONTEXT.md`](CONTEXT.md)；換電腦的完整設定流程見 [`launchers/README.md`](launchers/README.md)。

## 三個主要使用情境（桌面 App / Electron）

| 資料夾 | 說明 |
|---|---|
| [`desktop-pet/`](desktop-pet/桌面寵物說明.md) | Live2D 桌面透明背景掛件本體，可打包成獨立 `.exe` |
| [`host-app/`](host-app/) | 多人搶答主持人畫面的桌面殼層，載入 `multi/host.html` |
| [`control-center/`](control-center/) | 選用的中樞控制台，集中管理上面兩個模式＋網頁模式的啟動/關閉 |

## 多人搶答網頁遊戲

| 資料夾 | 說明 |
|---|---|
| `multi/` | 遊戲本體（純 HTML/JS，無 `package.json`），技術文件見 `multi/多人搶答系統技術文件.md` |
| `questions/` | 題庫 JSON（`multi/host.html`、`multi/multiplay.js` 讀取） |
| `ai-quiz-generator/` | 用 AI 產生題庫、匯出成 `questions/` 格式的輔助工具 |
| `esp32/` | MQTT 答題音效系統的 ESP32 韌體（周邊硬體，非必要） |
| `nodered/` | 上面那套 MQTT 音效系統的 Node-RED 測試流程 |
| `sound/` | 遊戲通用音效/配樂 |

## 其他獨立網頁專案

| 資料夾 | 說明 |
|---|---|
| `desktop-pet-web/` | 桌寵的介紹網頁（React+Vite 靜態網站），跟 `desktop-pet/` 的 Electron App 是不同專案，只是同名容易搞混 |
| `glb-viewer/` | 獨立測試工具，驗證 `.glb` 模型能否用 Three.js 正常載入 |

## 共用資源（給桌寵/網頁遊戲讀取，不是獨立專案）

| 資料夾 | 說明 |
|---|---|
| `lib/` | 唯讀共用的 Live2D SDK 打包檔（`desktop-pet/`、`multi/` 都會讀） |
| `live2d_my_like/` | 個人收藏的 Live2D 角色模型庫（`models/` 授權內容不進版控，需要另外取得） |
| `特定角色語音/` | 特定 Live2D 角色專屬語音（跟 `sound/` 是不同東西，見資料夾內 README） |

## 開發/維運雜項

| 項目 | 說明 |
|---|---|
| `launchers/` | 一般使用者用的雙擊啟動 `.bat`／`一鍵安裝.bat` 的實際邏輯 |
| `tools/` | 獨立 Python 小工具（貼圖處理、滑鼠巨集等），跟主程式無相依 |
| `docs/` | 架構決策紀錄（`adr/`）、規格（`specs/`）、Agent 用文件（`agents/`）等 |
| `一鍵安裝.bat` | 換新電腦時的一鍵設定入口，實際邏輯在 `launchers/setup.ps1` |
| `Caddyfile` | 網頁遊戲對外公開模式用的 Caddy 設定 |

## 暫時不維護

`single/`（手勢互動問答遊戲，單人版）目前暫時不維護，日常審查/搜尋程式碼一律略過，詳見 `single/說明.md`。
