# 「網頁摘要」只做貼網址＋後端抓取，不做瀏覽器自動操作

原始需求用「Browser Use」描述這個功能，這個詞通常指 AI agent 直接操控瀏覽器（點擊、輸入、跳轉）。探索後確認整個 repo 沒有任何 `browser-use`/`playwright`/`puppeteer`/`selenium` 相關程式碼，這是全新功能，範圍需要明確界定。決定 v1 只做「使用者在即時對話貼網址 → 程式自動偵測 → 後端 fetch 該網址內容 → 交給 AI 摘要」，純唯讀、不模擬使用者操作瀏覽器，也不做瀏覽器擴充套件或內嵌 `BrowserView` 去讀取使用者「正在看」的分頁。這個範圍界定改稱「網頁摘要（Page Digest）」，刻意不再用「Browser Use」這個詞（見 CONTEXT.md），避免未來被誤解成要做 agent 操控瀏覽器。
