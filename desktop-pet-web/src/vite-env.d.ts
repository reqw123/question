/// <reference types="vite/client" />

// vite.config.ts 的 define 注入的編譯期常數：dev server 啟動當下偵測到的區網 IPv4
// 位址（沒偵測到就是空字串）。見 vite.config.ts 的 detectLanIp()、
// pk-mode/PkArenaView.tsx 的 lanIp 初始值 fallback。
declare const __PK_LAN_IP__: string
