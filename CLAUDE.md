# 專案筆記

## single/ 暫時不維護

`single/`（手勢互動問答遊戲，單人版）目前暫時不維護。日後檢閱、審查、搜尋程式碼或回答問題時，
請直接略過這個資料夾，除非使用者明確指名要處理 `single/` 裡的東西。詳見 `single/說明.md`。

## Live2DFighter（外部專案，已搬出）

Unity + Live2D 2D 格鬥遊戲已搬到 `C:\Live2DFighter\`（獨立 git repo），不再是本 repo 底下的資料夾。它讀取本 repo 的 `live2d_my_like/models/076`、`/077` 作為角色來源（唯讀），修改這兩個模型資料夾時要留意可能影響到那邊。詳見 `C:\Live2DFighter\README.md`。

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `reqw123/question`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.

### Archify（畫圖）

架構圖／流程圖／時序圖／資料流圖／生命週期圖產生工具。指令、適用情境與範例提示字見 `docs/agents/archify.md`。

### Matt Pocock's Skills（工程流程／逼問設計／拆票）

TDD、除錯、程式碼審查、逼問設計、拆票等工程流程 skill 集合。哪些會自動觸發、哪些要手動打指令、正規指令與範例提示字見 `docs/agents/mattpocock-skills.md`。
