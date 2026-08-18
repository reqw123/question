import { useEffect, useRef, useState } from 'react'
import mqtt, { type MqttClient } from 'mqtt'
import { PK_ANIMATION_MAP } from './pkAnimationMap'
import { INITIAL_DEFENSE_STATE, updateDefenseState } from './pkDefenseState'
import { INITIAL_EDGE_TRIGGER_STATE, updateEdgeTriggerState } from './pkEdgeTriggerState'
import { handTiltAngle, mirrorAngle, smoothValue, tiltToMoveValue } from './pkMovement'
import { pkMqttUrl } from './pkMqttUrl'
import {
  HEARTBEAT_MS,
  HP_MAX,
  LOCAL_PLAYER_ID,
  PK_TOPICS,
  PK_WEBRTC_SIGNAL_PREFIX,
  WEBRTC_ICE_SERVERS,
  type PkInputMessage,
  type PkMatchState,
  type PkWebrtcSignalMessage,
  type PlayerSlot,
} from './pkProtocol'

const WASM_BASE_URL = '/mediapipe/wasm'
const MODEL_ASSET_PATH = '/mediapipe/models/gesture_recognizer.task'
const PLAYER_ID_STORAGE_KEY = 'pk-player-id'

const ATTACK_GESTURE = 'Closed_Fist'
const JUMP_GESTURE = 'Victory'
const MOVE_PUBLISH_MS = 100 // 移動節流頻率（10Hz），見下面 handleFrame() 的說明

// 跟 aatrox-gesture/AatroxGestureTrigger.tsx 同一份骨架拓樸/畫法，見該檔案的說明——
// 純繪圖用的靜態資料，量體小，不值得抽成共用模組。
const HAND_CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
]

type CameraStatus = 'requesting' | 'active' | 'error'

function getOrCreatePlayerId(): string {
  const existing = window.localStorage.getItem(PLAYER_ID_STORAGE_KEY)
  if (existing) return existing
  // 不用 crypto.randomUUID()：這個功能整個立足於區網 http:// 直連（跟 multi/ 一樣，見
  // pkMqttUrl.ts），crypto.randomUUID() 只在 secure context（https/localhost）可用，
  // 區網 IP 走 http:// 會直接噴錯。跟 multi/player.html 現有的 quiz_pid 生成方式
  // 用同一招（Math.random 轉 16 進位取幾碼），碰撞機率低到可以忽略，這裡不是需要
  // 密碼學等級隨機性的場景。
  const fresh = `pk_${Math.random().toString(16).slice(2, 10)}`
  window.localStorage.setItem(PLAYER_ID_STORAGE_KEY, fresh)
  return fresh
}

function buildRecognizerOptions(delegate: 'GPU' | 'CPU') {
  return {
    baseOptions: { modelAssetPath: MODEL_ASSET_PATH, delegate },
    runningMode: 'VIDEO' as const,
    numHands: 1,
  }
}

