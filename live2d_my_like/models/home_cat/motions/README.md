# home_cat 動作說明

`home_cat.model3.json` 目前註冊的動作（`Motions.""` 群組，會被 `live2d_my_like/viewer.html`／
`Live2d-model-master/index.html` 的動作按鈕、🎲隨機動作自動抓到）：

| 檔案 | 名稱 | 時長 | 說明 |
|---|---|---|---|
| `home_cat_wave.motion3.json` | 打招呼 | 3.5 秒 | 耳朵先抖動預備 → 舉右手（`ParamArmR`）連續揮動 4 次（振幅先增後減，非單調重複）、身體隨節奏微彈跳、雙頰鼓起、中途吐一下舌頭、眼球看向鏡頭再看上方，最後開心眨眼收尾。 |
| `skill_02.motion3.json` | 伸懶腰打哈欠 | 4.0 秒 | 身體前傾、雙手往前伸到接近極限、張嘴打哈欠配合瞇眼、尾巴翹起、耳朵後貼再收回，最後身體微微後仰放鬆。（這個檔案本來是我做的 `home_cat_stretch.motion3.json`，後來使用者自己重新命名/接手調整成 `skill_02.motion3.json`，目前的版本可能已經跟這份說明的初版內容有出入，實際內容以檔案本身為準。） |
| `home_cat_sit_pretty.motion3.json` | 坐姿賣萌／好奇張望 | 4.5 秒 | **前腳固定成使用者指定的姿勢**（`ParamArmL=-1.68`／`ParamHandL=-0.24`／`ParamArmR=-1.88`／`ParamArmR2=0.19`，整段動作全程鎖死不參與動畫），其餘部位自由發揮：耳朵先立起、頭先看左再看右（配合 `EyeBallX`／`BodyAngleX`／鬍鬚 `MustacheL/R` 依左右交替抬起）、中途歪頭看鏡頭、輕聲「喵」一下（`MouthOpenY`＋`Tongue` 短暫peek＋`MouthForm`）、尾巴擺動、`ParamBreath` 做一次呼吸起伏，最後收回接近中性。 |

## 備份檔案（未註冊，不會被載入）

- `home_cat_wave_v1_backup.motion3.json` — `home_cat_wave` 第一版（單純揮手，沒有耳朵/舌頭/臉頰的細節），如果新版不喜歡可以直接把 model3.json 的檔名改回這份。

## 動作參數速查（供之後繼續調整用，實測自 home_cat.moc3）

| 參數 | 範圍 | 預設 | 備註 |
|---|---|---|---|
| ParamAngleX/Y/Z | -30~30 | 0 | 頭部轉向/抬頭/歪頭 |
| ParamEyeLOpen/ROpen | 0~1 | 1 | 眼睛開合，0=閉眼 |
| ParamEyeBallX/Y | -1~1 | 0 | 眼球左右/上下看 |
| ParamEyeForm | -1~1 | 0 | 眼型（瞇眼/睜大方向未實測確認，目前用正值做開心瞇眼） |
| ParamMouthForm | 0~2 | 0 | 嘴型（數值越高越像笑/開心，未實測確認上限效果） |
| ParamMouthOpenY | 0~1 | 0 | 嘴巴張開程度 |
| ParamTongue | 0~1 | 0 | 舌頭伸出程度 |
| ParamEarR/EarL | -1~1 | 0 | 左右耳角度 |
| ParamEarR2 | -1~1 | 0 | 右耳次關節（只有 R 有這個變化，L 沒有對應的 EarL2） |
| ParamBodyAngleX | -10~10 | 0 | 身體左右傾 |
| ParamBodyAngleY | -30~30 | 0 | 身體前後傾 |
| ParamFace | 0~1 | 0 | 用途未實測確認，目前動作都沒用到 |
| ParamBody | 0~1 | 1 | 用途未實測確認，預設 1，目前動作都維持預設沒動 |
| ParamBreath | 0~1 | 0 | 呼吸起伏 |
| ParamBlowL/R | -1~1 | 0 | 臉頰/鬍鬚墊鼓起方向 |
| ParamTailL | 0~1 | 0 | 尾巴翹起/捲曲程度（單方向，不是左右擺） |
| ParamMustacheL/R | -1~1 | 0 | 鬍鬚左右擺動 |
| ParamArmL | -2~0 | 0 | 左手，0=垂下，負值=舉起/伸展 |
| ParamHandL | -1~1 | 0 | 左手掌角度 |
| ParamArmR | -2.5~0 | 0 | 右手，0=垂下，負值=舉起/伸展 |
| ParamArmR2 | 0~1 | 0 | 右手次關節（前臂彎曲），跟 ArmL 沒有對應的次關節 |

所有動作都只用線性關鍵影格（沒有用 Bezier 曲線），格式已用 Python 讀回驗證過（JSON 合法、每條曲線時間點遞增）。**沒有實際在瀏覽器裡即時渲染驗證過視覺效果**（這個 session 瀏覽器工具斷線），數值都是照上面表格的實測 min/max 範圍設計，但實際播放效果請自己在 `viewer.html` 點動作按鈕確認，不理想的地方可以直接回報要調整的參數/時間點。
