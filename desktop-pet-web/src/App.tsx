import { DesktopPetPage } from './pages/desktop-pet/DesktopPetPage'
import { PkControllerView } from './pages/desktop-pet/pk-mode/PkControllerView'
import { PK_CONTROLLER_PATH } from './pages/desktop-pet/pk-mode/pkJoinUrl'

// 手勢 PK 對戰模式的操控端是完全獨立的一頁：玩家手機開同一個網址、路徑換成
// PK_CONTROLLER_PATH（/pk，見 pkJoinUrl.ts——2026-08-18 從 ?role=controller 這種
// query string 改成短路徑，實測有使用者手動輸入網址時漏打 query string 導致連錯頁面，
// 短路徑打字/念出來都不容易漏）就會看到操控頁，不是擂台端（見 docs/specs/0013、
// docs/adr/0014「為什麼是一個擂台端＋兩支遙控器」）。擂台端本身是從 DesktopPetPage
// 內部（Aatrox3DShowcase 按鈕）切換過去的，不經過這裡的路徑判斷——那是同一台裝置上的
// 「原地切換全螢幕」，不是另開一頁。這個專案沒有正式的 router，純路徑字串比對就夠用
// （見 CLAUDE.md／control-center 相關文件對這個專案技術棧的既有說明）。
function App() {
  if (window.location.pathname === PK_CONTROLLER_PATH) return <PkControllerView />
  return <DesktopPetPage />
}

export default App
