import { describe, expect, it } from 'vitest'
import { INITIAL_TRIGGER_STATE, STABLE_FRAMES, TRIGGER_GESTURE, updateTriggerState, type TriggerState } from './gestureTriggerState'

function feed(state: TriggerState, categories: (string | null)[]) {
  let current = state
  const fired: boolean[] = []
  for (const category of categories) {
    const result = updateTriggerState(current, category)
    current = result.state
    fired.push(result.fired)
  }
  return { state: current, fired }
}

describe('updateTriggerState', () => {
  it('連續 STABLE_FRAMES 幀比讚才觸發，不是一偵測到就觸發', () => {
    const categories = Array(STABLE_FRAMES - 1).fill(TRIGGER_GESTURE)
    const { fired } = feed(INITIAL_TRIGGER_STATE, categories)
    expect(fired.every((f) => f === false)).toBe(true)
  })

  it('滿 STABLE_FRAMES 幀比讚，剛好在那一幀觸發一次', () => {
    const categories = Array(STABLE_FRAMES).fill(TRIGGER_GESTURE)
    const { fired } = feed(INITIAL_TRIGGER_STATE, categories)
    expect(fired.filter(Boolean)).toHaveLength(1)
    expect(fired[STABLE_FRAMES - 1]).toBe(true)
  })

  it('比着不放（持續穩定偵測到比讚）不會重複觸發', () => {
    const categories = Array(STABLE_FRAMES + 20).fill(TRIGGER_GESTURE)
    const { fired } = feed(INITIAL_TRIGGER_STATE, categories)
    expect(fired.filter(Boolean)).toHaveLength(1)
  })

  it('單幀雜訊（比讚中間閃一幀 None 又跳回來）不會被誤判成重新觸發', () => {
    // 比讚、比讚、雜訊一幀 None、比讚、比讚…：missStreak 沒有連續累積到 STABLE_FRAMES，
    // 不足以讓 armed 重置回 true，後面繼續比讚不該再觸發第二次。
    const categories = [TRIGGER_GESTURE, TRIGGER_GESTURE, TRIGGER_GESTURE, null, TRIGGER_GESTURE, TRIGGER_GESTURE, TRIGGER_GESTURE]
    const { fired } = feed(INITIAL_TRIGGER_STATE, categories)
    expect(fired.filter(Boolean)).toHaveLength(1)
  })

  it('放開後穩定 STABLE_FRAMES 幀偵測不到比讚，才能再次觸發', () => {
    const firstTrigger = Array(STABLE_FRAMES).fill(TRIGGER_GESTURE)
    const notEnoughRelease = Array(STABLE_FRAMES - 1).fill(null)
    const stillNotArmed = feed(INITIAL_TRIGGER_STATE, [...firstTrigger, ...notEnoughRelease])
    expect(stillNotArmed.state.armed).toBe(false)

    const enoughRelease = [null]
    const rearmed = feed(stillNotArmed.state, enoughRelease)
    expect(rearmed.state.armed).toBe(true)

    const secondTrigger = Array(STABLE_FRAMES).fill(TRIGGER_GESTURE)
    const { fired } = feed(rearmed.state, secondTrigger)
    expect(fired.filter(Boolean)).toHaveLength(1)
  })

  it('沒偵測到手（null）視同「不是比讚」，不會觸發也不會累積 matchStreak', () => {
    const { state, fired } = feed(INITIAL_TRIGGER_STATE, [null, null, null])
    expect(fired.every((f) => f === false)).toBe(true)
    expect(state.matchStreak).toBe(0)
  })

  it('其他手勢分類（例如 Closed_Fist）不會觸發', () => {
    const categories = Array(STABLE_FRAMES + 2).fill('Closed_Fist')
    const { fired } = feed(INITIAL_TRIGGER_STATE, categories)
    expect(fired.every((f) => f === false)).toBe(true)
  })

  it('連續觸發＋放開＋再觸發，全程只在滿足門檻的那兩幀各觸發一次', () => {
    const categories = [
      ...Array(STABLE_FRAMES).fill(TRIGGER_GESTURE),
      ...Array(STABLE_FRAMES).fill(null),
      ...Array(STABLE_FRAMES).fill(TRIGGER_GESTURE),
    ]
    const { fired } = feed(INITIAL_TRIGGER_STATE, categories)
    expect(fired.filter(Boolean)).toHaveLength(2)
  })
})
