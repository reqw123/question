import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../../../lib/utils'
import type { ActiveModelHandle } from '../HeroLive2DStage'
import {
  boxOnCanvas,
  clampModelPosition,
  computeGrabOffset,
  dragPosition,
  INITIAL_HOLD_STATE,
  isPointInBox,
  shouldRelease,
  updateHold,
  videoPointToCanvasPoint,
  type HoldState,
} from './gestureMath'

const HOLD_DURATION_MS = 2000
const WASM_BASE_URL = '/mediapipe/wasm'
const MODEL_ASSET_PATH = '/mediapipe/models/gesture_recognizer.task'
const CAP_MESSAGE_DURATION_MS = 2500

// MediaPipe Hands 官方 21 點骨架的連線拓樸，純繪圖用的靜態資料，跟手勢判斷邏輯無關。
const HAND_CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
]

type Status = 'idle' | 'requesting' | 'active' | 'error'
type Selection = { grabOffset: { x: number; y: number } }

function buildRecognizerOptions(delegate: 'GPU' | 'CPU') {
  return {
    baseOptions: { modelAssetPath: MODEL_ASSET_PATH, delegate },
    runningMode: 'VIDEO' as const,
    numHands: 1,
  }
}

// 2026-08-18：補上實際錯誤名稱/訊息＋多分幾種常見情境，理由跟
// aatrox-gesture/AatroxGestureTrigger.tsx 的 describeError() 一樣（PK 對戰模式開發時
// 實測發現外接 USB 攝影機常見失敗方式不是「權限被拒絕」，是 NotReadableError/
// OverconstrainedError，只給單一句籠統文案會誤導使用者去檢查錯的地方）。
function describeError(err: unknown): string {
  // navigator.mediaDevices 整個不存在：這台裝置沒問題，是這個頁面不是 secure context。
  // 這個功能通常在跟 dev server 同一台機器上使用，最直接的解法是改用
  // http://localhost:<port>（不要用區網 IP）開啟這個頁面。
  if (err instanceof Error && err.message === 'insecure-context') {
    return '手勢拖曳目前無法使用：這個網址不是安全來源（secure context），請改用 http://localhost:<port>（不要用區網 IP）重新開啟這個頁面再試一次'
  }
  const detail = err instanceof DOMException ? `${err.name}${err.message ? `：${err.message}` : ''}` : String(err)
  if (err instanceof DOMException && err.name === 'NotAllowedError') {
    return `手勢功能目前無法使用：鏡頭權限被拒絕（${detail}）`
  }
  if (err instanceof DOMException && (err.name === 'NotReadableError' || err.name === 'TrackStartError')) {
    return `手勢功能目前無法使用：鏡頭被另一個程式占用中（${detail}），關掉其他正在用鏡頭的程式後再試一次`
  }
  if (err instanceof DOMException && (err.name === 'NotFoundError' || err.name === 'OverconstrainedError')) {
    return `手勢功能目前無法使用：找不到符合條件的鏡頭（${detail}）`
  }
  return `手勢功能目前無法使用（${detail}），請確認瀏覽器支援鏡頭存取後再試一次`
}

