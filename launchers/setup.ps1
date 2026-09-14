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
#   2. 自動掃描整個專案裡所有 package.json（略過 node_modules/、single/、以及沒有宣告
#      相依套件的標記檔），逐一 npm install——目前涵蓋 desktop-pet/、host-app/、
#      control-center/、desktop-pet-web/、glb-viewer/，之後新增子專案也不用再改這裡
#   3. 產生 live2d_my_like/config/manifest.json 等設定檔（模型檔案本身沒有跟著專案
#      發布，沒有的話這一步會友善跳過，不會讓整支腳本失敗）
#   4. 建立桌面捷徑（不寫死路徑，自動抓這支腳本所在的專案根目錄）
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

# ── 2. npm install（自動掃描整個專案的 package.json，逐一安裝）────────────
# 不再寫死清單——避免以後新增子專案（像 desktop-pet-web、glb-viewer）被漏掉。
# 規則：
#   · 略過 node_modules\ 底下的、single\ 底下的（single/ 暫不維護，見 CLAUDE.md）
#   · 沒有 dependencies 也沒有 devDependencies 的 package.json 跳過（例如
#     desktop-pet\particle-effect\ 那份只是給 Node 當 ESM 解析用的標記檔）
# electron 套件的安裝分兩階段：先裝 npm 套件本身，再由套件自己的 install.js 去下載真正
# 的執行檔（寫進 node_modules\electron\dist\、並產生 path.txt 指出執行檔檔名）。實測遇過
# 這個下載階段沒有跑完（網路中斷、防毒軟體攔截等），但 node_modules\electron 資料夾本身
# 已經存在——npm 看到版本跟 package-lock.json 對得上就認為「已經裝過」，之後不管重跑
# npm install 幾次都不會主動重新觸發下載，導致 desktop-pet／host-app／control-center
# 在 control-center 裡怎麼點「啟動」都無聲無息失敗（electronBinFor() 讀不到 path.txt）。
# 這裡在 npm install 跑完後多一層驗證：這個專案如果有裝 electron，就確認 path.txt 真的
# 存在，沒有的話直接呼叫 electron 自己的 install.js 補跑一次下載，不用使用者自己動手。
function Repair-ElectronBinaryIfNeeded([string]$dir, [string]$rel) {
  $electronDir = Join-Path $dir 'node_modules\electron'
  if (-not (Test-Path $electronDir)) { return } # 這個專案沒有依賴 electron，不適用
  $pathTxt = Join-Path $electronDir 'path.txt'
  if (Test-Path $pathTxt) { return } # 已經有執行檔，不用補
  Write-Warn "$rel 的 electron 執行檔似乎沒有下載完整（找不到 path.txt），嘗試自動補跑安裝腳本..."
  Push-Location $dir
  try {
    node (Join-Path $electronDir 'install.js')
    if ($LASTEXITCODE -ne 0) { throw "install.js 結束碼 $LASTEXITCODE" }
    if (Test-Path $pathTxt) {
      Write-Ok "$rel 的 electron 執行檔已補齊"
    } else {
      throw '補跑完成但 path.txt 仍然不存在'
    }
  } catch {
    Write-Fail "$rel 的 electron 執行檔補齊失敗：$_"
    Write-Warn "可以稍後重新執行這支腳本再試一次，或手動到 $rel 資料夾執行：node node_modules\electron\install.js"
  } finally {
    Pop-Location
  }
}

function Install-NpmProject([System.IO.FileInfo]$pkgFile) {
  $dir = $pkgFile.DirectoryName
  $rel = $dir.Substring($root.Length).TrimStart('\')
  # 不用 ConvertFrom-Json：package.json 的 description 有中文，Windows PowerShell 5.1
  # 讀 UTF-8（無 BOM）會亂碼導致解析失敗。改用純 ASCII 的鍵名做正則判斷即可，
  # 內容是不是亂碼都不影響（"dependencies" / "devDependencies" 這兩個鍵是 ASCII）。
  $raw = ''
  try { $raw = [System.IO.File]::ReadAllText($pkgFile.FullName) } catch {
    Write-Warn "$rel\package.json 讀取失敗（$_），跳過。"
    return
  }
  if ($raw -notmatch '"(dependencies|devDependencies)"\s*:\s*\{\s*"') {
    Write-Warn "$rel 沒有宣告任何相依套件，跳過。"
    return
  }
  Write-Step "安裝 $rel 的相依套件（npm install，第一次會花一點時間，請耐心等待）"
  Push-Location $dir
  try {
    npm install --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) { throw "npm install 結束碼 $LASTEXITCODE" }
    Write-Ok "$rel 安裝完成"
  } catch {
    Write-Fail "$rel 安裝失敗：$_"
    Write-Warn "可以先看看上面 npm 印出的錯誤訊息，或稍後重新執行這支腳本再試一次。"
  } finally {
    Pop-Location
  }
  Repair-ElectronBinaryIfNeeded $dir $rel
}

# -Depth 3 夠涵蓋所有子專案（最深的是 desktop-pet\particle-effect），又能避免真的鑽進
# node_modules 那種好幾層深的相依樹（那些的 package.json 一律被下面的 -notmatch 濾掉）。
$pkgFiles = Get-ChildItem -Path $root -Recurse -Depth 3 -Filter 'package.json' -File -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -notmatch '\\node_modules\\' -and $_.FullName -notmatch '\\single\\' } |
  Sort-Object FullName
if (-not $pkgFiles) {
  Write-Warn "整個專案裡找不到任何 package.json，這一步跳過。"
} else {
  Write-Host "  找到 $($pkgFiles.Count) 個 package.json：" -ForegroundColor DarkGray
  $pkgFiles | ForEach-Object { Write-Host "    · $($_.DirectoryName.Substring($root.Length).TrimStart('\'))" -ForegroundColor DarkGray }
  foreach ($f in $pkgFiles) { Install-NpmProject $f }
}

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
  @{ Name = '多人搶答 - 網頁遊戲.lnk';   Bat = '啟動-網頁遊戲.bat';   Icon = '圖示\網頁遊戲.ico' },
  @{ Name = '多人搶答 - 桌寵.lnk';       Bat = '啟動-桌寵.bat';       Icon = '圖示\桌寵.ico' },
  @{ Name = '多人搶答 - 主持人App.lnk'; Bat = '啟動-主持人App.bat'; Icon = '圖示\主持人App.ico' },
  @{ Name = '多人搶答 - 主控制中心.lnk'; Bat = '啟動-主控制中心.bat'; Icon = '圖示\主控制中心.ico' }
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
    $iconPath = Join-Path $PSScriptRoot $t.Icon
    if (Test-Path $iconPath) {
      $sc.IconLocation = "$iconPath,0"
    } else {
      Write-Warn "找不到圖示 launchers\$($t.Icon)，「$($t.Name)」改用預設圖示。"
    }
    $sc.Save()
    Write-Ok "已建立捷徑：$($t.Name)"
  } catch {
    Write-Fail "建立捷徑「$($t.Name)」失敗：$_"
  }
}

# ── 完成，總結還需要使用者自己做的事 ──────────────────────────────────────
Write-Host ""
Write-Host "============================================================" -ForegroundColor Magenta
Write-Host "安裝流程跑完了！桌面上應該已經看得到四個捷徑。" -ForegroundColor Magenta
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