// 2026-08-18 改成把瀏覽器回報的實際錯誤名稱/訊息一起顯示出來（不是只挑幾種常見情境
// 給固定文案）——實測發現外接 USB 攝影機常見的失敗方式（明明 Windows 相機 App 開得
// 起來、Chrome/Edge 卻連不上）通常是 NotReadableError（鏡頭被另一個程式占用中，例如
// Windows 相機 App 自己還開著、或視訊會議軟體背景占用）或 OverconstrainedError（下面
// getUserMedia 原本帶的 facingMode:'user' 約束——這個欄位是給手機前/後鏡頭用的，
// 桌上型 USB 攝影機沒有「朝向」概念，部分廠牌的驅動回報方式會讓瀏覽器直接判定不滿足
// 約束而整個拒絕，已經把這個約束拿掉，見下面 getUserMedia 呼叫），只給固定的「權限被
// 拒絕」文案會誤導使用者去檢查根本不是問題所在的地方。
function describeError(err: unknown): string {
  // navigator.mediaDevices 整個不存在：這支手機沒問題，是這個頁面不是 secure context
  // （https:// 或 localhost）。跟玩家一（擂台端）不同，操控端沒有「改用 localhost」
  // 這個簡單解法可以繞——這是設計前提就有的已知風險（見 docs/specs/0013「已知
  // 風險」），目前還沒有解法，只能誠實告知。
  if (err instanceof Error && err.message === 'insecure-context') {
    return '這個網址不是安全來源（secure context），手機瀏覽器直接不提供鏡頭功能——這是目前已知、還沒解決的限制（需要 HTTPS 才能在區網手機上用鏡頭），不是你操作錯誤'
  }
  const detail = err instanceof DOMException ? `${err.name}${err.message ? `：${err.message}` : ''}` : String(err)
  if (err instanceof DOMException && err.name === 'NotAllowedError') {
    return `鏡頭權限被拒絕（${detail}）——請到瀏覽器網址列左側的鎖頭/資訊圖示確認鏡頭權限，或到系統設定確認瀏覽器有鏡頭存取權限`
  }
  if (err instanceof DOMException && (err.name === 'NotReadableError' || err.name === 'TrackStartError')) {
    return `鏡頭讀取失敗（${detail}）——通常是鏡頭被另一個程式占用中（例如 Windows 相機 App、視訊會議軟體開著），關掉其他正在用鏡頭的程式後再試一次`
  }
  if (err instanceof DOMException && (err.name === 'NotFoundError' || err.name === 'OverconstrainedError')) {
    return `找不到符合條件的鏡頭（${detail}）——如果是外接 USB 攝影機，確認 Windows 裡有正確辨識到這台裝置`
  }
  return `手勢 PK 對戰目前無法使用（${detail}），請確認瀏覽器支援鏡頭存取後再試一次`
}

function mySlot(matchState: PkMatchState | null, playerId: string): PlayerSlot | null {
  if (!matchState) return null
  if (matchState.player1?.playerId === playerId) return 'player1'
  if (matchState.player2?.playerId === playerId) return 'player2'
  return null
}

