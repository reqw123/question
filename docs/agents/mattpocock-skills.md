# Matt Pocock's Engineering & Productivity Skills 使用說明

來源：[github.com/mattpocock/skills](https://github.com/mattpocock/skills)，透過官方 plugin marketplace（`claude-plugins-official`）安裝，目前版本 `1.2.1`（`enabledPlugins` 設在 `~/.claude/settings.json`）。共 25 個已發布的 skill，分 `engineering`（18 個）與 `productivity`（7 個）兩類。跟 `docs/agents/archify.md` 不同——archify 是產圖工具，這一批是**工程流程與思考方法**（TDD、除錯、程式碼審查、把想法逼問清楚、拆票、交接……）。

## 兩種觸發方式，先搞懂這個差異

每個 skill 的 `SKILL.md` frontmatter 如果有 `disable-model-invocation: true`，代表**我不會自己判斷情境主動用它**，只能你自己明確打指令觸發；沒有這個標記的，我會照 `description` 描述的情境自己判斷要不要用。

- **自動判斷型**（11 個，我會自己抓時機）：`diagnosing-bugs`、`tdd`、`prototype`、`research`、`domain-modeling`、`codebase-design`、`code-review`、`resolving-merge-conflicts`、`wizard`、`grilling`、`writing-for-agents`
- **只能手動觸發型**（14 個，一定要你打 `/名稱`）：其餘全部——共通點是「會啟動一整個工作流程、寫進 issue tracker，或是需要明確意圖才該做的動作」，作者刻意不讓我自作主張啟動。

## 指令對照表：Engineering（18 個）

| Skill | 正規指令 | 觸發方式 | 適用情境 | 範例提示字 |
| --- | --- | --- | --- | --- |
| `diagnosing-bugs` | `/diagnosing-bugs` | 自動 | 難纏的 bug、效能退化，需要先建立可靠的紅/綠訊號再下手 | 「這個 API 偶爾會回傳 500，幫我 debug 一下」 |
| `tdd` | `/tdd` | 自動 | 想用測試先行的方式開發新功能或修 bug，或提到「red-green-refactor」 | 「幫我用 TDD 的方式加一個購物車折扣計算功能」 |
| `prototype` | `/prototype` | 自動 | 想先用一個可丟棄的原型驗證某個狀態機/邏輯合不合理，或想探索 UI 長相 | 「這個訂單狀態機的設計感覺怪怪的，先做個原型讓我玩玩看」 |
| `research` | `/research` | 自動 | 想針對某個技術問題查證一手資料（官方文件、原始碼、規格），並存成 repo 裡的筆記 | 「幫我研究一下 Electron 的 contextBridge 安全邊界，寫成筆記」 |
| `domain-modeling` | `/domain-modeling` | 自動 | 想釐清專案的領域詞彙、建立/維護 `CONTEXT.md` 跟 ADR | 「『即時對話』跟『閒置閒聊』這兩個詞我們常常搞混，幫我釐清定義寫進文件」 |
| `codebase-design` | `/codebase-design`（跟另一個非 mattpocock 的 `code-review` skill 無衝突，但見下方「命名衝突」） | 自動 | 想設計/改善模組介面、找出可以加深的模組、決定 seam 位置 | 「這個 `claude-cli.js` 模組的介面感覺太淺，幫我看看怎麼設計比較好」 |
| `code-review` | `/mattpocock-skills:code-review`（**必須用完整前綴，見下方命名衝突**） | 自動 | 想審查某個固定點之後的變更，同時檢查是否符合 repo 標準跟原始 issue/spec | 「幫我 review 這個分支從 main 分岔以來的變更」 |
| `resolving-merge-conflicts` | `/resolving-merge-conflicts` | 自動 | 正在進行中的 git merge/rebase 卡在衝突 | （通常不用特別講，我看到你在解衝突就會自動套用這套流程） |
| `wizard` | `/wizard` | 自動 | 要走一遍只有人類能做的手動步驟（申請憑證、設定第三方 dashboard、一次性搬遷） | 「幫我做一個精靈腳本，帶我完成 ngrok 帳號的 authtoken 設定」 |
| `ask-matt` | `/ask-matt` | 手動 | 不確定現在的情況該用這批 skill 裡的哪一個 | 「/ask-matt 我想把一個模糊的想法變成可執行的票，該用哪個？」 |
| `grill-with-docs` | `/grill-with-docs` | 手動 | 想被逼問把一個計畫/設計想清楚，過程中順便產出 ADR 跟詞彙表 | 「/grill-with-docs 我想清楚定義『CLI 模式免確認』這個功能的邊界」 |
| `triage` | `/triage` | 手動 | 要把 issue tracker 上的 issue／外部 PR 依分類、驗證、逼問的狀態機跑過一輪 | 「/triage」（在有 issue tracker 設定的 repo 裡直接跑） |
| `improve-codebase-architecture` | `/improve-codebase-architecture` | 手動 | 想掃描整個 codebase 找可以加深的模組，用視覺化報告呈現後挑一個逼問 | 「/improve-codebase-architecture 幫我掃一下 desktop-pet/ 有哪裡可以重構」 |
| `setup-matt-pocock-skills` | `/setup-matt-pocock-skills` | 手動 | 第一次在這個 repo 用這批 engineering skills 之前，設定 issue tracker／triage 標籤／領域文件位置 | 「/setup-matt-pocock-skills」（這個 repo 其實已經有 `docs/agents/issue-tracker.md`、`docs/agents/domain.md`，等於已經設定過，通常不用重跑） |
| `to-spec` | `/to-spec` | 手動 | 把目前對話討論出的內容直接整理成 spec、發布到 issue tracker（不訪談，純整理） | 「/to-spec」（討論完一個功能設計之後直接喊） |
| `to-tickets` | `/to-tickets` | 手動 | 把一份計畫/spec/對話拆成一組有依賴關係（blocking edges）的 tracer-bullet 票 | 「/to-tickets 把剛剛的多人搶答重連機制設計拆成票」 |
| `wayfinder` | `/wayfinder` | 手動 | 工作量大到一個 session 裝不下，需要在 issue tracker 上建一份決策票地圖，逐步釐清方向 | 「/wayfinder 我想清楚規劃『多人搶答要不要拆成獨立發布專案』這件事」 |
| `implement` | `/implement` | 手動 | 已經有 spec 或票，要照著實作（內部會用 `/tdd`、跑型別檢查/測試、結束後跑 `/mattpocock-skills:code-review`、commit） | 「/implement 照 docs/specs/0009 把免確認模式做出來」 |

## 指令對照表：Productivity（7 個）

| Skill | 正規指令 | 觸發方式 | 適用情境 | 範例提示字 |
| --- | --- | --- | --- | --- |
| `grilling` | `/grilling` | 自動 | 想被逼問把一個計畫/決定/想法想清楚（不產文件，純逼問，跟 `grill-with-docs` 的差別是不寫 ADR/詞彙表） | 「這個免確認模式的設計我還沒想清楚，grill 我一下」 |
| `writing-for-agents` | `/writing-for-agents` | 自動 | 要寫或改一份給 AI 讀的文件（skill、`CLAUDE.md`、`AGENTS.md`） | 「幫我改寫這份 `CLAUDE.md`，讓 AI 讀起來更清楚」 |
| `grill-me` | `/grill-me` | 手動 | 效果同 `grilling`，是 productivity 分類下的手動觸發版本 | 「/grill-me 我想清楚 Live2DFighter 的角色人設方向」 |
| `handoff`（`argument-hint`：下一個 session 要做什麼） | `/handoff "<下一步要做什麼>"` | 手動 | 把目前對話濃縮成一份交接文件，給另一個 agent／另一次 session 接手 | 「/handoff 繼續完成多人搶答的重連機制」 |
| `teach`（`argument-hint`：想學什麼） | `/teach "<想學的主題>"` | 手動 | 想在這個 workspace 的情境下學一個新技能/概念 | 「/teach MQTT 的 retain 訊息機制在這個專案裡怎麼用的」 |
| `to-questionnaire` | `/to-questionnaire` | 手動 | 有個自己回答不了的決定，想拆成一份問卷交給別人填 | 「/to-questionnaire 把『要不要把 CLI 模式免確認開放給角色二』這個決定做成問卷給我朋友填」 |
| `wait-what` | `/wait-what` | 手動 | 上一則我的回覆沒有真的說到重點，想要我重新講一次 | 「/wait-what」 |

## 命名衝突提醒

這個 session 同時裝了另一個獨立的 `code-review` skill（`/code-review`，支援 `low/medium/high/ultra` 等級、`--fix`、`--comment`），跟 mattpocock-skills 裡的 `code-review`（Standards + Spec 雙軸並行審查）**同名但是兩個不同的 skill**。打裸指令 `/code-review` 目前會解析到哪一個要看 CLI 的命名優先順序,為了保證叫到的是 mattpocock 這一版,請明確打完整前綴 `/mattpocock-skills:code-review`。其餘 24 個 mattpocock skill 目前跟本機其他已裝 skill 沒有撞名，打裸指令（例如 `/tdd`、`/wayfinder`）就可以。

## 常見組合流程

- `grill-with-docs` 內部其實就是「先跑 `/grilling`，再用 `/domain-modeling` 把結論寫成 ADR/詞彙表」——想清楚一件事又想順便留紀錄，直接跑這個就好，不用自己手動接兩個指令。
- `implement` 內部會用 `/tdd` 在約定好的 seam 上寫測試、定期跑型別檢查與單一測試檔、全部做完再跑一次完整測試、結束後叫 `/mattpocock-skills:code-review`（注意這裡也要完整前綴，理由同上）、最後 commit。適合已經有明確 spec/票、要直接動工的情境。
- `to-spec` / `to-tickets` / `triage` / `code-review`（mattpocock 版）都預期這個 repo 已經有 issue tracker 設定（`docs/agents/issue-tracker.md`）——這個 repo 已經有了（GitHub Issues via `gh` CLI），等於 `setup-matt-pocock-skills` 的前置設定已經完成，通常不用重跑。
