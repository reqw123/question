// 跟 multi/multiplay.js 的 mpMqttUrl() 同一條規則：
//   http://  → 區網直連  ws://IP:9001         （直接連 Mosquitto）
//   https:// → 公網模式  wss://hostname/mqtt   （經 Caddy 反向代理，路徑 /mqtt）
// 這裡是純函式（吃 location 相關的值當參數，不直接讀 window.location），方便單元測試。
export function pkMqttUrl(hostname: string, protocol: string, wsPort: number): string {
  if (protocol === 'https:') return `wss://${hostname}/mqtt`
  return `ws://${hostname}:${wsPort}`
}
