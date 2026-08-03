# live2d_my_like

放你自己喜歡、收藏的 Live2D 模型的地方。數量會持續增加，資料夾名稱通常是一串不好辨識的編號，所以搭配一個簡單的流水號 + 可編輯名稱系統，並且在 `host.html` 大廳畫面提供下拉選單直接挑選角色一/角色二，不用再手動改 `lib/live2d.js`。

## 資料夾結構

- `models/`：所有角色模型資料夾（moc3、model3.json、motions、textures⋯）
- `config/`：設定檔與工具（本檔案、`manifest.json`、`names.json`、`generate-manifest.js`、`scan-params.js`、`live2d角色指令說明.md`、各角色參數文件）

## 新增模型後要做的事

把新的模型資料夾丟進 `models/`（支援 Cubism 2 的 `model.json` 跟 Cubism 3/4 的 `*.model3.json`），然後重新產生清單：

```bash
node live2d_my_like/config/generate-manifest.js
```

- `manifest.json`：自動產生，不要手動改。既有模型的流水號（`id`）不會因為重新掃描而改變，只有新加入的才會拿到新號碼
- `names.json`：**這個你可以手動編輯**。新模型第一次被掃到時，預設名稱是資料夾名稱（例如 `1009109`），把它改成你認得的名字即可（例如「橘貓獨角獸」），重新整理 `host.html` 就會顯示新名字，不用重新跑 `generate-manifest.js`

## host.html 怎麼用

大廳畫面「Live2D 角色」那兩個下拉選單（角色一／角色二）會列出這裡所有模型，選了之後：

- 存在**瀏覽器的 localStorage**，只影響你自己這台電腦看到的畫面，**不會同步給玩家**（玩家端維持 `lib/live2d.js` 原本寫死的角色）
- 需要**重新整理頁面**才會套用（選完會跳出確認視窗，可以直接按確定重新整理）
- 選單裡的「（預設，不覆蓋）」選項可以清掉你的選擇，恢復成 `lib/live2d.js` 裡原本寫死的角色

## 為什麼不同步給玩家

如果要讓所有裝置都看到同一組角色，需要透過 MQTT 把選擇廣播出去（跟 `gameMode`、題庫選擇同一等級的機制），這是比較大的改動；目前先做「只影響主持人本機」這個簡單版本。之後如果想要玩家端也同步看到，再另外處理。
