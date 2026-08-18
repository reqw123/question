// 攻擊／跳躍手勢的邊緣觸發狀態機——跟 aatrox-gesture/gestureTriggerState.ts 是同一種
// STABLE_FRAMES 防手震邏輯，這裡另外寫一份（不是改成參數化去共用那個檔案）是刻意的：
// gestureTriggerState.ts 是「手勢動作觸發」（docs/specs/0012）這個已經上線功能的一部分，
// 寫死比讚（Thumb_Up）是那份 spec/ADR 明確記錄的決定，PK 模式需要用不同手勢（Closed_Fist
// 攻擊、Victory 跳躍）觸發不同效果，不想為了這裡的需求去動一個已經定案、有自己 ADR 的
// 模組、冒著影響既有功能的風險——量體很小（20 行不到），重寫一份風險更低。見
// docs/specs/0013、docs/adr/0014。

export const STABLE_FRAMES = 3

export type EdgeTriggerState = {
  armed: boolean
  matchStreak: number
  missStreak: number
}

export const INITIAL_EDGE_TRIGGER_STATE: EdgeTriggerState = { armed: true, matchStreak: 0, missStreak: 0 }

export type EdgeTriggerResult = { state: EdgeTriggerState; fired: boolean }

// targetGesture 是呼叫端指定要偵測的手勢分類名稱（例如 'Closed_Fist'／'Victory'），跟
// gestureTriggerState.ts 的 TRIGGER_GESTURE 寫死常數不同，這裡是參數，讓同一份邏輯可以
// 同時餵給攻擊/跳躍兩個獨立的狀態實例。
export function updateEdgeTriggerState(
  state: EdgeTriggerState,
  gestureCategory: string | null,
  targetGesture: string,
): EdgeTriggerResult {
  const isMatch = gestureCategory === targetGesture

  if (isMatch) {
    const matchStreak = state.matchStreak + 1
    if (state.armed && matchStreak >= STABLE_FRAMES) {
      return { state: { armed: false, matchStreak, missStreak: 0 }, fired: true }
    }
    return { state: { armed: state.armed, matchStreak, missStreak: 0 }, fired: false }
  }

  const missStreak = state.missStreak + 1
  if (!state.armed && missStreak >= STABLE_FRAMES) {
    return { state: { armed: true, matchStreak: 0, missStreak }, fired: false }
  }
  return { state: { armed: state.armed, matchStreak: 0, missStreak }, fired: false }
}
