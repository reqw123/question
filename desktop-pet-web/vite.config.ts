import { networkInterfaces } from 'node:os'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Vite 自己印「Network: http://<IP>:5173/」用的就是這個 os.networkInterfaces() 掃出來
// 的位址——這裡用同一招在設定檔（跑在 Node，不是瀏覽器）算一次，透過 define 塞進前端
// 程式碼當一個編譯期常數，PkArenaView.tsx 就不用逼使用者對照終端機輸出手動輸入一次
// （見該檔案 lanIp 的 fallback 邏輯，手動輸入欄位還在，多網卡/偵測錯誤時當覆寫用）。
// 只挑第一個「非內部（不是 loopback）」的 IPv4 位址，多網卡環境可能撿到不是使用者
// 想要的那張卡，這也是保留手動覆寫欄位的原因。
function detectLanIp(): string {
  const interfaces = networkInterfaces()
  for (const addresses of Object.values(interfaces)) {
    for (const addr of addresses ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address
    }
  }
  return ''
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // host:true 讓 dev server 監聽所有網路介面（不是預設只聽 localhost），手勢 PK 對戰
  // 模式的操控端要讓手機連區網 IP 才能加入（見 pk-mode/PkArenaView.tsx），沒有這個
  // 設定的話，就算網址帶對了 IP，連線本身還是會被拒絕。跑 `npm run dev` 之後終端機
  // 會多印一行「Network: http://<你的區網 IP>:5173/」，那就是手機要連的網址。
  server: { host: true },
  // __PK_LAN_IP__ 型別宣告見 src/vite-env.d.ts。這是編譯期常數（dev server 啟動當下
  // 偵測一次），`vite build` 出來的產物一樣會把「打包當下那台機器」的 IP 寫死進去——
  // 這個功能實際的跑法是 `npm run dev`（見 control-center/process-manager.js），不是
  // build 出來的靜態檔案跨機器搬來搬去，這個限制目前不影響實際用法，但如果之後真的
  // 用 build 產物在別台機器上跑，這個寫死的 IP 會是錯的，記得那時候要重新考慮。
  define: {
    __PK_LAN_IP__: JSON.stringify(detectLanIp()),
  },
})
