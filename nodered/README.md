# nodered/

`multi/`（多人搶答網頁遊戲）MQTT 答題音效系統的 Node-RED 流程檔，是 `esp32/` 韌體的搭配測試/中介流程，不是獨立專案。完整架構圖跟檔案清單見 `esp32/MQTT_SOUND_DOC.md`。

| 檔案 | 用途 |
|---|---|
| `MQTT_SOUND.json` | 對應 `MQTT_SOUND_DOC.md` 說明的測試流程 |
| `flows_updated.json` | 較新版本的流程匯出檔 |

匯入方式：Node-RED 選單「Import」貼上 JSON 內容即可，不需要額外設定。
