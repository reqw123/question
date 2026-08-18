// 手勢動作觸發的邊緣觸發＋防手震狀態機。純函式，不碰 MediaPipe/three.js，方便用假的
// 手勢分類序列直接單元測試。見 docs/specs/0012-desktop-pet-web-gesture-action-trigger.md、
// docs/adr/0013-desktop-pet-web-gesture-action-trigger-scope.md。

// MediaPipe GestureRecognizer 內建分類之一，比讚。
export const TRIGGER_GESTURE = 'Thumb_Up'

// 連續幾幀分類結果一致，才視為「狀態真的改變」（觸發或重置都套用同一個門檻）。單幀
// 雜訊（例如 Thumb_Up 中間閃一幀 None 又跳回來）不會被誤判成「使用者放開又比了一次」
// 而重複觸發，見 docs/specs/0012 Implementation Decisions「邊緣觸發的防手震処理」。
export const STABLE_FRAMES = 3

export type TriggerState = {
  // 是否處於「可以再次觸發」的狀態。true＝上一次穩定判定不是 TRIGGER_GESTURE，比一次
  // 👍 就會觸發；false＝已經觸發過，要等偵測結果穩定轉回「不是 TRIGGER_GESTURE」才會
  // 重新變成 true，這是邊緣觸發的核心（比着不放不會重複觸發）。
  armed: boolean
  matchStreak: number
  missStreak: number
}

export const INITIAL_TRIGGER_STATE: TriggerState = { armed: true, matchStreak: 0, missStreak: 0 }

export type TriggerResult = { state: TriggerState; fired: boolean }

// 每一幀呼叫一次。gestureCategory 是這一幀 MediaPipe 回報的最高信心分類名稱（沒偵測到
// 手，或偵測到手但沒有對應到任何內建分類時傳 null）。回傳新的 state 跟這一幀是否應該
// 觸發（fired === true 時，呼叫端執行一次動作；同一次「比着不放」的過程只會有一次
// fired === true）。
export function updateTriggerState(state: TriggerState, gestureCategory: string | null): TriggerResult {
  const isMatch = gestureCategory === TRIGGER_GESTURE

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
