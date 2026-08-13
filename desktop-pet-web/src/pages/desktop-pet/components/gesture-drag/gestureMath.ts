// 手勢拖曳的所有純數學邏輯：座標換算＋鏡像、hit-test、hold 進度計時狀態機、拖曳 clamp。
// 刻意跟 GestureDragControl.tsx（碰鏡頭/MediaPipe/rAF 的那一層）分開，這裡全部是
// 不碰瀏覽器 API 的純函式，方便用假座標直接單元測試。見 docs/specs/0010-desktop-pet-web-gesture-drag.md。

export type Point = { x: number; y: number }
export type Size = { width: number; height: number }
export type Box = { x: number; y: number; width: number; height: number }

export function mirrorX(normalizedX: number): number {
  return 1 - normalizedX
}

// 鏡頭畫面用 object-fit: cover 顯示（等比例縮放到「至少填滿」畫布，多出來的部分置中裁切），
// 手指的 normalized landmark 座標要用同一套換算才會跟畫面上看到的位置對齊。
export function videoPointToCanvasPoint(normalized: Point, videoSize: Size, canvasSize: Size): Point {
  const mirroredX = mirrorX(normalized.x)
  const videoX = mirroredX * videoSize.width
  const videoY = normalized.y * videoSize.height

  const scale = Math.max(canvasSize.width / videoSize.width, canvasSize.height / videoSize.height)
  const offsetX = (videoSize.width * scale - canvasSize.width) / 2
  const offsetY = (videoSize.height * scale - canvasSize.height) / 2

  return {
    x: videoX * scale - offsetX,
    y: videoY * scale - offsetY,
  }
}

// 把 measureTightBounds() 量出的框（scale=1 本地座標）換算成模型目前在畫布上的實際矩形。
export function boxOnCanvas(box: Box, scale: number, position: Point): Box {
  return {
    x: position.x + box.x * scale,
    y: position.y + box.y * scale,
    width: box.width * scale,
    height: box.height * scale,
  }
}

export function isPointInBox(point: Point, box: Box): boolean {
  return point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y && point.y <= box.y + box.height
}

export type HoldState = {
  progressMs: number
  selected: boolean
}

export const INITIAL_HOLD_STATE: HoldState = { progressMs: 0, selected: false }

// 停留在框內累積、離開或偵測不到手就歸零重來（不是暫停續接）；一旦 selected 就不再走
// 這個狀態機，交由拖曳/放開邏輯（見 shouldRelease）處理，直到外部把 state 重置回 INITIAL_HOLD_STATE。
export function updateHold(state: HoldState, isInside: boolean, deltaMs: number, holdDurationMs: number): HoldState {
  if (state.selected) return state
  if (!isInside) return { progressMs: 0, selected: false }
  const progressMs = state.progressMs + Math.max(0, deltaMs)
  if (progressMs >= holdDurationMs) return { progressMs: holdDurationMs, selected: true }
  return { progressMs, selected: false }
}

export function computeGrabOffset(fingertipCanvasPos: Point, modelPosition: Point): Point {
  return { x: fingertipCanvasPos.x - modelPosition.x, y: fingertipCanvasPos.y - modelPosition.y }
}

export function dragPosition(fingertipCanvasPos: Point, grabOffset: Point): Point {
  return { x: fingertipCanvasPos.x - grabOffset.x, y: fingertipCanvasPos.y - grabOffset.y }
}

function clampNumber(value: number, boundA: number, boundB: number): number {
  const min = Math.min(boundA, boundB)
  const max = Math.max(boundA, boundB)
  return Math.min(Math.max(value, min), max)
}

// 要求 tightBounds（乘上目前 scale）矩形完全落在畫布 [0,width]x[0,height] 內，超出邊界就夾回邊界上。
// 用 Math.min/max 包住上下界，避免模型本身比畫布大時 min > max 導致 clamp 失效。
export function clampModelPosition(desiredPosition: Point, box: Box, scale: number, canvasSize: Size): Point {
  const scaledWidth = box.width * scale
  const scaledHeight = box.height * scale

  const minX = -box.x * scale
  const maxX = canvasSize.width - scaledWidth - box.x * scale
  const minY = -box.y * scale
  const maxY = canvasSize.height - scaledHeight - box.y * scale

  return {
    x: clampNumber(desiredPosition.x, minX, maxX),
    y: clampNumber(desiredPosition.y, minY, maxY),
  }
}

// MediaPipe GestureRecognizer 內建分類之一，握拳（剪刀石頭布的「石頭」）。
export const RELEASE_GESTURE = 'Closed_Fist'

// 沒偵測到手，或偵測到的最高信心手勢是握拳（石頭）→ 視為放開。
// 選用「石頭」而不是「張開手掌」：張開手掌跟「手指伸直移動中」的自然手型很接近，
// 拖曳途中手指稍微張開就容易誤觸放開；握拳是一個明確、跟「觸碰/拖曳」姿勢差異很大
// 的動作，比較不會跟拖曳過程中的手型混淆。
export function shouldRelease(gestureCategory: string | null, isHandDetected: boolean): boolean {
  return !isHandDetected || gestureCategory === RELEASE_GESTURE
}
