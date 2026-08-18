// 防禦手勢（🖐️ Open_Palm）的雙向邊緣偵測狀態機。跟
// aatrox-gesture/gestureTriggerState.ts 用同一種 STABLE_FRAMES 防手震門檻，差別是
// 防禦是持續狀態（舉着才算防禦中，放下就沒有），不是單向的邊緣觸發，所以「進入防禦」
// 跟「離開防禦」兩個方向都要回報「狀態真的改變了」，呼叫端才知道什麼時候該發一次
// pk/input 的 defense 訊息。見 docs/specs/0013、docs/adr/0014「為什麼防禦是持續狀態」。

export const DEFENSE_GESTURE = 'Open_Palm'
export const STABLE_FRAMES = 3

export type DefenseState = {
  defending: boolean
  matchStreak: number
  missStreak: number
}

export const INITIAL_DEFENSE_STATE: DefenseState = { defending: false, matchStreak: 0, missStreak: 0 }

export type DefenseResult = {
  state: DefenseState
  // 這一幀 defending 的值是否真的翻轉了（不管是進入還是離開防禦）——呼叫端只在
  // changed===true 時才需要發 MQTT 訊息，避免每幀都送同樣的狀態灌爆頻道。
  changed: boolean
}

export function updateDefenseState(state: DefenseState, gestureCategory: string | null): DefenseResult {
  const isMatch = gestureCategory === DEFENSE_GESTURE

  if (isMatch) {
    const matchStreak = state.matchStreak + 1
    if (!state.defending && matchStreak >= STABLE_FRAMES) {
      return { state: { defending: true, matchStreak, missStreak: 0 }, changed: true }
    }
    return { state: { defending: state.defending, matchStreak, missStreak: 0 }, changed: false }
  }

  const missStreak = state.missStreak + 1
  if (state.defending && missStreak >= STABLE_FRAMES) {
    return { state: { defending: false, matchStreak: 0, missStreak }, changed: true }
  }
  return { state: { defending: state.defending, matchStreak: 0, missStreak }, changed: false }
}