// 手勢 PK 對戰模式的操控端：手機瀏覽器開 desktop-pet-web 網址、路徑換成
// PK_CONTROLLER_PATH（/pk，見 pkJoinUrl.ts、App.tsx）進到這個畫面。只負責鏡頭手勢
// 辨識＋發布 MQTT 事件，完全不做 3D 渲染（見 docs/adr/0014「為什麼是一個擂台端＋
// 兩支遙控器」）。見 docs/specs/0013。
export function PkControllerView() {
  const [matchState, setMatchState] = useState<PkMatchState | null>(null)
  const [cameraStatus, setCameraStatus] = useState<CameraStatus>('requesting')
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [gestureLabel, setGestureLabel] = useState('未偵測到手')
  const playerIdRef = useRef<string>('')
  if (!playerIdRef.current) playerIdRef.current = getOrCreatePlayerId()

  const videoRef = useRef<HTMLVideoElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  // 同步顯示擂台端畫面用的 <video>（WebRTC 收到的 remote stream），跟上面
  // videoRef（自己的鏡頭）是兩個獨立的畫面來源，不要搞混。
  const hostVideoRef = useRef<HTMLVideoElement>(null)
  const [hostVideoStatus, setHostVideoStatus] = useState<'connecting' | 'connected' | 'unavailable'>('connecting')
  // pull 訊息（跟 pk/join 一樣）沒有 retain，一樣可能搶在擂台端訂閱生效前送出而遺失
  // ——這個 ref 讓 heartbeat interval 知道還沒連上時要重發，同一招用兩次，見下面
  // heartbeat 的說明。
  const hostVideoStatusRef = useRef<'connecting' | 'connected' | 'unavailable'>('connecting')
  const clientRef = useRef<MqttClient | null>(null)
  // pk/join 沒有 retain（見 pkProtocol.ts），如果這個 publish 搶在擂台端的
  // client.subscribe(PK_TOPICS.JOIN) 生效之前送出（兩邊各自連線的時機沒有保證誰先
  // 誰後），這則訊息就直接遺失、擂台端永遠不會知道這個玩家存在，之後也不會自動補送
  // ——實測踩過這個坑：兩邊都顯示「已加入/鏡頭已就緒」，但擂台端卡在等待對手，
  // 見下面 heartbeat interval 的重試邏輯。這個 ref 讓 heartbeat 那個 effect 知道
  // 「目前有沒有被擂台端分配到 slot」。
  const assignedSlotRef = useRef<PlayerSlot | null>(null)
  // 防禦是持續狀態（見 pkDefenseState.ts），心跳訊息要順手帶上「目前正不正在防禦」
  // 當保底同步（見 docs/specs/0013），這個 ref 讓下面手勢/心跳兩個各自獨立的 effect
  // 共用同一份最新值，不用把兩個 effect 合併成一個。
  const defendingRef = useRef(false)

  useEffect(() => {
    const playerId = playerIdRef.current
    const url = pkMqttUrl(window.location.hostname, window.location.protocol, 9001)
    const client: MqttClient = mqtt.connect(url, { reconnectPeriod: 3000 })

    // 同步看擂台端畫面（WebRTC，見 pkProtocol.ts 的說明）：這裡只會有一條 inbound
    // peer connection（擂台端是唯一的廣播來源），跟 PkArenaView.tsx 的
    // outPeerConnection 是同一種「PK 模式永遠一對一，不用管字典」的簡化。
    let inPeerConnection: RTCPeerConnection | null = null

    function setVideoStatus(status: 'connecting' | 'connected' | 'unavailable') {
      hostVideoStatusRef.current = status
      setHostVideoStatus(status)
    }

    function publishSignal(targetId: string, message: PkWebrtcSignalMessage) {
      client.publish(PK_WEBRTC_SIGNAL_PREFIX + targetId, JSON.stringify(message))
    }

    // 收到擂台端的 offer 才建立 peer connection——跟 pk/join 一樣，(重新)連上就送一次
    // pull（見下面 client.on('connect')），不管是第一次連線還是斷線重連，都是同一條
    // 路徑跟擂台端要一份新的 offer，不特別區分。
    async function handleOffer(sdp: RTCSessionDescriptionInit) {
      inPeerConnection?.close()
      const pc = new RTCPeerConnection({ iceServers: WEBRTC_ICE_SERVERS })
      inPeerConnection = pc
      setVideoStatus('connecting')

      pc.ontrack = ({ streams: [stream] }) => {
        if (hostVideoRef.current) hostVideoRef.current.srcObject = stream
        setVideoStatus('connected')
      }
      pc.onicecandidate = ({ candidate }) => {
        if (candidate) publishSignal(LOCAL_PLAYER_ID, { from: playerId, type: 'ice', candidate: candidate.toJSON() })
      }
      pc.onconnectionstatechange = () => {
        if (['failed', 'disconnected', 'closed'].includes(pc.connectionState) && inPeerConnection === pc) {
          inPeerConnection = null
          setVideoStatus('unavailable')
        }
      }

      await pc.setRemoteDescription(new RTCSessionDescription(sdp))
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      publishSignal(LOCAL_PLAYER_ID, { from: playerId, type: 'answer', sdp: pc.localDescription! })
    }

    // mqtt.js 的 'connect' 事件在第一次連上、以及斷線後自動重連成功時都會觸發，這裡
    // 刻意不分開處理——不管是哪一種，都要（重新）訂閱 pk/state、重新發一次 pk/join，
    // 讓擂台端知道這個 playerId 活著（或又活過來了），順便重新跟擂台端要一次畫面
    // （pull）。
    client.on('connect', () => {
      client.subscribe([PK_TOPICS.STATE, PK_WEBRTC_SIGNAL_PREFIX + playerId], { qos: 1 })
      client.publish(PK_TOPICS.JOIN, JSON.stringify({ playerId }))
      publishSignal(LOCAL_PLAYER_ID, { from: playerId, type: 'pull' })
    })

    client.on('message', (topic, payload) => {
      if (topic === PK_TOPICS.STATE) {
        try {
          const state = JSON.parse(payload.toString()) as PkMatchState
          setMatchState(state)
          assignedSlotRef.current = mySlot(state, playerId)
        } catch (err) {
          console.error('[PkControllerView] 解析 pk/state 失敗（已忽略）：', err)
        }
        return
      }

      if (topic === PK_WEBRTC_SIGNAL_PREFIX + playerId) {
        let signal: PkWebrtcSignalMessage
        try {
          signal = JSON.parse(payload.toString()) as PkWebrtcSignalMessage
        } catch (err) {
          console.error('[PkControllerView] 解析畫面同步訊息失敗（已忽略）：', err)
          return
        }
        if (signal.type === 'offer') {
          handleOffer(signal.sdp).catch((err) => console.error('[PkControllerView] 建立畫面同步失敗：', err))
        } else if (signal.type === 'ice' && inPeerConnection) {
          inPeerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch(() => {})
        }
      }
    })

    const heartbeatId = window.setInterval(() => {
      client.publish(PK_TOPICS.HEARTBEAT, JSON.stringify({ playerId, defending: defendingRef.current }))
      // 還沒被擂台端分配到 slot，就順便重發一次 pk/join——擂台端的 applyJoin() 對
      // 已經連線中的既有 slot 是安全的 no-op，只有真的還沒被佔用的 slot 才會生效，
      // 最多 HEARTBEAT_MS（3 秒）內就會補上最初那則遺失的 join。
      if (!assignedSlotRef.current) {
        client.publish(PK_TOPICS.JOIN, JSON.stringify({ playerId }))
      }
      // pull 也沒有 retain，一樣可能搶在擂台端訂閱生效前送出而遺失（同一種 race，
      // 見上面 pk/join 那段的說明），還沒連上（或連線中途斷了）就一併重發。
      if (hostVideoStatusRef.current !== 'connected') {
        publishSignal(LOCAL_PLAYER_ID, { from: playerId, type: 'pull' })
      }
    }, HEARTBEAT_MS)

    clientRef.current = client
    return () => {
      window.clearInterval(heartbeatId)
      inPeerConnection?.close()
      client.end(true)
      clientRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在掛載/卸載時跑一次
  }, [])

  useEffect(() => {
    const videoElOrNull = videoRef.current
    if (!videoElOrNull) return
    const videoEl: HTMLVideoElement = videoElOrNull

    let destroyed = false
    let stream: MediaStream | null = null
    let recognizer: any = null
    let rafId = 0
    let attackState = INITIAL_EDGE_TRIGGER_STATE
    let jumpState = INITIAL_EDGE_TRIGGER_STATE
    let defenseState = INITIAL_DEFENSE_STATE
    // 移動是連續數值，每幀都在變（手勢辨識本身就有雜訊），不能像防禦那樣「只在
    // changed 時才送」——但也不該真的每幀（60fps）都送一則 MQTT 訊息，節流成固定
    // 頻率（MOVE_PUBLISH_MS）送最新值即可，跟位置控制的即時性需求已經綽綽有餘，
    // 不會讓區網 MQTT broker 承受不必要的訊息量。
    let lastMoveSentAt = 0
    // 手離開畫面時重置回 null（不是留著舊值），見 pkMovement.ts smoothValue() 的說明。
    let smoothedTiltAngle: number | null = null

    function publish(message: PkInputMessage) {
      clientRef.current?.publish(PK_TOPICS.INPUT, JSON.stringify(message))
    }

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
      const gestureCategory: string | null = result.gestures?.[0]?.[0]?.categoryName ?? null
      drawOverlay(videoEl, landmarks)
      setGestureLabel(landmarks ? (gestureCategory && gestureCategory !== 'None' ? gestureCategory : '比個手勢試試') : '未偵測到手')

      const attackResult = updateEdgeTriggerState(attackState, gestureCategory, ATTACK_GESTURE)
      attackState = attackResult.state
      if (attackResult.fired) publish({ playerId: playerIdRef.current, type: 'attack' })

      const jumpResult = updateEdgeTriggerState(jumpState, gestureCategory, JUMP_GESTURE)
      jumpState = jumpResult.state
      if (jumpResult.fired) publish({ playerId: playerIdRef.current, type: 'jump' })

      const defenseResult = updateDefenseState(defenseState, gestureCategory)
      defenseState = defenseResult.state
      defendingRef.current = defenseState.defending
      if (defenseResult.changed) {
        publish({ playerId: playerIdRef.current, type: 'defense', defending: defenseState.defending })
      }

      // 移動：食指根部（landmarks[5]）相對於食指指尖（landmarks[8]）的傾斜角度連續
      // 控制前進/後退，跟手勢分類無關。2026-08-18 從「手在畫面裡的絕對位置」先改成
      // 「手腕傾斜角度」，使用者實測回報「單純手腕傾斜可能會誤判」後，再改成量測食指
      // 自己的角度，見 pkMovement.ts 檔頭說明。smoothValue() 平滑每一幀都要做（見
      // pkMovement.ts 說明），不能只在節流發布的那一刻才平滑——那樣等於拿節流間隔
      // （100ms）當取樣間隔，平滑效果會隨節流頻率飄動，不穩定。節流的只有「要不要真的
      // 發布 MQTT 訊息」這件事，見上面 lastMoveSentAt 的說明。
      if (landmarks) {
        smoothedTiltAngle = smoothValue(smoothedTiltAngle, mirrorAngle(handTiltAngle(landmarks[5], landmarks[8])))
      } else {
        smoothedTiltAngle = null // 手離開畫面，下次重新出現用新角度，不留舊的平滑殘留
      }
      const now = performance.now()
      if (now - lastMoveSentAt >= MOVE_PUBLISH_MS) {
        lastMoveSentAt = now
        const moveValue = smoothedTiltAngle !== null ? tiltToMoveValue(smoothedTiltAngle) : 0
        publish({ playerId: playerIdRef.current, type: 'move', value: moveValue })
      }
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
      // 頁面不是 secure context——這是已知風險（見 docs/specs/0013），操控端跑在區網
      // http:// 直連的手機上幾乎一定會踩到。這裡先擋一次丟出好懂的訊息，不要讓後面
      // .getUserMedia() 直接對 undefined 取屬性炸出一句看不懂的 TypeError。
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('insecure-context')

      const { FilesetResolver, GestureRecognizer } = await import('@mediapipe/tasks-vision')
      const vision = await FilesetResolver.forVisionTasks(WASM_BASE_URL)
      if (destroyed) return

      try {
        recognizer = await GestureRecognizer.createFromOptions(vision, buildRecognizerOptions('GPU'))
      } catch (err) {
        console.error('[PkControllerView] GPU delegate 建立失敗，改用 CPU 重試：', err)
        recognizer = await GestureRecognizer.createFromOptions(vision, buildRecognizerOptions('CPU'))
      }
      if (destroyed) {
        recognizer.close()
        return
      }

      // ⚠️ getUserMedia() 只在 secure context（https:// 或 localhost）可用，跟上面
      // playerId 那個 crypto.randomUUID() 同一類限制，但這裡沒有等價的「不用密碼學等級
      // API」解法可以繞——瀏覽器就是直接擋掉 http://192.168.x.x 這種區網 IP 的鏡頭權限
      // 請求。純區網 http:// 直連（這次的設計前提）在手機瀏覽器上很可能連鏡頭權限請求
      // 都跳不出來。這是已知風險，還沒有解法，見 docs/specs/0013「已知風險」——可能
      // 需要比照 multi/ 現有的 Caddy 反代（wss:// 那條路）補一份 LAN 適用的 https 設定
      // 才能讓操控端在真手機上正常運作，這台機器沒辦法實測手機瀏覽器，需要使用者自己
      // 拿手機連過一次才會知道實際擋在哪一步。
      // 不加 facingMode: 'user'——那是手機前/後鏡頭用的概念，外接 USB 攝影機沒有
      // 「朝向」，部分廠牌驅動在瀏覽器要求這個約束時會直接判定不滿足而失敗（見上面
      // describeError() 的說明）。單純要求一支鏡頭，讓瀏覽器自己選（通常是使用者
      // 系統預設那一支），手機上一樣會拿到前鏡頭，桌機/外接鏡頭也不會被這個約束擋下來。
      stream = await navigator.mediaDevices.getUserMedia({ video: true })
      if (destroyed) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }

      videoEl.srcObject = stream
      await videoEl.play()
      if (destroyed) return

      setCameraStatus('active')
      rafId = requestAnimationFrame(loop)
    }

    setup().catch((err) => {
      console.error('[PkControllerView] 啟用失敗：', err)
      if (destroyed) return
      setCameraStatus('error')
      setCameraError(describeError(err))
    })

    return () => {
      destroyed = true
      if (rafId) cancelAnimationFrame(rafId)
      if (recognizer) {
        try {
          recognizer.close()
        } catch (err) {
          console.error('[PkControllerView] recognizer.close 失敗（已忽略）：', err)
        }
      }
      stream?.getTracks().forEach((t) => t.stop())
      videoEl.srcObject = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在掛載/卸載時跑一次
  }, [])

  const slot = mySlot(matchState, playerIdRef.current)
  const me = slot ? matchState?.[slot] : null
  const opponentSlot: PlayerSlot | null = slot === 'player1' ? 'player2' : slot === 'player2' ? 'player1' : null
  const opponent = opponentSlot ? matchState?.[opponentSlot] : null
  const myAnimations = slot ? PK_ANIMATION_MAP[slot] : null
  const opponentAnimations = opponentSlot ? PK_ANIMATION_MAP[opponentSlot] : null

  return (
    // fixed inset-0：跟擂台端一樣佔滿整個畫面（見 PkArenaView.tsx），使用者實測回報
    // 「玩家端畫面太小」——原本是一般網頁那種置中窄欄排版，擂台端畫面只是欄位裡一個
    // 普通大小的區塊。改成同一種「全螢幕畫面當背景，其餘資訊疊在上面」的呈現方式，
    // 兩邊看到的東西才是真的一樣大。
    <main className="fixed inset-0 overflow-hidden bg-black text-white">
      {/* 擂台端畫面（WebRTC）：填滿整個畫面當背景。muted：擂台端傳來的 stream 本來就
          只有影像軌（captureStream() 只抓 getVideoTracks()，沒有聲音），但瀏覽器的
          自動播放限制對「有沒有 muted」比較敏感，不管有沒有聲音都設 muted 確保能穩定
          自動播放，不用使用者手動點一下才會動。object-contain 不是 cover——擂台端跟
          手機的長寬比不會一樣，保留完整構圖比裁切掉一部分重要（血量條/角色）更好。 */}
      <video ref={hostVideoRef} className="absolute inset-0 h-full w-full bg-black object-contain" autoPlay playsInline muted />

      {slot && hostVideoStatus !== 'connected' && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70 text-center text-sm text-stone-300">
          {hostVideoStatus === 'connecting' ? '正在連接擂台畫面…' : '擂台畫面暫時無法顯示（不影響操控）'}
        </div>
      )}

      {/* 頂部：標題／角色資訊／血量，蓋在擂台畫面上方，用漸層底色確保文字在亮畫面上
          也看得清楚。 */}
      <div className="absolute inset-x-0 top-0 bg-gradient-to-b from-black/80 via-black/40 to-transparent px-4 pb-8 pt-4">
        <h1 className="text-center text-base font-bold">手勢 PK 對戰</h1>

        {!slot && (
          <p className="mt-1 text-center text-sm text-stone-300">
            {matchState ? '這場對戰的兩個位置已經滿了，稍後再試' : '連線中…'}
          </p>
        )}

        {slot && myAnimations && (
          <p className="mt-1 text-center text-sm text-violet-300">
            你是 <span className="font-semibold text-white">{myAnimations.displayName}</span>
            {opponentAnimations && <> ・對手是 {opponentAnimations.displayName}</>}
          </p>
        )}

        {me && opponent && (
          <div className="mx-auto mt-3 flex w-full max-w-xs flex-col gap-2 text-xs">
            <div>
              <p className="mb-1 text-stone-300">你的血量</p>
              <div className="h-2 w-full overflow-hidden rounded-full bg-stone-800/80">
                <div className="h-full bg-emerald-500 transition-all" style={{ width: `${(me.hp / HP_MAX) * 100}%` }} />
              </div>
            </div>
            <div>
              <p className="mb-1 text-stone-300">對手血量</p>
              <div className="h-2 w-full overflow-hidden rounded-full bg-stone-800/80">
                <div className="h-full bg-rose-500 transition-all" style={{ width: `${(opponent.hp / HP_MAX) * 100}%` }} />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 中央：階段訊息（等待/倒數/暫停/結束），跟擂台端同一批訊息但文案改成第一人稱。 */}
      {matchState?.phase === 'waiting' && (
        <p className="absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-sm text-stone-200 [text-shadow:0_1px_4px_rgba(0,0,0,.8)]">
          等待另一位玩家加入…
        </p>
      )}
      {matchState?.phase === 'countdown' && (
        <p className="absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-8xl font-bold text-violet-300 [text-shadow:0_2px_12px_rgba(0,0,0,.8)]">
          {matchState.countdown}
        </p>
      )}
      {matchState?.phase === 'paused' && (
        <p className="absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-sm text-amber-300 [text-shadow:0_1px_4px_rgba(0,0,0,.8)]">
          對方已離線，等待重新連線…
        </p>
      )}
      {matchState?.phase === 'finished' && (
        <p className="absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-3xl font-bold [text-shadow:0_2px_12px_rgba(0,0,0,.8)]">
          {matchState.winner === slot ? '你獲勝了！' : '你輸了'}
        </p>
      )}

      {/* 底部：自己的鏡頭 PIP＋手勢提示，疊在擂台畫面右下角，比擂台端畫面小很多——
          這裡的重點是操控回饋，不是給人看的主畫面，維持小尺寸。 */}
      <div className="absolute bottom-4 right-4 w-28 overflow-hidden rounded-xl border border-white/40 bg-black shadow-lg sm:w-32">
        <video ref={videoRef} className="block w-full scale-x-[-1]" muted playsInline aria-hidden="true" />
        <canvas ref={overlayRef} className="absolute inset-0 h-full w-full scale-x-[-1]" aria-hidden="true" />
        {cameraStatus === 'requesting' && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-center text-[11px]">
            等待鏡頭權限…
          </div>
        )}
        {/* 2026-08-18 修正：這裡原本不是 absolute，會撐開外層 div 的高度（video 本身
            的高度之外多一截文字列的高度），但下面 overlayRef 的 <canvas> 是
            absolute inset-0 h-full w-full——會被拉伸去填滿「video 高度 + 這行文字」
            的總高度，不是只對齊 video 自己的高度，導致骨架疊圖跟實際鏡頭畫面垂直方向
            對不準（愈往下愈明顯）。改成絕對定位疊在 video 底部，維持外層 div 高度
            只由 video 自己決定，疊圖才會準。 */}
        {cameraStatus === 'active' && (
          <p className="absolute inset-x-0 bottom-0 bg-black/70 px-1.5 py-1 text-center text-[11px] font-medium">{gestureLabel}</p>
        )}
      </div>

      {/* 疊在鏡頭 PIP／手勢提示那一整排的正上方，避免疊在一起看不清楚——鏡頭壞掉是
          會擋住整個手勢輸入的嚴重狀況，故意用實色底色（不是純文字疊字）確保夠顯眼。 */}
      {cameraError && (
        <p className="absolute inset-x-4 bottom-24 rounded-lg bg-rose-950/90 px-3 py-2 text-center text-xs text-rose-200 sm:bottom-28">
          {cameraError}
        </p>
      )}

      <div className="absolute bottom-4 left-4 grid grid-cols-2 gap-x-3 gap-y-1 text-center text-[11px] text-stone-200 [text-shadow:0_1px_4px_rgba(0,0,0,.8)]">
        <div>☝️ 食指左/右傾斜移動</div>
        <div>✊ 攻擊（要靠近對方）</div>
        <div>🖐️ 防禦（按住）</div>
        <div>✌️ 跳躍</div>
      </div>
    </main>
  )
}
