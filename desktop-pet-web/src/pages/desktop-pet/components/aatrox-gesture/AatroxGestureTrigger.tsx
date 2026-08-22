import { useEffect, useRef, useState } from 'react'
import { INITIAL_TRIGGER_STATE, updateTriggerState } from './gestureTriggerState'

const WASM_BASE_URL = '/mediapipe/wasm'
const MODEL_ASSET_PATH = '/mediapipe/models/gesture_recognizer.task'

// 跟 gesture-drag/GestureDragControl.tsx 同一份骨架拓樸/畫法——純繪圖用的靜態資料，
// 這裡只需要疊出來給訪客對照「系統看到的手」，量體很小，不值得為了共用抽成獨立模組
// （見 docs/specs/0012 Implementation Decisions）。
const HAND_CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
]

type Status = 'requesting' | 'active'

function buildRecognizerOptions(delegate: 'GPU' | 'CPU') {
  return {
    baseOptions: { modelAssetPath: MODEL_ASSET_PATH, delegate },
    runningMode: 'VIDEO' as const,
    numHands: 1,
  }
}

// 2026-08-18：補上實際錯誤名稱/訊息，並多分幾種常見情境——PK 對戰模式（pk-mode/）
// 開發時實測發現外接 USB 攝影機常見的失敗方式（Windows 相機 App 開得起來、瀏覽器卻
// 連不上）通常是 NotReadableError（被其他程式占用）或 OverconstrainedError（原本
// getUserMedia 帶的 facingMode 約束，已經拿掉，見下面呼叫處），不是「權限被拒絕」，
// 只給單一句籠統文案會誤導使用者去檢查錯的地方。跟 gesture-drag/GestureDragControl.tsx
// 的 describeError() 是同一套判斷邏輯，訊息文案改成「手勢模式」以對應這次的按鈕名稱。
function describeError(err: unknown): string {
  // navigator.mediaDevices 整個不存在：這台裝置沒問題，是這個頁面不是 secure context。
  // 這個功能通常在跟 dev server 同一台機器上使用，最直接的解法是改用
  // http://localhost:<port>（不要用區網 IP）開啟這個頁面。
  if (err instanceof Error && err.message === 'insecure-context') {
    return '手勢模式目前無法使用：這個網址不是安全來源（secure context），請改用 http://localhost:<port>（不要用區網 IP）重新開啟這個頁面再試一次'
  }
  const detail = err instanceof DOMException ? `${err.name}${err.message ? `：${err.message}` : ''}` : String(err)
  if (err instanceof DOMException && err.name === 'NotAllowedError') {
    return `手勢模式目前無法使用：鏡頭權限被拒絕（${detail}）`
  }
  if (err instanceof DOMException && (err.name === 'NotReadableError' || err.name === 'TrackStartError')) {
    return `手勢模式目前無法使用：鏡頭被另一個程式占用中（${detail}），關掉其他正在用鏡頭的程式後再試一次`
  }
  if (err instanceof DOMException && (err.name === 'NotFoundError' || err.name === 'OverconstrainedError')) {
    return `手勢模式目前無法使用：找不到符合條件的鏡頭（${detail}）`
  }
  return `手勢模式目前無法使用（${detail}），請確認瀏覽器支援鏡頭存取後再試一次`
}

const GESTURE_LABELS: Record<string, string> = {
  Thumb_Up: '👍 讚',
  Thumb_Down: '👎',
  Open_Palm: '🖐️ 張手',
  Closed_Fist: '✊ 握拳',
  Victory: '✌️ 比 V',
  Pointing_Up: '☝️ 指',
  ILoveYou: '🤟',
}

function describeGesture(hasHand: boolean, category: string | null): string {
  if (!hasHand) return '未偵測到手'
  if (!category || category === 'None') return '比個 👍 試試'
  return GESTURE_LABELS[category] ?? category
}

