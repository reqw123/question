// 手勢 PK 對戰模式的比賽狀態機，擂台端（PkArenaView）專用。純函式，不碰 MQTT/three.js，
// 方便直接用假的輸入序列單元測試命中判定/血量/勝負/離線這些核心規則。見
// docs/specs/0013-desktop-pet-web-gesture-pk-mode.md、docs/adr/0014。
//
// PkArenaState 是擂台端內部維護的「完整權威狀態」，比 pkProtocol.ts 的 PkMatchState
// 多了 lastHeartbeatAt（離線判定用）跟 resumePhase（離線時記住要恢復到哪個階段）這些
// 不需要發布給操控端的內部欄位——toWireState() 負責把它精簡成真正要發布到 pk/state
// 的 payload。

import {
  ATTACK_DAMAGE,
  COUNTDOWN_SECONDS,
  HP_MAX,
  type PkInputMessage,
  type PkMatchState,
  type PkPhase,
  type PlayerSlot,
} from './pkProtocol'

export type PkArenaPlayerState = {
  playerId: string
  connected: boolean
  hp: number
  defending: boolean
  lastHeartbeatAt: number
}

export type PkArenaState = {
  phase: PkPhase
  countdown?: number
  player1: PkArenaPlayerState | null
  player2: PkArenaPlayerState | null
  winner?: PlayerSlot
  // 離線發生時記住要恢復到 'countdown'（重新從頭倒數，避免偷跑）還是 'battle'
  // （直接恢復戰鬥），見 docs/specs/0013「心跳與離線判定」。
  resumePhase?: 'countdown' | 'battle'
}

export const INITIAL_ARENA_STATE: PkArenaState = { phase: 'waiting', player1: null, player2: null }

function opponentSlot(slot: PlayerSlot): PlayerSlot {
  return slot === 'player1' ? 'player2' : 'player1'
}

// 匯出給 PkArenaView.tsx 用——收到 pk/input 訊息時，攻擊/跳躍這類不進狀態機的視覺
// 效果（見 applyInput 對 'jump' 的處理）也需要知道這則訊息是哪個玩家送的，才能決定要
// 在畫面上讓哪個角色播動畫。
export function slotForPlayerId(state: PkArenaState, playerId: string): PlayerSlot | null {
  if (state.player1?.playerId === playerId) return 'player1'
  if (state.player2?.playerId === playerId) return 'player2'
  return null
}

// 兩位玩家都已連線（不論目前 connected 是否為 true——重連時 slot 還在，只是 connected
// 曾經被標記 false）才算「湊齊了」，可以開始倒數/恢復比賽。
function bothSlotsFilled(state: PkArenaState): boolean {
  return state.player1 !== null && state.player2 !== null
}

function bothConnected(state: PkArenaState): boolean {
  return state.player1?.connected === true && state.player2?.connected === true
}

// 兩人都連上時，依目前 phase 決定要不要（重新）開始倒數：'waiting' 第一次湊齊、或
// 'paused' 時兩人都回來了，都要重新從 COUNTDOWN_SECONDS 開始（'paused' 不會恢復成
// 'battle' 而不倒數——即使離線發生在戰鬥中，重新連線也一律重新倒數，避免其中一秒偷跑，
// 跟 spec 「離線發生在倒數階段」那句的精神一致，兩種情況統一處理不用分岔）。
function maybeStartCountdown(state: PkArenaState): PkArenaState {
  if (!bothSlotsFilled(state) || !bothConnected(state)) return state
  if (state.phase !== 'waiting' && state.phase !== 'paused') return state
  return { ...state, phase: 'countdown', countdown: COUNTDOWN_SECONDS, resumePhase: undefined }
}

// targetSlot 是呼叫端指定「這次 join 應該要塞進哪個 slot」，不是「先到先贏、看哪個
// slot 空就填哪個」——2026-08-18 修正的真實 bug：原本用「哪個 slot 空就填哪個」的
// 邏輯，如果玩家二（遠端 MQTT join）的訊息剛好搶在玩家一（擂台端本人，本機直接呼叫）
// 之前抵達，玩家二就會被誤塞進 player1（Aatrox）的位置，等玩家一終於 join 時
// player1 已經被占走，反而自己變成 player2（Mordekaiser）——跟操作者的直覺完全相反
// （擂台端操作者理所當然預期自己永遠是玩家一）。現在呼叫端明確指定要塞哪個 slot
// （`PkArenaView.tsx` 的本機呼叫永遠傳 `'player1'`、MQTT `pk/join` 收到的訊息永遠傳
// `'player2'`），跟訊息到達順序完全無關，見 docs/adr/0014。
export function applyJoin(state: PkArenaState, playerId: string, now: number, targetSlot: PlayerSlot): PkArenaState {
  const existingSlot = slotForPlayerId(state, playerId)
  if (existingSlot) {
    const player = state[existingSlot]!
    const next: PkArenaState = {
      ...state,
      [existingSlot]: { ...player, connected: true, lastHeartbeatAt: now },
    }
    return maybeStartCountdown(next)
  }

  if (state[targetSlot] !== null) {
    // 目標 slot 已經被別人占走了（例如兩支手機都想當玩家二）——忽略，等同這場已經滿了
    // （見 docs/specs/0013 Edge Cases「第三個以上的裝置加入」）。
    return state
  }
  const freshPlayer: PkArenaPlayerState = { playerId, connected: true, hp: HP_MAX, defending: false, lastHeartbeatAt: now }
  return maybeStartCountdown({ ...state, [targetSlot]: freshPlayer })
}

