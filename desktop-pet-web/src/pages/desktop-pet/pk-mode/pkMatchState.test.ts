import { describe, expect, it } from 'vitest'
import { ATTACK_DAMAGE, COUNTDOWN_SECONDS, HP_MAX, OFFLINE_MS } from './pkProtocol'
import { applyHeartbeat, applyInput, applyJoin, INITIAL_ARENA_STATE, markOffline, resetMatch, startSoloBattle, tickCountdown, toWireState, type PkArenaState } from './pkMatchState'

const T0 = 1_000_000

describe('applyJoin', () => {
  it('第一個加入的是 player1，第二個是 player2', () => {
    let state = applyJoin(INITIAL_ARENA_STATE, 'p1', T0, 'player1')
    expect(state.player1?.playerId).toBe('p1')
    expect(state.player2).toBeNull()
    expect(state.phase).toBe('waiting')

    state = applyJoin(state, 'p2', T0 + 100, 'player2')
    expect(state.player2?.playerId).toBe('p2')
  })

  it('兩人都加入後自動進入倒數', () => {
    let state = applyJoin(INITIAL_ARENA_STATE, 'p1', T0, 'player1')
    state = applyJoin(state, 'p2', T0 + 100, 'player2')
    expect(state.phase).toBe('countdown')
    expect(state.countdown).toBe(COUNTDOWN_SECONDS)
  })

  it('新加入的玩家血量是滿血，且雙方 slot 都填滿前不進倒數', () => {
    const state = applyJoin(INITIAL_ARENA_STATE, 'p1', T0, 'player1')
    expect(state.player1?.hp).toBe(HP_MAX)
    expect(state.phase).toBe('waiting')
  })

  it('第三個以上的裝置加入被忽略', () => {
    let state = applyJoin(INITIAL_ARENA_STATE, 'p1', T0, 'player1')
    state = applyJoin(state, 'p2', T0 + 100, 'player2')
    const before = state
    state = applyJoin(state, 'p3', T0 + 200, 'player2')
    expect(state).toEqual(before)
  })

  it('同一個 playerId 重新 join 視為重連，不會佔用另一個 slot', () => {
    let state = applyJoin(INITIAL_ARENA_STATE, 'p1', T0, 'player1')
    state = applyJoin(state, 'p1', T0 + 500, 'player1')
    expect(state.player2).toBeNull()
    expect(state.player1?.playerId).toBe('p1')
  })

  // 2026-08-18 修的真實 bug：以前 applyJoin 沒有 targetSlot 參數，是「哪個 slot 空就填
  // 哪個」，如果玩家二（遠端 MQTT join）比玩家一（擂台端本人，本機直接呼叫）先抵達，
  // 玩家二會被誤塞進 player1，等玩家一終於 join 時 player1 已經被占走，反而自己變成
  // player2——這幾個測試鎖住「不管到達順序如何，targetSlot 說了算」這個規則。
  it('玩家二（player2）比玩家一（player1）先 join，也不會占走 player1 的位置', () => {
    let state = applyJoin(INITIAL_ARENA_STATE, 'remote-p2', T0, 'player2')
    expect(state.player2?.playerId).toBe('remote-p2')
    expect(state.player1).toBeNull()

    state = applyJoin(state, 'local-host', T0 + 100, 'player1')
    expect(state.player1?.playerId).toBe('local-host')
    expect(state.player2?.playerId).toBe('remote-p2')
    expect(state.phase).toBe('countdown')
  })

  it('目標 slot 已經被別人占走時忽略這次 join（不會覆蓋掉既有玩家）', () => {
    let state = applyJoin(INITIAL_ARENA_STATE, 'p2-a', T0, 'player2')
    const before = state
    state = applyJoin(state, 'p2-b', T0 + 100, 'player2')
    expect(state).toEqual(before)
    expect(state.player2?.playerId).toBe('p2-a')
  })
})

