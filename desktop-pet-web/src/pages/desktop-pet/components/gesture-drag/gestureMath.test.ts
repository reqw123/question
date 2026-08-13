import { describe, expect, it } from 'vitest'
import {
  boxOnCanvas,
  clampModelPosition,
  computeGrabOffset,
  dragPosition,
  INITIAL_HOLD_STATE,
  isPointInBox,
  mirrorX,
  RELEASE_GESTURE,
  shouldRelease,
  updateHold,
  videoPointToCanvasPoint,
} from './gestureMath'

describe('mirrorX', () => {
  it('鏡像左右座標', () => {
    expect(mirrorX(0)).toBe(1)
    expect(mirrorX(1)).toBe(0)
    expect(mirrorX(0.3)).toBeCloseTo(0.7)
  })
})

describe('videoPointToCanvasPoint', () => {
  it('相同長寬比時直接等比例縮放，不裁切', () => {
    const point = videoPointToCanvasPoint({ x: 0.25, y: 0.5 }, { width: 640, height: 480 }, { width: 320, height: 240 })
    // 鏡像後 x' = 0.75，等比例縮放到一半尺寸
    expect(point.x).toBeCloseTo(0.75 * 320)
    expect(point.y).toBeCloseTo(0.5 * 240)
  })

  it('畫布比鏡頭寬（cover 會裁掉上下）時，畫面中心點仍對應畫布中心', () => {
    const point = videoPointToCanvasPoint({ x: 0.5, y: 0.5 }, { width: 640, height: 480 }, { width: 640, height: 200 })
    expect(point.x).toBeCloseTo(320)
    expect(point.y).toBeCloseTo(100)
  })

  it('畫布比鏡頭窄（cover 會裁掉左右）時，畫面中心點仍對應畫布中心', () => {
    const point = videoPointToCanvasPoint({ x: 0.5, y: 0.5 }, { width: 640, height: 480 }, { width: 200, height: 480 })
    expect(point.x).toBeCloseTo(100)
    expect(point.y).toBeCloseTo(240)
  })
})

describe('boxOnCanvas / isPointInBox', () => {
  const box = { x: 10, y: 20, width: 100, height: 200 }

  it('依 scale/position 換算出畫布上的矩形', () => {
    const onCanvas = boxOnCanvas(box, 2, { x: 50, y: 50 })
    expect(onCanvas).toEqual({ x: 70, y: 90, width: 200, height: 400 })
  })

  it('框內的點判定為 true，框外為 false', () => {
    const onCanvas = boxOnCanvas(box, 1, { x: 0, y: 0 })
    expect(isPointInBox({ x: 10, y: 20 }, onCanvas)).toBe(true)
    expect(isPointInBox({ x: 110, y: 220 }, onCanvas)).toBe(true)
    expect(isPointInBox({ x: 9, y: 20 }, onCanvas)).toBe(false)
    expect(isPointInBox({ x: 111, y: 20 }, onCanvas)).toBe(false)
  })
})

describe('updateHold', () => {
  const DURATION = 2000

  it('框內累積進度', () => {
    let state = updateHold(INITIAL_HOLD_STATE, true, 500, DURATION)
    expect(state).toEqual({ progressMs: 500, selected: false })
    state = updateHold(state, true, 500, DURATION)
    expect(state).toEqual({ progressMs: 1000, selected: false })
  })

  it('離開框內立即歸零，不是暫停續接', () => {
    const held = updateHold(INITIAL_HOLD_STATE, true, 1500, DURATION)
    const left = updateHold(held, false, 100, DURATION)
    expect(left).toEqual({ progressMs: 0, selected: false })
  })

  it('累積滿 duration 進入 selected', () => {
    const state = updateHold(INITIAL_HOLD_STATE, true, 2500, DURATION)
    expect(state).toEqual({ progressMs: DURATION, selected: true })
  })

  it('已經 selected 時不再變動，即使回傳 isInside=false', () => {
    const selected = { progressMs: DURATION, selected: true }
    expect(updateHold(selected, false, 1000, DURATION)).toBe(selected)
  })
})

describe('grab offset / drag position', () => {
  it('抓取時記錄相對位移，拖曳時保留這個相對位移', () => {
    const grabOffset = computeGrabOffset({ x: 120, y: 80 }, { x: 100, y: 50 })
    expect(grabOffset).toEqual({ x: 20, y: 30 })
    const nextPos = dragPosition({ x: 150, y: 200 }, grabOffset)
    expect(nextPos).toEqual({ x: 130, y: 170 })
  })
})

describe('clampModelPosition', () => {
  const box = { x: 0, y: 0, width: 100, height: 100 }
  const canvasSize = { width: 300, height: 300 }

  it('框內位置原樣保留', () => {
    const pos = clampModelPosition({ x: 100, y: 100 }, box, 1, canvasSize)
    expect(pos).toEqual({ x: 100, y: 100 })
  })

  it('超出右下邊界會被夾回邊界上', () => {
    const pos = clampModelPosition({ x: 1000, y: 1000 }, box, 1, canvasSize)
    expect(pos).toEqual({ x: 200, y: 200 })
  })

  it('超出左上邊界會被夾回 0', () => {
    const pos = clampModelPosition({ x: -500, y: -500 }, box, 1, canvasSize)
    expect(pos.x).toBeCloseTo(0)
    expect(pos.y).toBeCloseTo(0)
  })

  it('box 有非零偏移量時也正確 clamp', () => {
    const offsetBox = { x: 20, y: 30, width: 50, height: 50 }
    const pos = clampModelPosition({ x: 1000, y: 1000 }, offsetBox, 1, canvasSize)
    // position + box.x*scale + box.width*scale <= canvasWidth
    expect(pos.x).toBeCloseTo(300 - 50 - 20)
    expect(pos.y).toBeCloseTo(300 - 50 - 30)
  })

  it('模型比畫布大時仍回傳有限值，不會 min > max 出錯', () => {
    const bigBox = { x: 0, y: 0, width: 500, height: 500 }
    const pos = clampModelPosition({ x: 9999, y: 9999 }, bigBox, 1, canvasSize)
    expect(Number.isFinite(pos.x)).toBe(true)
    expect(Number.isFinite(pos.y)).toBe(true)
  })
})

describe('shouldRelease', () => {
  it('偵測不到手就放開', () => {
    expect(shouldRelease(null, false)).toBe(true)
  })

  it('比出石頭（Closed_Fist）就放開', () => {
    expect(shouldRelease(RELEASE_GESTURE, true)).toBe(true)
    expect(shouldRelease('Closed_Fist', true)).toBe(true)
  })

  it('其他手勢或分類不放開', () => {
    expect(shouldRelease('Open_Palm', true)).toBe(false)
    expect(shouldRelease(null, true)).toBe(false)
  })
})
