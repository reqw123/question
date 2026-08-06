# ============================================================================
# 一鍵安裝：把新環境（或給不熟悉指令列的使用者）跑起這個專案需要的手動步驟全部自動化。
#
# 這支腳本本身不會被使用者直接雙擊執行——Windows 對 .ps1 預設有執行原則限制，雙擊會
# 開文字編輯器而不是執行；真正的入口是專案根目錄的「一鍵安裝.bat」，那支 .bat 用
# -ExecutionPolicy Bypass 呼叫這支腳本，只影響這一次執行，不會更動系統原則。
# .bat 本身內容全用純 ASCII（跟 launchers/README.md 說明的理由一樣：cmd.exe 解析
# 批次檔裡的中文字容易亂掉），這支 .ps1 才是真正做事、印中文訊息的地方——
# PowerShell 對 Unicode 的處理比 cmd.exe 成熟很多，這裡放中文訊息是安全的。
#
# 會做的事（對應 launchers/README.md「換到新電腦：完整設定流程」手動步驟）：
#   1. 檢查 Node.js 有沒有裝
#   2. desktop-pet/、host-app/ 各自 npm install
#   3. 產生 live2d_my_like/config/manifest.json 等設定檔（模型檔案本身沒有跟著專案
#      發布，沒有的話這一步會友善跳過，不會讓整支腳本失敗）
#   4. 建立三個桌面捷徑（不寫死路徑，自動抓這支腳本所在的專案根目錄）
#
# 不會做、需要使用者自己另外處理的事（見腳本最後印出的提醒）：
#   - 安裝 Node.js 本身（沒裝會直接停下來，附下載連結）
#   - 下載 caddy.exe（只有想額外支援 ngrok 對外公開才需要）
#   - 安裝 VS Code 的 Live Server 擴充套件（主持人 App 需要）
#   - 取得 Live2D 模型檔案本身（不在版本控制裡，屬於個人/授權內容）
# ============================================================================

$ErrorActionPreference = 'Stop'
# $PSScriptRoot 是這支 .ps1 自己所在的資料夾（launchers/），專案根目錄是它的上一層——
# 不管專案被複製到哪台電腦、哪個路徑，這樣抓永遠是對的，不用像舊版 README 裡的手動
# 腳本那樣要求使用者自己去改寫死的 C:\question。
$root = Split-Path $PSScriptRoot -Parent

function Write-Step($msg) { Write-Host ""; Write-Host "== $msg ==" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  [!] $msg" -ForegroundColor Yellow }
function Write-Fail($msg) { Write-Host "  [X] $msg" -ForegroundColor Red }

Write-Host "多人搶答系統 + 桌面寵物 —— 一鍵安裝" -ForegroundColor Magenta
Write-Host "專案位置：$root"

# ── 1. 檢查 Node.js ──────────────────────────────────────────────────────
Write-Step "檢查 Node.js"
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Fail "找不到 Node.js，desktop-pet／host-app 都需要它才能安裝跟執行。"
  Write-Host "  請先到 https://nodejs.org/ 下載安裝（一般選左邊 LTS 版本即可）。"
  Write-Host "  安裝完成後要重新打開一個新視窗再執行這支腳本一次，系統才抓得到剛裝好的 Node.js。"
  Read-Host "按 Enter 鍵離開"
  exit 1
}
Write-Ok "已偵測到 Node.js $(node --version)"

# ── 2. npm install（desktop-pet / host-app）──────────────────────────────
function Install-NpmProject([string]$folderName) {
  $dir = Join-Path $root $folderName
  $pkg = Join-Path $dir 'package.json'
  if (-not (Test-Path $pkg)) {
    Write-Warn "找不到 $folderName\package.json，跳過。"
    return
  }
  Write-Step "安裝 $folderName 的相依套件（npm install，第一次會花一點時間，請耐心等待）"
  Push-Location $dir
  try {
    npm install --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) { throw "npm install 結束碼 $LASTEXITCODE" }
    Write-Ok "$folderName 安裝完成"
  } catch {
    Write-Fail "$folderName 安裝失敗：$_"
    Write-Warn "可以先看看上面 npm 印出的錯誤訊息，或稍後重新執行這支腳本再試一次。"
  } finally {
    Pop-Location
  }
}
Install-NpmProject 'desktop-pet'
Install-NpmProject 'host-app'