describe('tickCountdown', () => {
  it('倒數到 0 之後轉成 battle', () => {
    let state = applyJoin(INITIAL_ARENA_STATE, 'p1', T0, 'player1')
    state = applyJoin(state, 'p2', T0, 'player2')
    expect(state.countdown).toBe(COUNTDOWN_SECONDS)
    for (let i = 0; i < COUNTDOWN_SECONDS; i++) state = tickCountdown(state)
    expect(state.phase).toBe('battle')
    expect(state.countdown).toBeUndefined()
  })

  it('不是 countdown 階段時呼叫不會有任何變化', () => {
    const state = tickCountdown(INITIAL_ARENA_STATE)
    expect(state).toEqual(INITIAL_ARENA_STATE)
  })
})

function startBattle(): PkArenaState {
  let state = applyJoin(INITIAL_ARENA_STATE, 'p1', T0, 'player1')
  state = applyJoin(state, 'p2', T0, 'player2')
  for (let i = 0; i < COUNTDOWN_SECONDS; i++) state = tickCountdown(state)
  return state
}

describe('applyInput', () => {
  it('倒數/等待階段的攻擊事件會被忽略', () => {
    const waiting = applyJoin(INITIAL_ARENA_STATE, 'p1', T0, 'player1')
    const afterAttack = applyInput(waiting, { playerId: 'p1', type: 'attack' }, T0)
    expect(afterAttack).toEqual(waiting)
  })

  it('沒有格擋時攻擊命中，對方扣血', () => {
    const battle = startBattle()
    const next = applyInput(battle, { playerId: 'p1', type: 'attack' }, T0)
    expect(next.player2?.hp).toBe(HP_MAX - ATTACK_DAMAGE)
    expect(next.player1?.hp).toBe(HP_MAX)
  })

  it('對方正在防禦時攻擊被格擋，不扣血', () => {
    let battle = startBattle()
    battle = applyInput(battle, { playerId: 'p2', type: 'defense', defending: true }, T0)
    const next = applyInput(battle, { playerId: 'p1', type: 'attack' }, T0)
    expect(next.player2?.hp).toBe(HP_MAX)
  })

  it('防禦訊息只更新 defending 欄位，不影響血量', () => {
    const battle = startBattle()
    const next = applyInput(battle, { playerId: 'p1', type: 'defense', defending: true }, T0)
    expect(next.player1?.defending).toBe(true)
    expect(next.player1?.hp).toBe(HP_MAX)
  })

  it('跳躍事件不改變比賽狀態', () => {
    const battle = startBattle()
    const next = applyInput(battle, { playerId: 'p1', type: 'jump' }, T0)
    expect(next).toEqual(battle)
  })

  it('移動事件不改變比賽狀態（純視覺位移，跟跳躍同一種處理）', () => {
    const battle = startBattle()
    const next = applyInput(battle, { playerId: 'p1', type: 'move', value: 0.5 }, T0)
    expect(next).toEqual(battle)
  })

  it('血量歸零時分出勝負', () => {
    let battle = startBattle()
    const hits = Math.ceil(HP_MAX / ATTACK_DAMAGE)
    for (let i = 0; i < hits; i++) {
      battle = applyInput(battle, { playerId: 'p1', type: 'attack' }, T0)
    }
    expect(battle.player2?.hp).toBe(0)
    expect(battle.phase).toBe('finished')
    expect(battle.winner).toBe('player1')
  })

  it('已經 finished 之後的攻擊事件不再改變狀態', () => {
    let battle = startBattle()
    const hits = Math.ceil(HP_MAX / ATTACK_DAMAGE)
    for (let i = 0; i < hits; i++) battle = applyInput(battle, { playerId: 'p1', type: 'attack' }, T0)
    const finished = battle
    battle = applyInput(battle, { playerId: 'p1', type: 'attack' }, T0)
    expect(battle).toEqual(finished)
  })
})

