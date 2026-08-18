import { describe, expect, it } from 'vitest'
import { DEFENSE_GESTURE, INITIAL_DEFENSE_STATE, STABLE_FRAMES, updateDefenseState, type DefenseState } from './pkDefenseState'

function feed(state: DefenseState, categories: (string | null)[]) {
  let current = state
  const results: boolean[] = []
  for (const category of categories) {
    const result = updateDefenseState(current, category)
    current = result.state
    results.push(result.changed)
  }
  return { state: current, changed: results }
}

describe('updateDefenseState', () => {
  it('連續 STABLE_FRAMES 幀舉起張手才進入防禦狀態', () => {
    const notEnough = feed(INITIAL_DEFENSE_STATE, Array(STABLE_FRAMES - 1).fill(DEFENSE_GESTURE))
    expect(notEnough.state.defending).toBe(false)
    expect(notEnough.changed.every((c) => c === false)).toBe(true)
  })

  it('滿 STABLE_FRAMES 幀後進入防禦狀態，changed 剛好在那一幀是 true', () => {
    const { state, changed } = feed(INITIAL_DEFENSE_STATE, Array(STABLE_FRAMES).fill(DEFENSE_GESTURE))
    expect(state.defending).toBe(true)
    expect(changed.filter(Boolean)).toHaveLength(1)
    expect(changed[STABLE_FRAMES - 1]).toBe(true)
  })

  it('持續舉着不放，defending 維持 true 但不會重複回報 changed', () => {
    const { changed } = feed(INITIAL_DEFENSE_STATE, Array(STABLE_FRAMES + 20).fill(DEFENSE_GESTURE))
    expect(changed.filter(Boolean)).toHaveLength(1)
  })

  it('放下手勢連續 STABLE_FRAMES 幀後，離開防禦狀態也會回報 changed=true', () => {
    const entered = feed(INITIAL_DEFENSE_STATE, Array(STABLE_FRAMES).fill(DEFENSE_GESTURE))
    expect(entered.state.defending).toBe(true)

    const { state, changed } = feed(entered.state, Array(STABLE_FRAMES).fill(null))
    expect(state.defending).toBe(false)
    expect(changed.filter(Boolean)).toHaveLength(1)
    expect(changed[STABLE_FRAMES - 1]).toBe(true)
  })

  it('單幀雜訊不會誤判成離開防禦', () => {
    const entered = feed(INITIAL_DEFENSE_STATE, Array(STABLE_FRAMES).fill(DEFENSE_GESTURE))
    const { state, changed } = feed(entered.state, [null, DEFENSE_GESTURE, DEFENSE_GESTURE])
    expect(state.defending).toBe(true)
    expect(changed.every((c) => c === false)).toBe(true)
  })

  it('進入防禦、離開防禦、再進入防禦，全程只在滿足門檻的三幀各回報一次 changed', () => {
    const categories = [
      ...Array(STABLE_FRAMES).fill(DEFENSE_GESTURE),
      ...Array(STABLE_FRAMES).fill(null),
      ...Array(STABLE_FRAMES).fill(DEFENSE_GESTURE),
    ]
    const { changed } = feed(INITIAL_DEFENSE_STATE, categories)
    expect(changed.filter(Boolean)).toHaveLength(3)
  })

  it('其他手勢分類（例如 Closed_Fist）視同「不是防禦」', () => {
    const entered = feed(INITIAL_DEFENSE_STATE, Array(STABLE_FRAMES).fill(DEFENSE_GESTURE))
    const { state } = feed(entered.state, Array(STABLE_FRAMES).fill('Closed_Fist'))
    expect(state.defending).toBe(false)
  })
})