export function applyHeartbeat(state: PkArenaState, playerId: string, defending: boolean, now: number): PkArenaState {
  const slot = slotForPlayerId(state, playerId)
  if (!slot) return state
  const player = state[slot]!
  const next: PkArenaState = {
    ...state,
    [slot]: { ...player, connected: true, defending, lastHeartbeatAt: now },
  }
  return maybeStartCountdown(next)
}

// 每隔一段時間（跟 OFFLINE_MS 同一個輪詢頻率即可）呼叫一次，檢查是否有玩家心跳逾時。
export function markOffline(state: PkArenaState, now: number, offlineMs: number): PkArenaState {
  let next = state
  let anyNewlyOffline = false

  for (const slot of ['player1', 'player2'] as const) {
    const player = next[slot]
    if (!player || !player.connected) continue
    if (now - player.lastHeartbeatAt <= offlineMs) continue
    next = { ...next, [slot]: { ...player, connected: false } }
    anyNewlyOffline = true
  }

  if (!anyNewlyOffline) return next
  if (next.phase === 'battle' || next.phase === 'countdown') {
    return { ...next, phase: 'paused', countdown: undefined, resumePhase: next.phase === 'countdown' ? 'countdown' : 'battle' }
  }
  return next
}

// 單人測試模式：只有玩家一（擂台端本人）就緒、玩家二還沒加入時，讓主持人可以跳過
// 等待，直接進入 battle 階段自行測試鏡頭/手勢辨識/移動/攻擊動畫——不用真的找第二支
// 手機連線才能確認手勢有沒有正常運作。刻意跳過 countdown（除錯用途不需要儀式感的
// 倒數）。玩家二欄位維持 null：applyInput() 對著空 target 的攻擊會直接 no-op（見其
// `if (!target) return state`），不會出錯也不會誤判勝負；玩家二之後真的加入時，
// applyJoin() 照樣把她塞進 player2，直接加入這場已經在打的 battle（不會重新倒數，
// maybeStartCountdown() 只在 'waiting'/'paused' 才觸發）。
export function startSoloBattle(state: PkArenaState): PkArenaState {
  if (state.phase !== 'waiting' || !state.player1 || state.player2) return state
  return { ...state, phase: 'battle', countdown: undefined, resumePhase: undefined }
}

export function tickCountdown(state: PkArenaState): PkArenaState {
  if (state.phase !== 'countdown' || state.countdown === undefined) return state
  const nextCount = state.countdown - 1
  if (nextCount <= 0) return { ...state, phase: 'battle', countdown: undefined }
  return { ...state, countdown: nextCount }
}

// 「再來一局」：只能在 finished 階段按，血量/防禦狀態重置，但**沿用原本的玩家身分／
// 連線**——不用重新掃 QR code、不用重新走一次 join 流程，這是使用者要求「再來一局」
// 的核心價值（跟整場重來不同，整場重來是重新整理擂台端頁面，見 Edge Cases）。兩人都
// 還連線中的話，maybeStartCountdown() 會直接接手轉成 'countdown'，體感上就是「按一下
// 馬上重新倒數開打」；如果有人斷線了，維持 'waiting'，等重新連上會自動接續（跟一般
// 離線恢復流程共用同一套邏輯，不需要另外處理)。
export function resetMatch(state: PkArenaState, now: number): PkArenaState {
  if (state.phase !== 'finished') return state
  const resetPlayer = (player: PkArenaPlayerState | null): PkArenaPlayerState | null =>
    player ? { ...player, hp: HP_MAX, defending: false, lastHeartbeatAt: now } : null
  const next: PkArenaState = {
    phase: 'waiting',
    player1: resetPlayer(state.player1),
    player2: resetPlayer(state.player2),
    winner: undefined,
    countdown: undefined,
    resumePhase: undefined,
  }
  return maybeStartCountdown(next)
}

// 命中判定＋血量／勝負：攻擊事件送達時檢查「對方當下是否在防禦」，是→格擋（不扣血），
// 不是→命中扣血，血量歸零即分出勝負。跳躍不影響比賽狀態（純視覺位移，見
// docs/specs/0013「手勢輸入與命中判定」），防禦訊息單純更新對應玩家的 defending 欄位。
export function applyInput(state: PkArenaState, message: PkInputMessage, now: number): PkArenaState {
  if (state.phase !== 'battle') return state // 倒數/等待/暫停/已結束期間，手勢事件一律忽略

  const slot = slotForPlayerId(state, message.playerId)
  if (!slot) return state

  if (message.type === 'defense') {
    const player = state[slot]!
    return { ...state, [slot]: { ...player, defending: message.defending, lastHeartbeatAt: now } }
  }

  if (message.type === 'jump' || message.type === 'move') return state // 純視覺效果，由 PkArenaView 自己處理，不進狀態機

  // type === 'attack'
  const targetSlot = opponentSlot(slot)
  const target = state[targetSlot]
  if (!target) return state
  if (target.defending) return state // 格擋成功，攻擊無效

  const nextHp = Math.max(0, target.hp - ATTACK_DAMAGE)
  const nextState: PkArenaState = { ...state, [targetSlot]: { ...target, hp: nextHp } }
  if (nextHp <= 0) {
    return { ...nextState, phase: 'finished', winner: slot }
  }
  return nextState
}

function toWirePlayer(player: PkArenaPlayerState | null) {
  if (!player) return null
  return { playerId: player.playerId, connected: player.connected, hp: player.hp, defending: player.defending }
}

// 擂台端內部的 PkArenaState 精簡成真正要發布到 pk/state 的 payload——去掉
// lastHeartbeatAt／resumePhase 這些操控端不需要知道的內部記帳欄位。
export function toWireState(state: PkArenaState): PkMatchState {
  return {
    phase: state.phase,
    countdown: state.countdown,
    player1: toWirePlayer(state.player1),
    player2: toWirePlayer(state.player2),
    winner: state.winner,
  }
}