// 開鏡頭比 👍（Thumb_Up）觸發外部傳入的 onTrigger（Aatrox3DShowcase 的
// triggerSelectedAction()），等同「鏡頭版的空白鍵」。跟 gesture-drag 是姊妹功能但完全
// 獨立：這裡不做 hit-test／拖曳／clamp，只需要「手勢分類 → 邊緣觸發」，見
// gestureTriggerState.ts、docs/specs/0012、docs/adr/0013。
//
// 沒有自己的「啟用/停用」開關——由 Aatrox3DShowcase 用 gestureMode 狀態掛載/卸載這個
// 元件本身就是完整的鏡頭生命週期（掛載＝要求權限＋開始偵測，卸載＝釋放鏡頭），跟
// GestureDragControl 自己管一個 enabled state 是不同的設計，因為手勢模式的開關按鈕
// 本來就要跟操控模式的按鈕放在同一個地方互斥管理，開關邏輯天生屬於父層。
export function AatroxGestureTrigger({
  onTrigger,
  onError,
}: {
  onTrigger: () => void
  onError: (message: string) => void
}) {
  const [status, setStatus] = useState<Status>('requesting')
  const [gestureLabel, setGestureLabel] = useState('未偵測到手')
  const videoRef = useRef<HTMLVideoElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  // onTrigger／onError 是父層每次 render 傳進來的新閉包，這個 effect 只在掛載時跑一次
  // （camera/recognizer 的生命週期跟元件掛載/卸載綁定，不該因為父層 re-render 重新跑一次
  // setup），用 ref 存最新版本，loop 裡永遠呼叫得到最新的 callback，不會抓到掛載當下
  // 那個過期的閉包。
  const onTriggerRef = useRef(onTrigger)
  const onErrorRef = useRef(onError)
  onTriggerRef.current = onTrigger
  onErrorRef.current = onError

  useEffect(() => {
    const videoElOrNull = videoRef.current
    if (!videoElOrNull) return
    const videoEl: HTMLVideoElement = videoElOrNull

    let destroyed = false
    let stream: MediaStream | null = null
    let recognizer: any = null
    let rafId = 0
    let triggerState = INITIAL_TRIGGER_STATE

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

      // 跟 GestureDragControl 一樣：直接用未鏡像的 landmark 座標畫，畫布本身用 CSS
      // scaleX(-1) 鏡像顯示，兩者同步翻轉，骨架自然對齊鏡頭畫面。
      const toPixel = (p: { x: number; y: number }) => ({ x: p.x * canvas.width, y: p.y * canvas.height })

      ctx.strokeStyle = 'rgba(167,139,250,0.9)'
      ctx.lineWidth = Math.max(2, canvas.width * 0.006)
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
        ctx.arc(p.x, p.y, Math.max(2, canvas.width * 0.01), 0, Math.PI * 2)
        ctx.fill()
      }
    }

    function handleFrame(result: any) {
      const landmarks = result.landmarks?.[0] ?? null
      const gestureCategory = result.gestures?.[0]?.[0]?.categoryName ?? null
      drawOverlay(videoEl, landmarks)
      setGestureLabel(describeGesture(landmarks !== null, gestureCategory))

      const { state, fired } = updateTriggerState(triggerState, gestureCategory)
      triggerState = state
      if (fired) onTriggerRef.current()
    }

    function loop() {
      if (destroyed) return
      if (recognizer && videoEl.readyState >= 2) {
        const now = performance.now()
        const result = recognizer.recognizeForVideo(videoEl, now)
        handleFrame(result)
      }
      rafId = requestAnimationFrame(loop)
    }

    async function setup() {
      // navigator.mediaDevices 整個是 undefined（不是 getUserMedia 呼叫失敗）代表這個
      // 頁面不是 secure context（不是 https:// 也不是 localhost）——PK 對戰模式
      // （pk-mode/）開發時實測踩過這個坑，見 docs/specs/0013「已知風險」。這裡先擋
      // 一次丟出好懂的訊息，不要讓後面 .getUserMedia() 直接對 undefined 取屬性炸出
      // 一句看不懂的 TypeError。
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('insecure-context')

      // 只在掛載時才動態載入這個套件——跟 gesture-drag 一樣的道理，不啟用手勢模式就
      // 完全不下載、不初始化。wasm/模型資源路徑跟 gesture-drag 共用同一份
      // public/mediapipe/，不重新自架第二份。
      const { FilesetResolver, GestureRecognizer } = await import('@mediapipe/tasks-vision')
      const vision = await FilesetResolver.forVisionTasks(WASM_BASE_URL)
      if (destroyed) return

      try {
        recognizer = await GestureRecognizer.createFromOptions(vision, buildRecognizerOptions('GPU'))
      } catch (err) {
        console.error('[AatroxGestureTrigger] GPU delegate 建立失敗，改用 CPU 重試：', err)
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
      console.error('[AatroxGestureTrigger] 啟用失敗：', err)
      if (destroyed) return
      // 不在這裡自己顯示錯誤——父層收到 onError 之後會把 gestureMode 設回 false，
      // 這個元件隨之卸載（下面的 cleanup 負責釋放鏡頭/recognizer），錯誤訊息集中顯示
      // 在父層「手勢模式」按鈕旁邊，跟 GestureDragControl 把 errorMessage 顯示在自己
      // 按鈕旁邊是同一個位置慣例，只是這裡狀態管理拆成父層負責。
      onErrorRef.current(describeError(err))
    })

    return () => {
      destroyed = true
      if (rafId) cancelAnimationFrame(rafId)
      if (recognizer) {
        try {
          recognizer.close()
        } catch (err) {
          console.error('[AatroxGestureTrigger] recognizer.close 失敗（已忽略）：', err)
        }
      }
      stream?.getTracks().forEach((t) => t.stop())
      videoEl.srcObject = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 刻意只在掛載/卸載時跑一次，onTrigger/onError 走 ref
  }, [])

  return (
    <div className="pointer-events-none absolute right-3 top-3 w-32 overflow-hidden rounded-xl border border-white/40 bg-black shadow-lg sm:w-36">
      <video ref={videoRef} className="block w-full scale-x-[-1]" muted playsInline aria-hidden="true" />
      <canvas ref={overlayRef} className="absolute inset-0 h-full w-full scale-x-[-1]" aria-hidden="true" />
      {status === 'requesting' && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-center text-[11px] text-white">
          等待鏡頭權限…
        </div>
      )}
      {/* 這裡原本不是 absolute，會撐開外層 div 的高度（video 本身的高度之外多一截文字
          列的高度），但上面 overlayRef 的 <canvas> 是 absolute inset-0 h-full w-full——
          會被拉伸去填滿「video 高度 + 這行文字」的總高度，不是只對齊 video 自己的高度，
          導致骨架疊圖跟實際鏡頭畫面垂直方向對不準（愈往下愈明顯）。同一個 bug、同一個
          成因也出現在 pk-mode/PkControllerView.tsx、pk-mode/PkArenaView.tsx 的鏡頭 PIP，
          這裡是同一份骨架複製出來的獨立第三處，修法照搬：改成絕對定位疊在 video 底部，
          外層 div 高度只由 video 自己決定，疊圖才會準。 */}
      {status === 'active' && (
        <p className="absolute inset-x-0 bottom-0 bg-black/70 px-2 py-1 text-center text-[11px] font-medium text-white">{gestureLabel}</p>
      )}
    </div>
  )
}
