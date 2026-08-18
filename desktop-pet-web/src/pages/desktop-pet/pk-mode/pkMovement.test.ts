import { describe, expect, it } from 'vitest'
import { ANGLE_DEAD_ZONE, handTiltAngle, mirrorAngle, smoothValue, SMOOTHING_ALPHA, tiltToMoveValue } from './pkMovement'

describe('handTiltAngle', () => {
  it('指尖在指根正上方（沒有左右偏移）是 0 弧度', () => {
    expect(handTiltAngle({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.3 })).toBeCloseTo(0)
  })

  it('指尖在指根右邊（原始鏡頭座標）是正值', () => {
    expect(handTiltAngle({ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.3 })).toBeGreaterThan(0)
  })

  it('指尖在指根左邊（原始鏡頭座標）是負值', () => {
    expect(handTiltAngle({ x: 0.5, y: 0.5 }, { x: 0.4, y: 0.3 })).toBeLessThan(0)
  })
})

describe('mirrorAngle', () => {
  it('翻轉角度正負號', () => {
    expect(mirrorAngle(0.3)).toBeCloseTo(-0.3)
    expect(mirrorAngle(-0.3)).toBeCloseTo(0.3)
    expect(mirrorAngle(0)).toBeCloseTo(0)
  })
})

describe('tiltToMoveValue', () => {
  it('角度為 0 是 0（不移動）', () => {
    expect(tiltToMoveValue(0)).toBe(0)
  })

  it('死區範圍內（左右各 ANGLE_DEAD_ZONE）都是 0', () => {
    expect(tiltToMoveValue(ANGLE_DEAD_ZONE - 0.01)).toBe(0)
    expect(tiltToMoveValue(-(ANGLE_DEAD_ZONE - 0.01))).toBe(0)
  })

  it('正角度（右傾）是正值（前進）', () => {
    expect(tiltToMoveValue(0.3)).toBeGreaterThan(0)
  })

  it('負角度（左傾）是負值（後退）', () => {
    expect(tiltToMoveValue(-0.3)).toBeLessThan(0)
  })

  it('超過 ANGLE_MAX_TILT 的角度，數值 clamp 在 ±1', () => {
    expect(tiltToMoveValue(10)).toBeCloseTo(1)
    expect(tiltToMoveValue(-10)).toBeCloseTo(-1)
  })

  it('剛好在死區邊界外一點點，數值接近 0', () => {
    const justOutside = tiltToMoveValue(ANGLE_DEAD_ZONE + 0.001)
    expect(justOutside).toBeGreaterThan(0)
    expect(justOutside).toBeLessThan(0.05)
  })
})

describe('smoothValue', () => {
  it('沒有歷史值（null）時直接採用這一幀的原始值，不平滑', () => {
    expect(smoothValue(null, 0.3)).toBe(0.3)
  })

  it('有歷史值時，往新值的方向移動，但不會一步到位（有平滑）', () => {
    const next = smoothValue(0.1, 0.5, SMOOTHING_ALPHA)
    expect(next).toBeGreaterThan(0.1)
    expect(next).toBeLessThan(0.5)
  })

  it('連續餵同一個值，平滑後的結果會收斂到那個值', () => {
    let smoothed: number | null = 0
    for (let i = 0; i < 50; i++) smoothed = smoothValue(smoothed, 0.4, SMOOTHING_ALPHA)
    expect(smoothed).toBeCloseTo(0.4, 2)
  })

  it('單幀雜訊（角度已回正後，某一幀突然跳一個值）不會讓平滑值整個跳過去', () => {
    const noisy = smoothValue(0, 0.4, SMOOTHING_ALPHA)
    expect(Math.abs(noisy - 0)).toBeLessThan(Math.abs(noisy - 0.4))
  })

  it('alpha 越小平滑效果越強（同一次跳動，結果離舊值更近）', () => {
    const lowAlpha = smoothValue(0, 0.4, 0.1)
    const highAlpha = smoothValue(0, 0.4, 0.8)
    expect(Math.abs(lowAlpha - 0)).toBeLessThan(Math.abs(highAlpha - 0))
  })
})