// 獨立於 HeroLive2DStage 之外的平行元件：拿到目前顯示中模型的 handle 之後直接讀寫
// handle.model.position，HeroLive2DStage 完全不知道「手勢」這個概念存在。見
// docs/specs/0010-desktop-pet-web-gesture-drag.md、docs/adr/0011。
//
// **2026-08-10 改版**：整個 Hero 區塊改用單一共用 PIXI 畫布後，這個元件不再需要「卡片
// 本地 vs Hero 本地」兩套座標系互相換算——handle.getCanvasSize() 永遠回傳同一塊共用
// 畫布的大小，clamp/hit-test 全部只在這一種座標系裡算，「有沒有逃出過卡片」現在只是
// handle.markEscaped() 這個一次性旗標（同不同意這個模型可以被拖），不影響座標系本身。
// canvasHost：Hero.tsx 提供、蓋住整個 Hero 區塊的容器，用來把準心/選定邊框畫布 portal
// 上去，跟 HeroLive2DStage 掛真正 PIXI canvas 的容器是同一個節點。
export function GestureDragControl({
  handle,
  canvasHost,
}: {
  handle: ActiveModelHandle | null
  canvasHost?: HTMLElement | null
}) {
  const [enabled, setEnabled] = useState(false)
  const [status, setStatus] = useState<Status>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [capMessage, setCapMessage] = useState<string | null>(null)
  const [isSelected, setIsSelected] = useState(false)

  const videoRef = useRef<HTMLVideoElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const cursorRef = useRef<HTMLCanvasElement>(null)
  const handleRef = useRef<ActiveModelHandle | null>(handle)
  const holdRef = useRef<HoldState>(INITIAL_HOLD_STATE)
  const selectionRef = useRef<Selection | null>(null)
  // 型別故意寫死 number（不是 ReturnType<typeof setTimeout>）：這個專案新增 mqtt 依賴
  // 後它間接拉進 @types/node 全域宣告，會讓 ReturnType<typeof setTimeout> 誤判成
  // NodeJS.Timeout，見 Aatrox3DShowcase.tsx／HeroLive2DStage.tsx 同樣的說明。
  const capMessageTimerRef = useRef<number | null>(null)

  // 切換輪播卡片時 HeroLive2DStage 會呼叫 onActiveModelChange(null)，這裡跟著清掉選定/
  // hold 狀態——這就是「切卡片自動清空手勢拖曳狀態」的完整實作，不需要監聽卡片切換事件。
  useEffect(() => {
    handleRef.current = handle
    if (!handle) {
      holdRef.current = INITIAL_HOLD_STATE
      selectionRef.current = null
      setIsSelected(false)
    }
  }, [handle])

  useEffect(() => {
    return () => {
      if (capMessageTimerRef.current) window.clearTimeout(capMessageTimerRef.current)
    }
  }, [])

  function showCapMessage() {
    setCapMessage('已達同時可拖出的角色上限，請先把其中一個放回背景')
    if (capMessageTimerRef.current) window.clearTimeout(capMessageTimerRef.current)
    // window.setTimeout()（不是裸的 setTimeout()）：新增 mqtt 依賴後裸的全域 setTimeout
    // 呼叫點解析會誤判成 NodeJS.Timeout（跟上面 capMessageTimerRef 型別寫死 number
    // 同一個成因），透過 window. 明確指定瀏覽器版本就會回到正確的 number。
    capMessageTimerRef.current = window.setTimeout(() => setCapMessage(null), CAP_MESSAGE_DURATION_MS)
  }

  useEffect(() => {
    if (!enabled) return
    // videoRef 掛的 <video> 元素只在 enabled=true 期間存在（見下方 JSX），跟這個 effect
    // 同一個生命週期一起出現/消失，這裡一次性抓出來，setup/loop/cleanup 都用同一個
    // 參照，不要在 cleanup 裡才去讀 videoRef.current——那時 React 可能已經把 ref 清空。
    const videoElOrNull = videoRef.current
    if (!videoElOrNull) return
    // TS 的窄化在巢狀 function 宣告（loop/setup/cleanup）裡不會延續，另外指派一個明確
    // 型別（非 null）的 const 給它們捕捉，避免每處都要再判斷一次 null。
    const videoEl: HTMLVideoElement = videoElOrNull

    let destroyed = false
    let stream: MediaStream | null = null
    let recognizer: any = null
    let rafId = 0
    let lastFrameTime: number | null = null

    function drawOverlay(video: HTMLVideoElement, landmarks: { x: number; y: number }[] | null) {
      const canvas = overlayRef.current
      const ctx = canvas?.getContext('2d')
      if (!canvas || !ctx) return
      if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      if (!landmarks) return

      // 這裡直接用未鏡像的 landmark 座標畫，畫布本身跟 <video> 一起用 CSS scaleX(-1)
      // 鏡像顯示，兩者同步翻轉，骨架自然對齊鏡頭畫面，不需要在畫圖這層另外做鏡像運算。
      const toPixel = (p: { x: number; y: number }) => ({ x: p.x * canvas.width, y: p.y * canvas.height })

      ctx.strokeStyle = 'rgba(167,139,250,0.9)'
      ctx.lineWidth = Math.max(2, canvas.width * 0.004)
      for (const [a, b] of HAND_CONNECTIONS) {
        const pa = toPixel(landmarks[a])
        const pb = toPixel(landmarks[b])
        ctx.beginPath()
        ctx.moveTo(pa.x, pa.y)
        ctx.lineTo(pb.x, pb.y)
        ctx.stroke()
      }
      ctx.fillStyle = 'rgba(236,72,153,0.9)'
      for (const lm of landmarks) {
        const p = toPixel(lm)
        ctx.beginPath()
        ctx.arc(p.x, p.y, Math.max(2, canvas.width * 0.006), 0, Math.PI * 2)
        ctx.fill()
      }

      const tip = toPixel(landmarks[8])
      const radius = Math.max(10, canvas.width * 0.03)
      if (selectionRef.current) {
        ctx.beginPath()
        ctx.arc(tip.x, tip.y, radius, 0, Math.PI * 2)
        ctx.strokeStyle = 'rgba(34,197,94,0.95)'
        ctx.lineWidth = Math.max(3, canvas.width * 0.006)
        ctx.stroke()
      } else if (holdRef.current.progressMs > 0) {
        const ratio = holdRef.current.progressMs / HOLD_DURATION_MS
        ctx.beginPath()
        ctx.arc(tip.x, tip.y, radius, -Math.PI / 2, -Math.PI / 2 + ratio * Math.PI * 2)
        ctx.strokeStyle = 'rgba(167,139,250,0.95)'
        ctx.lineWidth = Math.max(3, canvas.width * 0.006)
        ctx.stroke()
      }
    }

    function clearCanvas(ref: React.RefObject<HTMLCanvasElement | null>) {
      const canvas = ref.current
      const ctx = canvas?.getContext('2d')
      if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height)
    }

    // 半徑刻意用固定像素、不跟著畫布寬度縮放——共用畫布現在蓋住整個 Hero 區塊（比卡片
    // 寬很多），準心只需要小小一顆看得到、不擋視線，不需要跟畫布大小成比例。
    const CURSOR_RADIUS = 11
    // 呼吸感的脈動光暈：純固定大小的圈太不顯眼，加一圈半徑/透明度隨時間週期變化的
    // 外圈，讓準心在畫面上更容易一眼看到，同時不影響底圈/中心點原本的精確定位用途。
    const PULSE_PERIOD_MS = 1100
    // 掃描式外環轉速：4 條刻度弧線繞著準心慢慢轉，像相機對焦框一樣有「正在追蹤」的感覺。
    const SCAN_PERIOD_MS = 2400

    // 準心本身是疊在角色插畫上面的，插畫顏色深淺不定（淺色肌膚、深色布料都有可能），
    // 純白或純色線條在某些底色上會整個糊掉、看起來像「準心被角色蓋住」——實際上是
    // 對比不夠，不是疊層順序錯了（cursor canvas 在 DOM 上確實排在 PIXI 畫布後面，
    // 且用 position:absolute，本來就會畫在最上層）。這裡改成先描一層深色外框
    // （outline）當底，再疊主色線條，不管背景是深是淺都有足夠對比度，是這次「更有
    // 特色的準心特效」的核心手法，不是單純加特效。
    function strokeWithOutline(ctx: CanvasRenderingContext2D, path: () => void, color: string, lineWidth: number) {
      path()
      ctx.strokeStyle = 'rgba(15,15,20,0.55)'
      ctx.lineWidth = lineWidth + 2.5
      ctx.stroke()
      path()
      ctx.strokeStyle = color
      ctx.lineWidth = lineWidth
      ctx.stroke()
    }

    function drawCursor(
      canvasRef: React.RefObject<HTMLCanvasElement | null>,
      size: { width: number; height: number },
      point: { x: number; y: number },
      holdRatio: number,
      selected: boolean,
      now: number,
    ) {
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      if (!canvas || !ctx) return
      const w = Math.round(size.width)
      const h = Math.round(size.height)
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      const color = selected ? 'rgba(52,211,153,0.95)' : 'rgba(255,255,255,0.95)'
      const pulseColor = selected ? 'rgba(52,211,153,%a)' : 'rgba(167,139,250,%a)'

      // 脈動外圈：半徑從 CURSOR_RADIUS 擴散到 ~2.2 倍，同時淡出，週期性重來。
      const pulsePhase = (now % PULSE_PERIOD_MS) / PULSE_PERIOD_MS
      const pulseRadius = CURSOR_RADIUS + pulsePhase * CURSOR_RADIUS * 1.2
      const pulseAlpha = (1 - pulsePhase) * 0.55
      ctx.beginPath()
      ctx.arc(point.x, point.y, pulseRadius, 0, Math.PI * 2)
      ctx.strokeStyle = pulseColor.replace('%a', pulseAlpha.toFixed(3))
      ctx.lineWidth = 2
      ctx.stroke()

      // 掃描外環：4 段短弧繞著準心慢慢轉，未選定時用來強化「這是一個持續追蹤中的
      // 目標框」的視覺語言；選定之後改用 drawSelectionBorder() 沿角色外框跑動的
      // 閃電效果取代，這裡就不再畫，避免兩種動畫互相搶注意力。
      if (!selected) {
        const scanAngle = ((now % SCAN_PERIOD_MS) / SCAN_PERIOD_MS) * Math.PI * 2
        const scanRadius = CURSOR_RADIUS + 6
        for (let i = 0; i < 4; i++) {
          const a0 = scanAngle + (i * Math.PI) / 2
          const a1 = a0 + Math.PI / 8
          strokeWithOutline(
            ctx,
            () => {
              ctx.beginPath()
              ctx.arc(point.x, point.y, scanRadius, a0, a1)
            },
            'rgba(167,139,250,0.85)',
            2,
          )
        }
      }

      // 中心小圓點（帶深色外框，確保在任何底色上都清楚可辨）
      ctx.beginPath()
      ctx.arc(point.x, point.y, 3, 0, Math.PI * 2)
      ctx.fillStyle = 'rgba(15,15,20,0.55)'
      ctx.fill()
      ctx.beginPath()
      ctx.arc(point.x, point.y, 2, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()

      // 底圈：選定時變成跟中心點同色、稍微亮一點，加深色外框確保對比度
      strokeWithOutline(
        ctx,
        () => {
          ctx.beginPath()
          ctx.arc(point.x, point.y, CURSOR_RADIUS, 0, Math.PI * 2)
        },
        selected ? color : 'rgba(255,255,255,0.55)',
        1.5,
      )

      // hold 進度：沿著底圈畫弧，選定之後就不再需要（改用底圈本身變色表示）
      if (!selected && holdRatio > 0) {
        strokeWithOutline(
          ctx,
          () => {
            ctx.beginPath()
            ctx.arc(point.x, point.y, CURSOR_RADIUS, -Math.PI / 2, -Math.PI / 2 + holdRatio * Math.PI * 2)
          },
          'rgba(167,139,250,0.95)',
          2.5,
        )
      }
    }

    // 矩形邊框上，走過的弧長比例 t（[0,1)，從左上角開始順時針）對應到的座標點。
    function pointOnRectPerimeter(box: { x: number; y: number; width: number; height: number }, t: number) {
      const { x, y, width: w, height: h } = box
      const perimeter = 2 * (w + h)
      let d = ((t % 1) + 1) % 1 * perimeter
      if (d < w) return { x: x + d, y }
      d -= w
      if (d < h) return { x: x + w, y: y + d }
      d -= h
      if (d < w) return { x: x + w - d, y: y + h }
      d -= w
      return { x, y: y + h - d }
    }

    // 已選定角色的邊界動畫：沿著角色實際外框（跟 hit-test/clamp 用的同一個框）畫一段
    // 隨時間繞圈跑動的高亮「閃電」，主線疊加兩層由寬到窄的光暈製造發光感，另外用
    // sin 抖動讓線段本身看起來鋸齒/不規則，比單純跑馬燈更有「電流感」。
    const BORDER_LOOP_MS = 1600
    const BORDER_SEGMENT_FRAC = 0.22
    function drawSelectionBorder(
      canvasRef: React.RefObject<HTMLCanvasElement | null>,
      box: { x: number; y: number; width: number; height: number },
      now: number,
    ) {
      const ctx = canvasRef.current?.getContext('2d')
      if (!ctx || box.width <= 0 || box.height <= 0) return

      ctx.save()
      ctx.strokeStyle = 'rgba(52,211,153,0.3)'
      ctx.lineWidth = 2
      ctx.strokeRect(box.x, box.y, box.width, box.height)

      const t0 = (now % BORDER_LOOP_MS) / BORDER_LOOP_MS
      const steps = 20
      const points: { x: number; y: number }[] = []
      for (let i = 0; i <= steps; i++) {
        const t = t0 + (BORDER_SEGMENT_FRAC * i) / steps
        const p = pointOnRectPerimeter(box, t)
        // 鋸齒抖動：只作用在中段點位，頭尾維持精確落在邊框上，視覺上比較像放電而不是模糊。
        const jitter = i > 0 && i < steps ? Math.sin(i * 2.1 + now * 0.012) * 3 : 0
        points.push({ x: p.x + jitter, y: p.y - jitter })
      }

      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      const layers = [
        { lineWidth: 7, color: 'rgba(110,231,183,0.22)' },
        { lineWidth: 4, color: 'rgba(110,231,183,0.5)' },
        { lineWidth: 1.75, color: 'rgba(240,253,244,0.95)' },
      ]
      for (const layer of layers) {
        ctx.beginPath()
        points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
        ctx.strokeStyle = layer.color
        ctx.lineWidth = layer.lineWidth
        ctx.stroke()
      }
      ctx.restore()
    }

    function releaseSelection() {
      // updateHold() 一旦看到 state.selected 就直接原樣回傳、不會再重新判斷 hit-test，
      // 這裡不順手歸零的話，holdRef 會停在 { selected: true } 卡住——下一幀只要指尖還
      // 大致在框內就會被誤判成「還是已選定」，立刻重新選取，馬上又被同一個石頭手勢
      // 放開，在選定/放開之間逐幀狂閃（症狀：整個網頁排版跟著抖動）。
      selectionRef.current = null
      setIsSelected(false)
      holdRef.current = INITIAL_HOLD_STATE
      clearCanvas(cursorRef)
      // 刻意不做任何「歸位」動作：放開後模型停在最後位置，跟原本的設計是同一個決定。
    }

    function handleFrame(result: any, video: HTMLVideoElement, now: number) {
      const landmarks = result.landmarks?.[0] ?? null
      const gestureCategory = result.gestures?.[0]?.[0]?.categoryName ?? null
      const deltaMs = lastFrameTime === null ? 0 : now - lastFrameTime
      lastFrameTime = now

      drawOverlay(video, landmarks)

      const activeHandle = handleRef.current
      if (!activeHandle || !landmarks) {
        // 沒有可互動的模型（例如目前這張卡片的模型還在載入、或已經逃出去了），或這一幀
        // 偵測不到手：視同放開，進度歸零（AC #8）。
        if (selectionRef.current) releaseSelection()
        else holdRef.current = INITIAL_HOLD_STATE
        clearCanvas(cursorRef)
        return
      }

      const videoSize = { width: video.videoWidth, height: video.videoHeight }
      const canvasSize = activeHandle.getCanvasSize()
      const fingertipPos = videoPointToCanvasPoint(landmarks[8], videoSize, canvasSize)

      if (selectionRef.current) {
        if (shouldRelease(gestureCategory, true)) {
          releaseSelection()
          return
        }
        const desired = dragPosition(fingertipPos, selectionRef.current.grabOffset)
        const scale = activeHandle.model.scale.x
        const clamped = clampModelPosition(desired, activeHandle.tightBounds, scale, canvasSize)
        activeHandle.model.position.set(clamped.x, clamped.y)
        drawCursor(cursorRef, canvasSize, fingertipPos, 1, true, now)
        drawSelectionBorder(cursorRef, boxOnCanvas(activeHandle.tightBounds, scale, clamped), now)
        return
      }

      const modelPosition = { x: activeHandle.model.position.x, y: activeHandle.model.position.y }
      const scale = activeHandle.model.scale.x
      const boxCanvas = boxOnCanvas(activeHandle.tightBounds, scale, modelPosition)
      const inside = isPointInBox(fingertipPos, boxCanvas)
      holdRef.current = updateHold(holdRef.current, inside, deltaMs, HOLD_DURATION_MS)
      if (holdRef.current.selected) {
        if (activeHandle.markEscaped()) {
          selectionRef.current = { grabOffset: computeGrabOffset(fingertipPos, modelPosition) }
          setIsSelected(true)
        } else {
          // 已達 maxEscapedModels 上限：不進入選定狀態，把 hold 歸零（不然下一幀
          // updateHold() 看到 selected:true 又會直接原樣回傳，卡在「選定但沒有實際
          // 效果」的狀態——見 releaseSelection 同樣的踩坑說明）。
          holdRef.current = INITIAL_HOLD_STATE
          showCapMessage()
        }
      }
      drawCursor(cursorRef, canvasSize, fingertipPos, holdRef.current.progressMs / HOLD_DURATION_MS, holdRef.current.selected, now)
    }

    function loop() {
      if (destroyed) return
      if (recognizer && videoEl.readyState >= 2) {
        const now = performance.now()
        const result = recognizer.recognizeForVideo(videoEl, now)
        handleFrame(result, videoEl, now)
      }
      rafId = requestAnimationFrame(loop)
    }

    async function setup() {
      setStatus('requesting')
      setErrorMessage(null)

      // navigator.mediaDevices 整個是 undefined（不是 getUserMedia 呼叫失敗）代表這個
      // 頁面不是 secure context（不是 https:// 也不是 localhost）——PK 對戰模式
      // （pk-mode/）開發時實測踩過這個坑，見 docs/specs/0013「已知風險」。這裡先擋
      // 一次丟出好懂的訊息，不要讓後面 .getUserMedia() 直接對 undefined 取屬性炸出
      // 一句看不懂的 TypeError。
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('insecure-context')

      // 只在啟用當下才動態載入這個套件，不啟用就完全不下載、不初始化，不拖慢首頁載入。
      const { FilesetResolver, GestureRecognizer } = await import('@mediapipe/tasks-vision')
      const vision = await FilesetResolver.forVisionTasks(WASM_BASE_URL)
      if (destroyed) return

      try {
        recognizer = await GestureRecognizer.createFromOptions(vision, buildRecognizerOptions('GPU'))
      } catch (err) {
        console.error('[GestureDragControl] GPU delegate 建立失敗，改用 CPU 重試：', err)
        recognizer = await GestureRecognizer.createFromOptions(vision, buildRecognizerOptions('CPU'))
      }
      if (destroyed) {
        recognizer.close()
        return
      }

      // 不加 facingMode:'user'——外接 USB 攝影機沒有「朝向」概念，部分廠牌驅動在
      // 瀏覽器要求這個約束時會直接判定不滿足而失敗，見上面 describeError() 的說明。
      stream = await navigator.mediaDevices.getUserMedia({ video: true })
      if (destroyed) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }

      videoEl.srcObject = stream
      await videoEl.play()
      if (destroyed) return

      setStatus('active')
      rafId = requestAnimationFrame(loop)
    }

    setup().catch((err) => {
      console.error('[GestureDragControl] 啟用失敗：', err)
      if (destroyed) return
      setStatus('error')
      setErrorMessage(describeError(err))
      setEnabled(false)
    })

    return () => {
      destroyed = true
      if (rafId) cancelAnimationFrame(rafId)
      if (recognizer) {
        try {
          recognizer.close()
        } catch (err) {
          console.error('[GestureDragControl] recognizer.close 失敗（已忽略）：', err)
        }
      }
      stream?.getTracks().forEach((t) => t.stop())
      videoEl.srcObject = null
      holdRef.current = INITIAL_HOLD_STATE
      selectionRef.current = null
      setIsSelected(false)
      clearCanvas(cursorRef)
    }
  }, [enabled])

  return (
    <div className="mt-3 flex flex-col items-center gap-2">
      <button
        type="button"
        onClick={() => setEnabled((v) => !v)}
        aria-pressed={enabled}
        className={cn(
          'inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-xs font-medium transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2',
          enabled
            ? 'border-violet-500 bg-violet-500 text-white'
            : 'border-stone-300 bg-white text-stone-700 hover:bg-stone-100 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200 dark:hover:bg-stone-800',
        )}
      >
        {enabled ? '關閉手勢拖曳' : '啟用手勢拖曳'}
      </button>

      {enabled && (
        <div className="relative w-40 overflow-hidden rounded-xl border border-stone-200 bg-black shadow-md dark:border-stone-700">
          <video ref={videoRef} className="block w-full scale-x-[-1]" muted playsInline aria-hidden="true" />
          <canvas ref={overlayRef} className="absolute inset-0 h-full w-full scale-x-[-1]" aria-hidden="true" />
          {status === 'requesting' && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-[11px] text-white">
              等待鏡頭權限…
            </div>
          )}
        </div>
      )}

      {enabled && (
        // 固定高度佔位，不管有沒有文字都保留這行空間——避免選定/放開切換時這行文字
        // 出現/消失讓下面整頁內容跟著垂直位移（見這次抖動 bug 的修復說明）。
        <p className="h-4 text-xs font-medium text-emerald-600 dark:text-emerald-400">
          {isSelected ? '已選定，跟著手移動中' : ' '}
        </p>
      )}

      {errorMessage && (
        <p className="max-w-[16rem] text-center text-xs text-rose-600 dark:text-rose-400">{errorMessage}</p>
      )}

      {capMessage && (
        <p className="max-w-[16rem] text-center text-xs text-amber-600 dark:text-amber-400">{capMessage}</p>
      )}

      {enabled &&
        canvasHost &&
        createPortal(
          <canvas ref={cursorRef} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true" />,
          canvasHost,
        )}
    </div>
  )
}
