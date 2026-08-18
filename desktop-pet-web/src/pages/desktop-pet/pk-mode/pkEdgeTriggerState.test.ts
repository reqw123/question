import { describe, expect, it } from 'vitest'
import { INITIAL_EDGE_TRIGGER_STATE, STABLE_FRAMES, updateEdgeTriggerState, type EdgeTriggerState } from './pkEdgeTriggerState'

function feed(state: EdgeTriggerState, categories: (string | null)[], target: string) {
  let current = state
  const fired: boolean[] = []
  for (const category of categories) {
    const result = updateEdgeTriggerState(current, category, target)
    current = result.state
    fired.push(result.fired)
  }
  return { state: current, fired }
}

describe('updateEdgeTriggerState', () => {
  it('滿 STABLE_FRAMES 幀比對目標手勢，剛好在那一幀觸發一次', () => {
    const { fired } = feed(INITIAL_EDGE_TRIGGER_STATE, Array(STABLE_FRAMES).fill('Closed_Fist'), 'Closed_Fist')
    expect(fired.filter(Boolean)).toHaveLength(1)
    expect(fired[STABLE_FRAMES - 1]).toBe(true)
  })

  it('不同的目標手勢字串可以獨立運作，攻擊用的狀態不會被跳躍手勢觸發', () => {
    const { fired } = feed(INITIAL_EDGE_TRIGGER_STATE, Array(STABLE_FRAMES).fill('Victory'), 'Closed_Fist')
    expect(fired.every((f) => f === false)).toBe(true)
  })

  it('比着不放不會重複觸發，放開再比一次才能再次觸發', () => {
    const first = feed(INITIAL_EDGE_TRIGGER_STATE, Array(STABLE_FRAMES + 5).fill('Victory'), 'Victory')
    expect(first.fired.filter(Boolean)).toHaveLength(1)

    const released = feed(first.state, Array(STABLE_FRAMES).fill(null), 'Victory')
    expect(released.state.armed).toBe(true)

    const second = feed(released.state, Array(STABLE_FRAMES).fill('Victory'), 'Victory')
    expect(second.fired.filter(Boolean)).toHaveLength(1)
  })

  it('攻擊(Closed_Fist)跟跳躍(Victory)兩個獨立狀態機同時餵同一幀分類，只有對應的那個會觸發', () => {
    const categories = Array(STABLE_FRAMES).fill('Closed_Fist')
    const attack = feed(INITIAL_EDGE_TRIGGER_STATE, categories, 'Closed_Fist')
    const jump = feed(INITIAL_EDGE_TRIGGER_STATE, categories, 'Victory')
    expect(attack.fired.filter(Boolean)).toHaveLength(1)
    expect(jump.fired.every((f) => f === false)).toBe(true)
  })
})
