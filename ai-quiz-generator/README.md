# ai-quiz-generator/

`multi/`（多人搶答網頁遊戲）的題庫生成工具，用 AI（OpenAI 或本機 Ollama）依教材/主題產生選擇題，再匯出成 `multi/questions/*.json` 讀得懂的格式。不是獨立專案，是 `multi/` 的內容製作輔助工具。

- 頁面上「← 返回遊戲主控台」連回 `multi/host.html`
- 生成完題庫後可以「下載 JSON」存檔，或「直接匯入遊戲系統」讓 `multi/host.html` 立即讀取
- 純前端單一 `index.html`，沒有 `package.json`／建置流程，直接雙擊或用靜態伺服器開啟即可