# ── 3. 產生 Live2D 角色清單設定（manifest.json / names.json）────────────
Write-Step "產生 Live2D 角色清單設定"
$modelsDir = Join-Path $root 'live2d_my_like\models'
$genScript = Join-Path $root 'live2d_my_like\config\generate-manifest.js'
if (-not (Test-Path $modelsDir)) {
  Write-Warn "找不到 live2d_my_like\models\ 資料夾——Live2D 模型檔案本身沒有跟著專案一起發布（需要另外取得），這一步先跳過，不影響 desktop-pet／host-app 安裝完成。"
  Write-Warn "之後拿到模型檔案、放進這個資料夾後，重新執行這支腳本一次即可補產生設定檔。"
} elseif (-not (Test-Path $genScript)) {
  Write-Warn "找不到 generate-manifest.js，跳過。"
} else {
  Push-Location (Split-Path $genScript)
  try {
    node (Split-Path $genScript -Leaf)
    if ($LASTEXITCODE -ne 0) { throw "generate-manifest.js 結束碼 $LASTEXITCODE" }
    Write-Ok "manifest.json / names.json 已更新"
  } catch {
    Write-Fail "產生設定檔失敗：$_"
  } finally {
    Pop-Location
  }
}

# ── 4. 建立桌面捷徑 ──────────────────────────────────────────────────────
Write-Step "建立桌面捷徑"
$desktop = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell
$targets = @(
  @{ Name = '多人搶答 - 網頁遊戲.lnk';   Bat = '啟動-網頁遊戲.bat' },
  @{ Name = '多人搶答 - 桌寵.lnk';       Bat = '啟動-桌寵.bat' },
  @{ Name = '多人搶答 - 主持人App.lnk'; Bat = '啟動-主持人App.bat' }
)
foreach ($t in $targets) {
  $target = Join-Path $PSScriptRoot $t.Bat
  if (-not (Test-Path $target)) {
    Write-Warn "找不到 launchers\$($t.Bat)，跳過「$($t.Name)」這個捷徑。"
    continue
  }
  try {
    $sc = $shell.CreateShortcut((Join-Path $desktop $t.Name))
    $sc.TargetPath = $target
    $sc.WorkingDirectory = $PSScriptRoot
    $sc.Save()
    Write-Ok "已建立捷徑：$($t.Name)"
  } catch {
    Write-Fail "建立捷徑「$($t.Name)」失敗：$_"
  }
}

# ── 完成，總結還需要使用者自己做的事 ──────────────────────────────────────
Write-Host ""
Write-Host "============================================================" -ForegroundColor Magenta
Write-Host "安裝流程跑完了！桌面上應該已經看得到三個捷徑。" -ForegroundColor Magenta
Write-Host "============================================================" -ForegroundColor Magenta
Write-Host ""
Write-Host "以下這些不是這支腳本能自動處理的，要用到對應功能時記得自己準備：" -ForegroundColor Yellow
Write-Host "  · 想開放區網外的玩家連進來（ngrok）：需要另外下載 caddy.exe 放到專案根目錄"
Write-Host "    （下載處：https://caddyserver.com/download），沒有的話網頁遊戲照樣能在區網內玩。"
Write-Host "  · 主持人 App：需要 VS Code 裝好 Live Server 擴充套件，執行前先對 multi/host.html 按「Go Live」。"
Write-Host "  · Live2D 模型檔案本身：需要另外取得放進 live2d_my_like\models\，屬於個人/授權內容，"
Write-Host "    不在這個專案的版本控制裡。"
Write-Host ""
Read-Host "按 Enter 鍵關閉這個視窗"
