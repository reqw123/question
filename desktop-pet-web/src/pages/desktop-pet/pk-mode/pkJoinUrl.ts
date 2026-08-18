// 操控端加入網址的組法，跟 multi/host.html 的 buildPlayerUrl() 是同一個問題、同一種
// 解法：瀏覽器裡的 JS 沒有辦法可靠地知道「自己這台機器的區網 IP」是什麼（沒有對應的
// 標準 Web API），host.html 的做法是讓主持人自己在設定欄位手動輸入一次自己的 IP，
// location.hostname 是 localhost/127.0.0.1 時才用這個手動輸入的 IP 替換——如果原本
// 開啟的網址本來就是用區網 IP 訪問的（例如手機自己也連得到那個位址），直接沿用
// hostname 就好，不需要額外輸入。純函式，方便單元測試，不碰 window。

// 操控端固定走這個路徑（不是原本的 ?role=controller query string）——2026-08-18
// 使用者實測時忘記手動輸入 ?role=controller 導致連錯頁面，短路徑打字/辨識都不容易漏，
// App.tsx 用 window.location.pathname === PK_CONTROLLER_PATH 判斷，不是解析 query
// string。這個專案沒有正式的 router（見 App.tsx 開頭說明），純路徑比對就夠用。
export const PK_CONTROLLER_PATH = '/pk'

export type BuildJoinUrlParams = {
  protocol: string
  hostname: string
  port: string
  lanIp: string // 使用者手動輸入的區網 IP，hostname 不是 localhost/127.0.0.1 時用不到
}

// hostname 是 localhost/127.0.0.1 又沒有 lanIp 可以替換時回傳 null——呼叫端用這個
// 判斷「還不能顯示加入網址/QR code，要先請使用者輸入自己的區網 IP」。
export function buildJoinUrl(params: BuildJoinUrlParams): string | null {
  let host = params.hostname
  if (host === 'localhost' || host === '127.0.0.1') {
    const trimmed = params.lanIp.trim()
    if (!trimmed) return null
    host = trimmed
  }
  const portSuffix = params.port ? `:${params.port}` : ''
  return `${params.protocol}//${host}${portSuffix}${PK_CONTROLLER_PATH}`
}