describe('applyHeartbeat', () => {
  it('心跳更新連線狀態跟 defending（保底同步）', () => {
    const battle = startBattle()
    const next = applyHeartbeat(battle, 'p2', true, T0 + 1000)
    expect(next.player2?.defending).toBe(true)
    expect(next.player2?.connected).toBe(true)
  })

  it('不認得的 playerId 心跳不影響狀態', () => {
    const battle = startBattle()
    const next = applyHeartbeat(battle, 'unknown', true, T0 + 1000)
    expect(next).toEqual(battle)
  })
})

describe('markOffline', () => {
  it('超過 OFFLINE_MS 沒心跳的玩家被標記離線，戰鬥中會暫停', () => {
    const battle = startBattle()
    const next = markOffline(battle, T0 + OFFLINE_MS + 1, OFFLINE_MS)
    expect(next.player1?.connected).toBe(false)
    expect(next.player2?.connected).toBe(false)
    expect(next.phase).toBe('paused')
    expect(next.resumePhase).toBe('battle')
  })

  it('倒數中離線，resumePhase 記成 countdown', () => {
    let state = applyJoin(INITIAL_ARENA_STATE, 'p1', T0, 'player1')
    state = applyJoin(state, 'p2', T0, 'player2')
    expect(state.phase).toBe('countdown')
    const next = markOffline(state, T0 + OFFLINE_MS + 1, OFFLINE_MS)
    expect(next.phase).toBe('paused')
    expect(next.resumePhase).toBe('countdown')
  })

  it('心跳都還在門檻內，不會被標記離線', () => {
    const battle = startBattle()
    const next = markOffline(battle, T0 + OFFLINE_MS - 1, OFFLINE_MS)
    expect(next).toEqual(battle)
  })

  it('離線後重新 join，兩人都連線時重新從頭倒數', () => {
    let battle = startBattle()
    battle = markOffline(battle, T0 + OFFLINE_MS + 1, OFFLINE_MS)
    expect(battle.phase).toBe('paused')

    battle = applyJoin(battle, 'p1', T0 + OFFLINE_MS + 2000, 'player1')
    expect(battle.phase).toBe('paused') // 還有一位玩家沒回來

    battle = applyJoin(battle, 'p2', T0 + OFFLINE_MS + 2500, 'player2')
    expect(battle.phase).toBe('countdown')
    expect(battle.countdown).toBe(COUNTDOWN_SECONDS)
  })

  it('離線後用心跳重連（不是重新 join）也能恢復', () => {
    let battle = startBattle()
    battle = markOffline(battle, T0 + OFFLINE_MS + 1, OFFLINE_MS)
    battle = applyHeartbeat(battle, 'p1', false, T0 + OFFLINE_MS + 2000)
    expect(battle.phase).toBe('paused')
    battle = applyHeartbeat(battle, 'p2', false, T0 + OFFLINE_MS + 2500)
    expect(battle.phase).toBe('countdown')
  })
})

function finishBattle(): PkArenaState {
  let battle = startBattle()
  const hits = Math.ceil(HP_MAX / ATTACK_DAMAGE)
  for (let i = 0; i < hits; i++) battle = applyInput(battle, { playerId: 'p1', type: 'attack' }, T0)
  return battle
}

