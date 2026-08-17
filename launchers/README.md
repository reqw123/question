# launchers

給一般使用者的雙擊啟動捷徑，桌面上對應的三個捷徑已經建好，指到這裡的 `.bat`：

| 桌面捷徑 | 對應檔案 | 功能 |
|---|---|---|
| 多人搶答 - 網頁遊戲.lnk | `啟動-網頁遊戲.bat` | 自動偵測 `caddy.exe` 存不存在，決定用哪套伺服器，開瀏覽器到 `host.html`（見下方「網頁遊戲：Caddy 有無自動切換」） |
| 多人搶答 - 桌寵.lnk | `啟動-桌寵.bat` | 啟動 `desktop-pet`（保留終端機視窗顯示穿透/互動狀態） |
| 多人搶答 - 主持人App.lnk | `啟動-主持人App.bat` | 啟動 `host-app`，會先檢查 5500 埠有沒有東西在聽；沒有的話自動改用內建 Node 靜態伺服器頂上（不用再手動去 VS Code 按 Go Live，見下方第二步表格） |

## 為什麼 .bat 內容全用英文，檔名卻是中文

`cmd.exe` 對批次檔內容裡的中文字（尤其是 `start "標題"` 這種帶引號的中文）解析容易亂掉，就算開頭加 `chcp 65001` 也一樣會壞；但**檔名**是中文完全沒問題，是不同的處理層。所以檔名保留中文方便辨識，檔案內容一律用純 ASCII 避免這個坑。

## 為什麼到處都看得到 `Cache-Control: no-store`

專案還在持續開發，`multi/`、`lib/` 底下的檔案隨時會改。瀏覽器預設的啟發式快取規則，會在沒人明講的情況下自己決定某個 `.js` 檔案可以放心快取一陣子，改完程式碼、按重新整理卻看不到最新結果——這不是猜測，是實際踩過的坑：`Caddyfile`、`serve-lan.js` 都補上明確的 `Cache-Control: no-store`，強制瀏覽器每次都要重新問伺服器要最新版，不准自己決定要不要用舊的。`desktop-pet`／`host-app` 的 Electron 視窗也在 `main.js` 裡做了同樣等級的防護（session 層攔截、外加每次啟動清快取）。**這幾行不是多餘的防禦性程式碼，是真的解決過一次卡住好幾輪對話才找到根因的實際問題，不要因為看起來像樣板就砍掉。**

## 網頁遊戲：Caddy 有無自動切換

`啟動-網頁遊戲.bat` 執行時會先檢查專案根目錄有沒有 `caddy.exe`：

- **有 `caddy.exe`** → 照原本方式啟動 Caddy（`caddy.exe run`），走 `Caddyfile` 設定的公網模式，支援之後接 ngrok 讓區網外的玩家連進來（見 `multi/多人搶答系統技術文件.md` 的「公網對外開放」章節）。
- **沒有 `caddy.exe`** → 自動改用 [`serve-lan.js`](serve-lan.js)——一支零套件相依、只需要 Node.js 就能跑的靜態檔案伺服器，一樣把整個專案目錄用 `http://localhost:8080/` 服務起來，`multi/host.html` 照樣能開、QR code 照樣能掃、區網內搶答完全正常。差別只有一個：**不支援 `/mqtt` 反向代理**，所以沒辦法透過 ngrok 開放給區網外的玩家（純區網用途完全用不到這條——`multi/multiplay.js` 的 `mpMqttUrl()` 在 `http:` 協定下本來就是直連 `ws://IP:9001`，不經過任何反代，只有 `https:` 協定才會走 `/mqtt` 反代）。

兩種模式最後都會開瀏覽器連到同一個網址 `http://localhost:8080/multi/host.html`，使用上完全一樣，差別只在背後開的是哪個伺服器、要不要真的去下載 `caddy.exe`。如果連 Node.js 都沒裝（兩種伺服器都起不來），`.bat` 會印出清楚的錯誤訊息並停在原地，不會像之前那樣直接開出一個空白/連不上的瀏覽器分頁。

## 換到新電腦：一鍵安裝（推薦）

專案根目錄的 `一鍵安裝.bat` 把下面整套手動流程自動化了：**雙擊這一個檔案**就會依序完成 `desktop-pet`／`host-app` 的 `npm install`、產生 Live2D 角色清單設定（`manifest.json`／`names.json`）、建立桌面上的三個捷徑——不用照文件手動一步一步打指令，也不用像舊版腳本那樣自己去改寫死的路徑（自動抓專案實際所在位置）。

