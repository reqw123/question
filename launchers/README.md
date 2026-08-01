# launchers

給一般使用者的雙擊啟動捷徑，桌面上對應的三個捷徑已經建好，指到這裡的 `.bat`：

| 桌面捷徑 | 對應檔案 | 功能 |
|---|---|---|
| 多人搶答 - 網頁遊戲.lnk | `啟動-網頁遊戲.bat` | 啟動 Caddy，自動開瀏覽器到 `host.html` |
| 多人搶答 - 桌寵.lnk | `啟動-桌寵.bat` | 啟動 `desktop-pet`（保留終端機視窗顯示穿透/互動狀態） |
| 多人搶答 - 主持人App.lnk | `啟動-主持人App.bat` | 啟動 `host-app`，會先檢查 Live Server (5500) 是否已開 |

## 為什麼 .bat 內容全用英文，檔名卻是中文

`cmd.exe` 對批次檔內容裡的中文字（尤其是 `start "標題"` 這種帶引號的中文）解析容易亂掉，就算開頭加 `chcp 65001` 也一樣會壞；但**檔名**是中文完全沒問題，是不同的處理層。所以檔名保留中文方便辨識，檔案內容一律用純 ASCII 避免這個坑。

## 補捷徑 / 換電腦後重建捷徑

若捷徑遺失或搬到新電腦，重新建立：

```powershell
$desktop = [Environment]::GetFolderPath('Desktop')
$launchers = "C:\question\launchers"
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