describe('resetMatch', () => {
  it('不是 finished 階段時呼叫不會有任何變化', () => {
    const battle = startBattle()
    expect(resetMatch(battle, T0)).toEqual(battle)
  })

  it('finished 階段重置血量/防禦，兩人都還連線時直接重新進入倒數', () => {
    const finished = finishBattle()
    const next = resetMatch(finished, T0 + 5000)
    expect(next.phase).toBe('countdown')
    expect(next.countdown).toBe(COUNTDOWN_SECONDS)
    expect(next.player1?.hp).toBe(HP_MAX)
    expect(next.player2?.hp).toBe(HP_MAX)
    expect(next.winner).toBeUndefined()
  })

  it('沿用原本的玩家身分，不用重新 join', () => {
    const finished = finishBattle()
    const next = resetMatch(finished, T0 + 5000)
    expect(next.player1?.playerId).toBe('p1')
    expect(next.player2?.playerId).toBe('p2')
  })

  it('其中一方已離線，重置後停在 waiting，等對方重新連線才會倒數', () => {
    let finished = finishBattle()
    // markOffline 只有戰鬥中/倒數中才會轉成 paused，finished 階段離線只是標記
    // connected=false，phase 維持 finished。
    finished = markOffline(finished, T0 + OFFLINE_MS + 1, OFFLINE_MS)
    expect(finished.phase).toBe('finished')
    const next = resetMatch(finished, T0 + OFFLINE_MS + 5000)
    expect(next.phase).toBe('waiting')
  })

  it('重置後再打完一場，一樣可以正常分出勝負（狀態機沒有殘留舊資料）', () => {
    const finished = finishBattle()
    let rematch = resetMatch(finished, T0 + 5000)
    for (let i = 0; i < COUNTDOWN_SECONDS; i++) rematch = tickCountdown(rematch)
    expect(rematch.phase).toBe('battle')
    const hits = Math.ceil(HP_MAX / ATTACK_DAMAGE)
    for (let i = 0; i < hits; i++) rematch = applyInput(rematch, { playerId: 'p2', type: 'attack' }, T0)
    expect(rematch.phase).toBe('finished')
    expect(rematch.winner).toBe('player2')
  })
})

describe('startSoloBattle', () => {
  it('只有玩家一就緒、玩家二還沒加入時，直接進入 battle，不經過 countdown', () => {
    const state = applyJoin(INITIAL_ARENA_STATE, 'p1', T0, 'player1')
    const next = startSoloBattle(state)
    expect(next.phase).toBe('battle')
    expect(next.countdown).toBeUndefined()
    expect(next.player2).toBeNull()
  })

  it('玩家一都還沒 join 時呼叫不會有任何變化', () => {
    expect(startSoloBattle(INITIAL_ARENA_STATE)).toEqual(INITIAL_ARENA_STATE)
  })

  it('玩家二已經加入時呼叫不會有任何變化（不是單人情境）', () => {
    let state = applyJoin(INITIAL_ARENA_STATE, 'p1', T0, 'player1')
    state = applyJoin(state, 'p2', T0 + 100, 'player2')
    expect(startSoloBattle(state)).toEqual(state)
  })

  it('已經在 battle/其他階段時呼叫不會有任何變化', () => {
    const battle = startBattle()
    expect(startSoloBattle(battle)).toEqual(battle)
  })

  it('進入單人測試模式後，手勢輸入（攻擊）不會出錯，也不會誤判勝負（沒有對手）', () => {
    const state = applyJoin(INITIAL_ARENA_STATE, 'p1', T0, 'player1')
    const solo = startSoloBattle(state)
    const next = applyInput(solo, { playerId: 'p1', type: 'attack' }, T0)
    expect(next.phase).toBe('battle')
    expect(next.winner).toBeUndefined()
  })

  it('單人測試模式中玩家二真的加入，直接併入這場 battle，不重新倒數', () => {
    const state = applyJoin(INITIAL_ARENA_STATE, 'p1', T0, 'player1')
    const solo = startSoloBattle(state)
    const next = applyJoin(solo, 'p2', T0 + 100, 'player2')
    expect(next.phase).toBe('battle')
    expect(next.player2?.playerId).toBe('p2')
    expect(next.player2?.hp).toBe(HP_MAX)
  })
})

describe('toWireState', () => {
  it('去掉 lastHeartbeatAt／resumePhase 等內部欄位', () => {
    const battle = startBattle()
    const wire = toWireState(battle)
    expect(wire.player1).not.toHaveProperty('lastHeartbeatAt')
    expect(wire.player1).toEqual({ playerId: 'p1', connected: true, hp: HP_MAX, defending: false })
    expect(wire).not.toHaveProperty('resumePhase')
  })

  it('null 玩家原樣保留 null', () => {
    const wire = toWireState(INITIAL_ARENA_STATE)
    expect(wire.player1).toBeNull()
    expect(wire.player2).toBeNull()
  })
})