> [!IMPORTANT]
> **執行前只需要先裝好一樣東西：[Node.js](https://nodejs.org/)（選左邊的 LTS 版本）。**
> 除此之外不用另外安裝或設定任何東西——PowerShell 是 Windows 內建的（Windows 7 以上都有），執行原則的限制 `一鍵安裝.bat` 自己會繞過，不用使用者處理。萬一忘記先裝 Node.js，腳本會自己偵測到、停下來並附上下載連結，不會讓後面步驟悄悄失敗。

跑完之後畫面會列出「這支腳本沒辦法自動處理、要用到對應功能才需要自己準備」的項目（下載 `caddy.exe`、VS Code Live Server、Live2D 模型檔案）——這些不是執行這支安裝腳本本身的前提，只是某些進階功能要用到才需要，對照下面第二步的表格看需要哪些即可。

真正的邏輯在 `launchers/setup.ps1`（純 PowerShell，可以直接讀懂在做什麼）；`一鍵安裝.bat` 只是一個純 ASCII 內容的入口，用 `-ExecutionPolicy Bypass` 呼叫它——原因跟下面「為什麼 .bat 內容全用英文」是同一個坑，只是這裡反過來是 `.bat` 負責繞過雙擊 `.ps1` 預設不會執行的限制，中文訊息交給 PowerShell 印，不會亂碼。

> [!NOTE]
> 這個腳本可以重複執行，不會因為東西已經裝過就出錯（`npm install` 本身是幂等的，捷徑重建也只是覆蓋同名 `.lnk`）——之後想補裝 Live2D 模型、或懷疑某個步驟沒跑成功，直接再雙擊一次 `一鍵安裝.bat` 就好。

---

## 換到新電腦：手動設定流程（備用／想了解細節時參考）

上面的一鍵安裝腳本本質上就是把下面這幾步自動化，如果想手動個別執行其中一步（例如只想重建捷徑、不想重跑 `npm install`），或想知道每一步實際在做什麼，可以參考這裡。

捷徑本身只是「雙擊執行某個 `.bat`」的指標，`.bat` 真正依賴的東西（Node.js、npm 套件、`caddy.exe`⋯）在新電腦上不會自動存在。換電腦後要照下面順序來，跳過前面幾步直接建捷徑，點了也會失敗或空白。

### 第一步：確認專案資料夾本身已經複製/clone 到新電腦

這份 `launchers/README.md`、下面的 PowerShell 腳本，都假設專案在 `C:\question`。如果新電腦上路徑不一樣，**腳本裡的 `$launchers` 那一行要先手動改成實際路徑**，否則捷徑會指到不存在的地方。

### 第二步：安裝三個捷徑各自需要的東西

| 捷徑 | 需要先準備 |
|---|---|
| 多人搶答 - 網頁遊戲.lnk | 裝好 [Node.js](https://nodejs.org/) 就能跑（純區網用途）。**只有想額外支援 ngrok 對外公開**才需要另外下載 `caddy.exe`（[caddyserver.com](https://caddyserver.com/download) 下載 Windows 版，放到專案根目錄跟 `Caddyfile` 同一層——這個檔案不在 git 版本控制裡，`Caddyfile` 本身有進版本控制不用另外處理），沒有的話 `.bat` 會自動改用內建的區網版伺服器，見上方「網頁遊戲：Caddy 有無自動切換」。另外要有 MQTT broker（Mosquitto）在跑，細節見 `multi/多人搶答系統技術文件.md` |
| 多人搶答 - 桌寵.lnk | 裝好 [Node.js](https://nodejs.org/)，然後 `cd desktop-pet && npm install`（詳見 `desktop-pet/桌面寵物說明.md` 的「為什麼 node_modules 沒有進版本控制」） |
| 多人搶答 - 主持人App.lnk | 要 Node.js + `cd host-app && npm install`。5500 埠要有東西在服務 `multi/host.html`——`.bat` 會自動偵測：偵測到 VS Code **Live Server** 擴充套件（或任何其他方式）已經在 5500 就直接沿用；沒偵測到的話自動改用內建的 `launchers/serve-lan.js`（跟「網頁遊戲」那個捷徑背後同一支，只是換成 5500 埠），完全不用另外裝 Live Server 或手動按 Go Live |

三個捷徑互相獨立，只用得到哪個就只設定哪個對應的前置需求，不用三個都裝齊。

### 第三步：重新建立桌面捷徑

前面都準備好之後，用這段 PowerShell 建捷徑（**先確認第 2 行 `$launchers` 的路徑是新電腦上專案實際所在的位置**，不是的話要改）：

```powershell
$desktop = [Environment]::GetFolderPath('Desktop')
$launchers = "C:\question\launchers"   # ← 換電腦後路徑不同，先改這裡
$shell = New-Object -ComObject WScript.Shell
$targets = @(
  @{ Name = "多人搶答 - 網頁遊戲.lnk"; Bat = "啟動-網頁遊戲.bat" },
  @{ Name = "多人搶答 - 桌寵.lnk"; Bat = "啟動-桌寵.bat" },
  @{ Name = "多人搶答 - 主持人App.lnk"; Bat = "啟動-主持人App.bat" }
)
foreach ($t in $targets) {
  $sc = $shell.CreateShortcut((Join-Path $desktop $t.Name))
  $sc.TargetPath = Join-Path $launchers $t.Bat
  $sc.WorkingDirectory = $launchers
  $sc.Save()
}
```

**怎麼執行**：開始選單搜尋「PowerShell」開啟（不用系統管理員權限），把上面整段貼上去按 Enter，桌面就會出現三個捷徑。只是單純捷徑遺失、專案路徑沒變的情況（不是換電腦），也是跑這段就好，`$launchers` 不用改。
