// 手勢 PK 對戰模式的 MQTT topic／payload 型別定義。跟 multi/multiplay.js 的 MP_TOPICS
// 同一種寫法，但走獨立的 pk/* 命名空間，不會跟 multi/ 既有的 quiz/multi/* 撞名，兩套
// 系統可以同時獨立運作。見 docs/specs/0013-desktop-pet-web-gesture-pk-mode.md、
// docs/adr/0014-desktop-pet-web-gesture-pk-mode-scope.md。

export const PK_TOPICS = {
  JOIN: 'pk/join', // controller → arena
  STATE: 'pk/state', // arena → all (retained)
  INPUT: 'pk/input', // controller → arena
  HEARTBEAT: 'pk/heartbeat', // controller → arena
} as const

// 玩家一（擂台端本人）固定用這個 playerId，不像玩家二需要 crypto/Math.random 產生
// ——擂台端頁面重新整理就等於整場比賽重來，不需要跨次持久化識別身分（見
// docs/specs/0013 Edge Cases）。原本只有 PkArenaView.tsx 自己用，2026-08-18 搬到這裡
// 變成共用常數：操控端（PkControllerView.tsx）新增「同步看擂台端畫面」的 WebRTC 視訊
// 之後，也需要知道「擂台端的訊令收件位址」才能把 offer/answer/ice 送給正確的對象，
// 見下面 PK_WEBRTC_SIGNAL_PREFIX。
export const LOCAL_PLAYER_ID = 'local-host'

// 擂台端畫面同步給操控端看的 WebRTC 視訊——訊令（offer/answer/ice）走 MQTT，格式/
// 架構直接沿用 multi/VoiceBroadcastModule.js 已經驗證過的做法（SIG_PREFIX + 目標
// playerId 當作那個人的訊令信箱，雙向都是「發給對方的信箱」），差別只在 PK 模式
// 這裡永遠只有一個廣播者（擂台端）＋一個觀眾（玩家二），不需要 voice 那套多對多的
// _outPeers/_inPeers 字典管理，量體小很多。見 docs/specs/0013、docs/adr/0014。
export const PK_WEBRTC_SIGNAL_PREFIX = 'pk/webrtc/signal/' // + 目標 playerId

// 跟 multi/multiplay.js 的 MP_CFG.VOICE_ICE_SERVERS 同一顆公開 STUN server，不用另外
// 申請/架設。同一個區網內兩台裝置通常連 STUN 都用不太到（瀏覽器會先嘗試區網內直連的
// host candidate），這裡只是保底。
export const WEBRTC_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]

// 訊令（signaling）payload——跟 VoiceBroadcastModule.js 的 _onSignal() 判斷邏輯是同一
// 套 type 分類，只是 PK 模式這裡只有視訊沒有語音、只有一個固定的廣播者/觀眾配對，
// 用 from 標明是誰送的（PK_WEBRTC_SIGNAL_PREFIX 只決定「收件人」，訊息本身還是要
// 知道寄件人才知道要建立/操作哪一條 peer connection）。
export type PkWebrtcSignalMessage =
  | { from: string; type: 'pull' } // 操控端（重新）請求擂台端畫面，見 docs/specs/0013「畫面同步」
  | { from: string; type: 'offer'; sdp: RTCSessionDescriptionInit }
  | { from: string; type: 'answer'; sdp: RTCSessionDescriptionInit }
  | { from: string; type: 'ice'; candidate: RTCIceCandidateInit }

// 跟 multi/multiplay.js 的 MP_CFG.HEARTBEAT_MS／OFFLINE_MS 同一組數字，不重新發明
// 一套門檻（見 ADR-0014）。
export const HEARTBEAT_MS = 3000
export const OFFLINE_MS = 10000
export const COUNTDOWN_SECONDS = 3
// 2026-08-18：使用者要求「將雙方血量乘3倍」，從 100 調到 300——單純拉長對戰時間，
// ATTACK_DAMAGE 沒有跟著變，命中判定/防禦/攻擊距離都不受影響。
export const HP_MAX = 300
export const ATTACK_DAMAGE = 20
// 命中判定現在要求距離夠近（見 docs/adr/0014 修訂記錄「攻擊改成需要距離夠近」）——
// 這個常數是「角色身高的倍數」，實際換算成世界座標的公尺數在 PkArenaView.tsx 依
// 兩個角色實際載入後的身高各自算一次，不是寫死的絕對距離（模型大小不保證一致）。
export const ATTACK_RANGE_HEIGHT_RATIO = 0.9

export type PlayerSlot = 'player1' | 'player2'

export type PkJoinMessage = {
  playerId: string
}

// 邊緣觸發的單次事件（攻擊/跳躍）、持續狀態變化（防禦）、連續數值（移動）合併成同一個
// topic 的 union payload——都是「玩家輸入」，共用同一個 topic 比較單純，擂台端訂閱
// 一個 topic 就能收到所有輸入事件，用 type 欄位分派處理。
export type PkInputMessage =
  | { playerId: string; type: 'attack' | 'jump' }
  | { playerId: string; type: 'defense'; defending: boolean }
  // 手在鏡頭畫面裡的左右位置連續控制前進/後退（見 pkMovement.ts），value 是
  // -1..1：正值前進（靠近對手）、負值後退（遠離對手）、0 不動。跟攻擊/跳躍/防禦
  // 不同，這個純粹是視覺位置效果，不進 pkMatchState.ts 的比賽狀態機（跟 'jump' 同一種
  // 處理方式），只在擂台端本機直接套用到對應角色的 3D 位置。
  | { playerId: string; type: 'move'; value: number }

// defending 是保底同步用（見 docs/specs/0013「訊息協定」段落）：就算某一次 pk/input 的
// defense 事件因為網路問題沒送到，最多 HEARTBEAT_MS 後下一次心跳就會自我修正。
export type PkHeartbeatMessage = {
  playerId: string
  defending: boolean
}

export type PkPhase = 'waiting' | 'countdown' | 'battle' | 'paused' | 'finished'

export type PkPlayerState = {
  playerId: string
  connected: boolean
  hp: number
  defending: boolean
}

export type PkMatchState = {
  phase: PkPhase
  countdown?: number
  player1: PkPlayerState | null
  player2: PkPlayerState | null
  winner?: PlayerSlot
}

export const INITIAL_MATCH_STATE: PkMatchState = {
  phase: 'waiting',
  player1: null,
  player2: null,
}
