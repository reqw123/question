# Archify Skill 使用說明

`archify` 是一個畫圖 skill：從精簡的 JSON 規格產生**自包含、可互動的 HTML 圖表**（架構圖、流程圖、時序圖、資料流圖、生命週期圖）。預設輸出是靜態的，只有使用者明確要求 demo／簡報時才會加上動畫效果。這份文件整理它有哪些指令、各自用在什麼情況，方便之後想畫圖時知道怎麼開口。

## 正規指令

不管想畫哪一種圖，使用者這邊的正規呼叫方式都只有一個：

```
/archify <需求描述>
```

例如 `/archify 幫我畫一張這個專案的系統架構圖，包含前端、後端跟資料庫`。圖表類型（`architecture`／`workflow`／`sequence`／`dataflow`／`lifecycle`）是 Claude 讀懂需求描述後自己判斷、不是使用者在指令裡指定的參數；也可以完全不打 `/archify`，直接用自然語言請 Claude 畫圖，因為這個 skill 本身就有對應的自然語言觸發敘述，兩種說法效果相同。下面「CLI 指令一覽」列的是 **Claude 內部實際執行**的指令（`node bin/archify.mjs ...`），使用者不需要自己打。

## 五種圖表類型與適用情境

跟 Claude 說要畫圖時，先想清楚要哪一種——類型選對了，出圖品質跟速度都會好很多。

| 類型 | 適用情境 | 正規指令 | 範例提示字 |
| --- | --- | --- | --- |
| `architecture` | 元件、服務、雲端／資安邊界、基礎設施 | `/archify <需求描述>` | 「幫我畫一張這個專案的系統架構圖，包含前端、後端跟資料庫」 |
| `workflow` | 流程、審核關卡、工具呼叫、runbook、CI/CD | `/archify <需求描述>` | 「畫一張 PR 從建立到部署的 CI/CD 流程圖」 |
| `sequence` | API 呼叫鏈、請求生命週期、非同步追蹤、回傳值 | `/archify <需求描述>` | 「畫一張使用者登入時前端、後端、資料庫之間的時序圖」 |
| `dataflow` | 資料管線、ETL/ELT、資料血緣、治理、下游消費者 | `/archify <需求描述>` | 「畫一張這個 pipeline 的資料流向圖，從原始資料到報表」 |
| `lifecycle` | 狀態／狀態轉換、重試、等待與終止狀態 | `/archify <需求描述>` | 「畫一張訂單狀態機圖，包含建立、付款、出貨、取消、退款」 |

不確定該選哪一種時，不用自己猜，可以直接說「這個情境比較適合畫哪種圖？」，Claude 會用 `guide` 指令問工具本身。

## CLI 指令一覽（Claude 執行，使用者通常不用自己打）

這些是 Claude 在畫圖過程中實際會呼叫的指令，使用者不需要自己執行，但知道各自用途有助於理解「Claude 現在在幹嘛」、以及看得懂回報結果。

| 正規指令（完整 CLI 語法） | 用途 | 使用時機 |
| --- | --- | --- |
| `node bin/archify.mjs doctor` | 檢查 archify 環境是否可用 | 第一次使用或懷疑環境有問題時 |
| `node bin/archify.mjs guide "<情境描述>" --json` | 情境不確定該選哪種圖表類型時，讓工具建議 | 使用者描述的需求含糊、跨兩種類型都說得通時 |
| `node bin/archify.mjs validate <type> <candidate.json> --quality showcase --json` | 驗證目前草稿：9 項 artifact checks 全過、0 錯誤 0 警告才算 showcase 通過 | 每次編輯候選規格之後、正式交付前一定要跑 |
| `node bin/archify.mjs deliver <type> <candidate.json> <output.html> --quality showcase --json` | **最終驗收指令**：把規格凍結、渲染、檢查、產出最終 HTML，回報 SHA-256 與位元組數 | 驗證全過之後，產生真正要交付的 HTML 檔案 |
| `node bin/archify.mjs preview <type> <input>.json <output>.html --quality showcase` | 選用，本機主動編輯時的即時預覽 | 只有使用者明確要求即時預覽時才用，預設不會主動開啟 |
| `node bin/archify.mjs demo <output-directory>` | 產生一份示範輸出，展示 archify 能做到什麼 | 使用者想先看範例、不確定要不要用這個 skill 時 |

**重要慣例**：`validate` 沒有全過（9 項 checks、0 錯誤 0 警告）不算真正通過；`deliver` 回傳非 0 結果一律視為失敗，不會被說成「完成了」。這是這個 skill 對「誠實回報結果」的硬性要求。

## Mermaid 輸入轉換

如果使用者手上已經有 Mermaid 圖（`flowchart`／`graph`、`sequenceDiagram`、`stateDiagram`），可以直接貼給 Claude 轉成 archify 的互動版本：

- `flowchart` / `graph` → 轉成 `workflow`（一般流程）或 `architecture`（元件關係圖）
- `sequenceDiagram` → 轉成 `sequence`，participant 對應語意角色、箭頭對應訊息
- `stateDiagram` → 轉成 `lifecycle`，狀態與轉移保留原意，不是照抄 Mermaid 的視覺樣式

範例提示字：「這是我手畫的 mermaid sequenceDiagram，幫我轉成更漂亮的互動式時序圖」

## 產生規則重點（想客製化提示字時參考）

- 一條清楚的主線 + 短分支，標籤稀疏、不過度標註，主要節點最多約 12 個
- 預設 `meta.quality_profile: showcase`（畫面精緻），除非使用者明確要求 `standard`（較密集的地圖式呈現）
- 元件類型只有 `frontend`、`backend`、`database`、`cloud`、`security`、`messagebus`、`external` 這幾種
- 沒有特別要求就不加圖例（legend），用工具的 `auto` 預設判斷

## Viewer 執行期能力（選用，不是額外的作畫工作）

產生出來的 HTML 本身就內建：主題切換（深色／淺色）、平移縮放、搜尋、聚焦、關係追蹤、語意視圖切換、簡報模式、可信的匯出功能——這些是給「看圖的人」用的，不需要額外提示字才能用。只有使用者明確要求 Share Cards、Route/Reach 卡片、動畫效果、導覽故事、深連結、簡報模式等進階功能時，才需要額外說明。

範例提示字：「這張架構圖要在會議上展示，幫我加上動畫效果」

## 範例提示字彙整（依常見使用情境分類）

- **不確定畫哪種圖**：「這個系統比較適合用 workflow 還是 sequence 圖表示？」
- **系統架構圖**：「幫我畫這個 repo 的高階架構圖，show 出前端、後端、資料庫、外部 API」
- **流程圖**：「畫一張使用者從註冊到驗證信箱的流程圖」
- **時序圖**：「畫一張下單流程的時序圖，前端呼叫 API，API 呼叫金流服務、寫入資料庫」
- **資料流圖**：「畫一張這個 ETL pipeline 的資料流圖，從來源資料庫到 BI 報表」
- **生命週期／狀態機圖**：「畫一張這個工單的狀態機，包含待處理、處理中、已完成、已取消，含重試邏輯」
- **從既有 Mermaid 轉換**：「這是我手畫的 mermaid sequenceDiagram，幫我轉成更漂亮的互動式時序圖」
- **加動畫做簡報**：「這張圖要在會議上展示，幫我開啟動畫效果」

## 相關產出（本專案內）

`archify-output/` 底下已經有一份實際產出範例（`runtime-architecture-zh.html`）——這個 repo 的執行期高階架構圖，涵蓋多人搶答系統與桌寵兩條路徑，可以直接打開參考實際畫出來長什麼樣子。
