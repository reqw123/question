import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import mqtt, { type MqttClient } from 'mqtt'
import QRCode from 'qrcode'
import { RotateCcw } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { INITIAL_DEFENSE_STATE, updateDefenseState } from './pkDefenseState'
import { INITIAL_EDGE_TRIGGER_STATE, updateEdgeTriggerState } from './pkEdgeTriggerState'
import { handTiltAngle, mirrorAngle, smoothValue, tiltToMoveValue } from './pkMovement'
import { PK_ANIMATION_MAP, type PkCharacterAnimations } from './pkAnimationMap'
import { buildJoinUrl } from './pkJoinUrl'
import {
  applyHeartbeat,
  applyInput,
  applyJoin,
  INITIAL_ARENA_STATE,
  markOffline,
  resetMatch,
  slotForPlayerId,
  startSoloBattle,
  tickCountdown,
  toWireState,
  type PkArenaState,
} from './pkMatchState'
import { pkMqttUrl } from './pkMqttUrl'
import {
  ATTACK_RANGE_HEIGHT_RATIO,
  HEARTBEAT_MS,
  HP_MAX,
  LOCAL_PLAYER_ID,
  OFFLINE_MS,
  PK_TOPICS,
  PK_WEBRTC_SIGNAL_PREFIX,
  WEBRTC_ICE_SERVERS,
  type PkHeartbeatMessage,
  type PkInputMessage,
  type PkJoinMessage,
  type PkWebrtcSignalMessage,
  type PlayerSlot,
} from './pkProtocol'

const LAN_IP_STORAGE_KEY = 'pk-lan-ip'
const JUMP_DURATION_MS = 500
const JUMP_HEIGHT = 0.6 // 跳躍最高點相對於角色自身高度（rig.height）的比例
const HIT_FLASH_MS = 180
// 移動：世界座標單位/秒，依角色身高換算（見 updateMovement()），不是寫死的絕對速度。
const MOVE_SPEED_HEIGHT_RATIO = 0.8
// 兩個角色最近可以貼多近（世界座標單位，依角色身高換算）——不能真的重疊在一起，
// 也不能穿過對方。
const MIN_GAP_HEIGHT_RATIO = 0.4
// 後退邊界比出生點（baseX）再往外推多少倍——使用者實測回報「兩個角色都退不到畫面
// 邊界」：原本後退邊界就是 baseX 本身，但固定鏡頭實際框到的範圍比出生點的位置寬，
// 導致畫面兩側留了一截角色永遠到不了的空白。1.6 是抓鏡頭大概拍多寬的合理猜測（沒有
// 反過來從 camera FOV／位置精算實際可視範圍的每個像素，那樣太精密，這個只是「肉眼
// 看起來能退到接近畫面邊緣」的量體），不是精算出來的邊界。
const RETREAT_LIMIT_FACTOR = 1.6
// 「前進」對每個 slot 來說是世界座標哪個方向：玩家一站在 -X 那側、面向 +X（見
// loadScene() 的 rotation.y 設定），前進＝往 +X；玩家二相反，前進＝往 -X。
// 2026-08-18 修正：玩家二站在畫面右邊，實測回報她的移動方向感覺反了——把
// player2 的方向係數從 -1 改成 1 修正。
const ADVANCE_DIRECTION: Record<PlayerSlot, number> = { player1: 1, player2: 1 }
// 攻擊動畫播到「這個比例」的時間點才真的判定命中/扣血，不是事件一到就立刻算——見
// handleInputEvent() 攻擊分支的完整說明。0.35 是合理猜測（一般揮擊動作前段是蓄力/
// 起手，命中通常落在前段偏後一點），沒有實機對過影格，之後手感不對可以直接調這個
// 數字，不影響其他邏輯。
const ATTACK_IMPACT_FRACTION = 0.35
// 傳給玩家二的畫面更新頻率，不是遊戲本身的幀率（three.js render loop 本身無上限）。
// 區網頻寬很充裕，20fps 足夠讓玩家二看得順、又不會傳太肥。
const WEBRTC_FPS = 20

// 主持人（擂台端）本人就是玩家一，開場不用等第二支手機——只有「對手」是遠端手機
// 加入的玩家二（見使用者需求：「主持人同樣為玩家1，當有人連線後就視為玩家2，遊戲
// 隨即開始」）。LOCAL_PLAYER_ID 現在搬到 pkProtocol.ts 當共用常數——操控端要同步看
// 擂台端畫面（WebRTC），需要知道「擂台端訊令信箱」在哪，見那邊的說明。
const ATTACK_GESTURE = 'Closed_Fist'
const JUMP_GESTURE = 'Victory'
const WASM_BASE_URL = '/mediapipe/wasm'
const MODEL_ASSET_PATH = '/mediapipe/models/gesture_recognizer.task'

// 跟 aatrox-gesture/AatroxGestureTrigger.tsx、pk-mode/PkControllerView.tsx 同一份骨架
// 拓樸/畫法，量體小不值得抽共用模組（見那兩個檔案的說明）。
const HAND_CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
]

function buildRecognizerOptions(delegate: 'GPU' | 'CPU') {
  return {
    baseOptions: { modelAssetPath: MODEL_ASSET_PATH, delegate },
    runningMode: 'VIDEO' as const,
    numHands: 1,
  }
}

// 2026-08-18：把瀏覽器實際回報的錯誤名稱/訊息一起顯示，理由跟
// PkControllerView.tsx 的 describeError() 一樣——實測發現外接 USB 攝影機常見的失敗
// 方式（Windows 相機 App 開得起來、瀏覽器卻連不上）通常是 NotReadableError（被其他
// 程式占用）或 OverconstrainedError（facingMode 約束，見下面 getUserMedia 呼叫已拿掉
// 這個約束），只給「權限被拒絕」這一種文案會誤導使用者去檢查錯的地方。
function describeCameraError(err: unknown): string {
  // navigator.mediaDevices 整個不存在（見上面 setup() 的檢查）：這台裝置本身沒問題，
  // 是這個頁面不是 secure context。玩家一通常跟 dev server 同一台機器，最直接的解法
  // 就是改用 http://localhost:<port>（不要用區網 IP）開這個頁面——這是實測踩過的
  // 真實案例，不是理論上的風險，見 docs/specs/0013「已知風險」。
  if (err instanceof Error && err.message === 'insecure-context') {
    return '這個網址不是安全來源（secure context），瀏覽器直接不提供鏡頭功能——請改用 http://localhost:<port>（不要用區網 IP，例如 http://192.168.x.x:...）重新開啟這個頁面再試一次'
  }
  const detail = err instanceof DOMException ? `${err.name}${err.message ? `：${err.message}` : ''}` : String(err)
  if (err instanceof DOMException && err.name === 'NotAllowedError') {
    return `鏡頭權限被拒絕（${detail}）——你是玩家一，沒有鏡頭權限就沒辦法出手，請到瀏覽器網址列確認鏡頭權限後點下面「重試」`
  }
  if (err instanceof DOMException && (err.name === 'NotReadableError' || err.name === 'TrackStartError')) {
    return `鏡頭讀取失敗（${detail}）——通常是被另一個程式占用中（例如 Windows 相機 App、視訊會議軟體開著），關掉後點「重試」`
  }
  if (err instanceof DOMException && (err.name === 'NotFoundError' || err.name === 'OverconstrainedError')) {
    return `找不到符合條件的鏡頭（${detail}）——如果是外接 USB 攝影機，確認 Windows 有正確辨識到這台裝置`
  }
  return `鏡頭目前無法使用（${detail}），請確認瀏覽器支援鏡頭存取後點下面「重試」`
}

type CharacterRig = {
  root: THREE.Object3D
  mixer: THREE.AnimationMixer
  clips: THREE.AnimationClip[]
  currentAction: THREE.AnimationAction | null
  desiredAnim: string
  baseY: number
  baseX: number
  // 後退最遠可以到哪裡（世界座標）——不是 baseX 本身，是比 baseX 更外側一點，讓角色
  // 退得到鏡頭實際框到的畫面邊緣，見 RETREAT_LIMIT_FACTOR 的說明。「再來一局」歸位
  // 用的還是 baseX（比賽開始時的定位），這個欄位只給 updateMovement() 的後退邊界用。
  retreatLimitX: number
  height: number
  jumpStartedAt: number | null
  hitFlashUntil: number
  flashPainted: boolean
  originalEmissive: Map<THREE.Material, THREE.Color>
  // 手在鏡頭畫面左右位置換算出來的「前進意圖」，-1..1，見 pkMovement.ts。每幀
  // updateMovement() 讀這個值換算成實際位移，跟 jumpStartedAt 一樣是純視覺狀態，
  // 不進 pkMatchState.ts 的比賽狀態機。
  moveInput: number
  // 出拳時鎖住到這個時間點（performance.now() 的毫秒數，0＝目前沒鎖）為止，移動控制
  // 指令一律忽略——使用者需求「進行攻擊時，讓移動控制指令失效」：角色揮拳時應該是
  // 定住不動的，不能邊揮拳邊被移動指令拖著滑動，跟大部分格鬥遊戲「出招中不能移動」
  // 是同一個直覺。2026-08-18 兩次調整鎖定時長：第一次鎖整段動畫（1.0）發現命中後的
  // 收拳尾段會變成明顯僵住的空窗；改成只鎖到 0.6 之後，使用者再回報「攻擊特效觸發後
  // 馬上解除移動鎖定」——**現在鎖住的時長直接等於命中判定延遲（impactDelayMs，見
  // handleInputEvent 攻擊分支），命中特效一觸發，移動控制立刻解鎖**，不再是動畫時長
  // 的某個比例，銜接感最流暢。
  attackLockedUntil: number
  // 每次揮拳遞增的序號，讓「延後到揮擊命中那一刻才判定」的 setTimeout callback
  // 知道自己是不是已經被下一拳取代（見 handleInputEvent 的攻擊分支「動畫幀跟扣血
  // 時機沒對上」那段說明），舊的 callback 觸發時比對序號不符就直接不算數。
  attackToken: number
}

// force=true 讓同一個 clip 也能重新從頭播——攻擊要用這個：使用者連續出拳時，每一拳
// 都要重新揮一次，不能因為「desiredAnim 已經是 Attack2 了」就被當成沒事發生而跳過
// （這正是「動畫幀跟扣血時機沒對上」那個回報的其中一個成因：以前連續攻擊時動畫沒有
// 真的重播，但命中判定照樣每次都算，視覺上完全對不起來）。idle/defense（loop）/death
// 不需要 force，維持原本「已經在播同一個就不重新觸發」的行為。
function playClip(rig: CharacterRig, name: string, loop: boolean, fadeSec = 0.15, force = false) {
  if (!name || (rig.desiredAnim === name && !force)) return
  const clip = rig.clips.find((c) => c.name === name)
  if (!clip) return
  rig.desiredAnim = name
  const next = rig.mixer.clipAction(clip)
  next.reset()
  if (loop) {
    next.setLoop(THREE.LoopRepeat, Infinity)
    next.clampWhenFinished = false
  } else {
    next.setLoop(THREE.LoopOnce, 1)
    next.clampWhenFinished = true
  }
  if (rig.currentAction && rig.currentAction !== next) rig.currentAction.fadeOut(fadeSec)
  next.fadeIn(fadeSec).play()
  rig.currentAction = next
}

async function loadCharacter(animations: PkCharacterAnimations): Promise<{ root: THREE.Object3D; mixer: THREE.AnimationMixer; clips: THREE.AnimationClip[]; height: number }> {
  const loader = new GLTFLoader()
  const gltf = await loader.loadAsync(animations.modelUrl)
  const root = gltf.scene
  const box = new THREE.Box3().setFromObject(root)
  const size = box.getSize(new THREE.Vector3())
  const clips = gltf.animations ?? []
  const mixer = new THREE.AnimationMixer(root)
  return { root, mixer, clips, height: size.y || 1 }
}

// 手勢 PK 對戰模式的擂台端：全螢幕顯示兩個 3D 角色對打，做命中判定、播動畫、顯示血量。
// 是這場對戰唯一的「真相來源」（見 docs/adr/0014）——操控端（PkControllerView.tsx）
// 完全不做 3D 渲染，只送離散的手勢事件過來。見 docs/specs/0013。
export function PkArenaView({ onExit }: { onExit: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [uiState, setUiState] = useState<PkArenaState>(INITIAL_ARENA_STATE)

  // 加入網址／QR code：瀏覽器裡的 JS 沒有標準 API 能直接讀到「自己這台機器的區網
  // IP」，但 Vite dev server 啟動時本來就會在終端機印一行「Network: http://<IP>:...」
  // ——那個值是 vite.config.ts 用 Node 的 os.networkInterfaces() 算出來的，透過 define
  // 注入成 __PK_LAN_IP__ 這個編譯期常數（見 vite.config.ts、src/vite-env.d.ts），這裡
  // 直接拿來當預設值，使用者大多數情況下完全不用手動輸入。localStorage 存的值優先
  // （代表使用者之前手動覆寫過，例如多網卡環境自動偵測到錯的那張卡），沒存過才退回
  // 自動偵測到的 IP；兩者都沒有（本機沒有非 loopback 的網卡，或 build 產物搬到別台
  // 機器跑）才會是空字串，顯示手動輸入欄位。如果這個頁面本來就是用區網 IP 開的
  // （不是 localhost），這整套都用不到，直接沿用現有 hostname。
  const [lanIp, setLanIp] = useState(() => window.localStorage.getItem(LAN_IP_STORAGE_KEY) ?? __PK_LAN_IP__ ?? '')
  const [joinUrl, setJoinUrl] = useState<string | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)

  function handleLanIpChange(value: string) {
    setLanIp(value)
    // 存空字串會卡住下次自動偵測的 fallback（''.trim() 不是 null/undefined，
    // ?? __PK_LAN_IP__ 不會觸發）——清空時整個移除這個 key，下次開 PK 模式才會
    // 重新退回自動偵測到的 IP，不會卡在「曾經手動清空過」的狀態。
    if (value) window.localStorage.setItem(LAN_IP_STORAGE_KEY, value)
    else window.localStorage.removeItem(LAN_IP_STORAGE_KEY)
  }

  // ── 玩家一（主持人本人）的鏡頭＋手勢辨識 ──────────────────────────────────
  // 這一整組狀態/ref 是玩家一專用的攝影機授權流程：requesting→active／error，
  // error 時畫面要能重試（cameraRetryToken 遞增讓下面獨立的 camera effect 重新跑一次，
  // 見那個 effect 的說明）。跟 PkControllerView.tsx 給遠端玩家二用的是同一套手勢判定
  // 邏輯（gestureTriggerState/pkDefenseState），只是輸出的地方不同：玩家二用 MQTT
  // 發布 pk/input，玩家一直接呼叫 handleInputEventRef.current()（見下方，橋接進主
  // effect 的比賽狀態機，不繞一圈 MQTT 自己發給自己）。
  const [localCameraStatus, setLocalCameraStatus] = useState<'requesting' | 'active' | 'error'>('requesting')
  const [localCameraError, setLocalCameraError] = useState<string | null>(null)
  const [localGestureLabel, setLocalGestureLabel] = useState('未偵測到手')
  const [cameraRetryToken, setCameraRetryToken] = useState(0)
  const videoRef = useRef<HTMLVideoElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const localDefendingRef = useRef(false)
  // 兩個橋接點，由下面「MQTT + 比賽狀態機」那個 effect 賦值，讓「玩家一鏡頭」這個
  // 獨立 effect（生命週期綁 cameraRetryToken，重試時只重跑這個，不影響 MQTT 連線／
  // three.js 場景）可以呼叫得到——跟 Aatrox3DShowcase.tsx 的 triggerSelectedActionRef
  // 是同一種「平行掛載的兩個 effect 只透過 ref 溝通」橋接模式。
  const handleInputEventRef = useRef<(message: PkInputMessage) => void>(() => {})
  const joinAsPlayer1Ref = useRef<() => void>(() => {})
  // 「再來一局」按鈕（見下面 JSX 的 finished 階段畫面）用同一種 ref 橋接模式呼叫。
  const rematchRef = useRef<() => void>(() => {})
  // 「單人測試模式」按鈕（見下面 JSX 的 waiting 階段畫面）：主持人排除問題用，跳過
  // 等待玩家二，同一種 ref 橋接模式呼叫。
  const soloDebugRef = useRef<() => void>(() => {})

  // ── 全螢幕 + ESC：真正呼叫 requestFullscreen() 那一步刻意不在這裡——已經在
  // DesktopPetPage.tsx 的按鈕 onClick（enterPkArena()）裡跟使用者手勢同步呼叫過了
  // （見那邊的說明：非同步的 useEffect 裡才呼叫，部分瀏覽器不會再認可是使用者觸發）。
  // 這裡只負責監聽 fullscreenchange：離開全螢幕（不管是按 ESC 還是畫面上的退出鈕呼叫
  // exitFullscreen()）都走這一條路徑結束整場 PK，見 docs/specs/0013「全螢幕與 ESC」。
  useEffect(() => {
    function handleFullscreenChange() {
      if (!document.fullscreenElement) onExit()
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onExit 是父層傳入、掛載時的那一份即可，不需要重新註冊
  }, [])

  useEffect(() => {
    setJoinUrl(
      buildJoinUrl({
        protocol: window.location.protocol,
        hostname: window.location.hostname,
        port: window.location.port,
        lanIp,
      }),
    )
  }, [lanIp])

  // joinUrl 確定下來才產生 QR code 圖片（QRCode.toDataURL 是非同步的，cancelled 旗標
  // 避免使用者連續改動 lanIp 輸入框時，舊的產生請求晚回來把新的圖蓋掉）。
  useEffect(() => {
    if (!joinUrl) {
      setQrDataUrl(null)
      return
    }
    let cancelled = false
    QRCode.toDataURL(joinUrl, { margin: 1, width: 220 })
      .then((dataUrl) => {
        if (!cancelled) setQrDataUrl(dataUrl)
      })
      .catch((err) => console.error('[PkArenaView] QR code 產生失敗（已忽略，仍可用文字網址）：', err))
    return () => {
      cancelled = true
    }
  }, [joinUrl])

  // ── MQTT + 比賽狀態機 ────────────────────────────────────────────────────
  useEffect(() => {
    const arenaStateRef = { current: INITIAL_ARENA_STATE as PkArenaState }
    const rigsRef: Partial<Record<PlayerSlot, CharacterRig>> = {}

    const url = pkMqttUrl(window.location.hostname, window.location.protocol, 9001)
    const client: MqttClient = mqtt.connect(url, { reconnectPeriod: 3000 })

    // 擂台端畫面同步給玩家二看（WebRTC，見 pkProtocol.ts 的說明）：這個 PC 是唯一一個
    // ——PK 模式永遠只有一個廣播者（擂台端）＋一個觀眾（玩家二），不用像
    // multi/VoiceBroadcastModule.js 那樣管一個 { targetId: pc } 的字典。canvasStream
    // 要等 renderer 建立好（見下面 three.js 場景那段）才有東西可以擷取，但這裡先宣告
    // 兩個 let，startBroadcastTo() 定義在 renderer 建立之後、只在收到 MQTT 訊息時才會
    // 被呼叫，那時候 renderer 一定已經存在了。
    let outPeerConnection: RTCPeerConnection | null = null
    let outPeerTargetId: string | null = null

    function publishState() {
      client.publish(PK_TOPICS.STATE, JSON.stringify(toWireState(arenaStateRef.current)), { qos: 1, retain: true })
      setUiState(arenaStateRef.current)
    }

    function reactToChange(prev: PkArenaState, next: PkArenaState) {
      for (const slot of ['player1', 'player2'] as const) {
        const prevP = prev[slot]
        const nextP = next[slot]
        const rig = rigsRef[slot]
        if (!prevP || !nextP || !rig) continue
        if (nextP.hp < prevP.hp) flashHit(rig)
        if (nextP.defending !== prevP.defending) {
          if (nextP.defending) playClip(rig, PK_ANIMATION_MAP[slot].defense, true)
          else playClip(rig, PK_ANIMATION_MAP[slot].idle, false)
        }
      }
      if (next.phase === 'finished' && prev.phase !== 'finished' && next.winner) {
        const loserSlot: PlayerSlot = next.winner === 'player1' ? 'player2' : 'player1'
        const loserRig = rigsRef[loserSlot]
        if (loserRig) playClip(loserRig, PK_ANIMATION_MAP[loserSlot].death, false)
      }
    }

    function flashHit(rig: CharacterRig) {
      rig.hitFlashUntil = performance.now() + HIT_FLASH_MS
    }

    function applyAndPublish(mutator: (state: PkArenaState) => PkArenaState) {
      const prev = arenaStateRef.current
      const next = mutator(prev)
      arenaStateRef.current = next
      if (next !== prev) {
        reactToChange(prev, next)
        publishState()
      }
    }

    // 攻擊要靠近對方身體才搆得到（見 docs/adr/0014「攻擊改成需要距離夠近」）——依兩個
    // 角色實際載入後的身高換算，不是寫死的絕對距離。
    function isWithinAttackRange(rig: CharacterRig, opponentRig: CharacterRig): boolean {
      const range = Math.max(rig.height, opponentRig.height) * ATTACK_RANGE_HEIGHT_RATIO
      return Math.abs(rig.root.position.x - opponentRig.root.position.x) <= range
    }

    function getClipDurationMs(rig: CharacterRig, name: string): number {
      const clip = rig.clips.find((c) => c.name === name)
      return clip ? clip.duration * 1000 : 0
    }

    // 攻擊/跳躍/防禦/移動事件的共用處理：玩家二（遠端手機）透過 MQTT pk/input 送進來，
    // 玩家一（本人，見下面 handleInputEventRef 賦值）透過 ref 直接呼叫，兩邊共用同一套
    // 「套用狀態機→若在 battle 階段才觸發對應視覺效果」邏輯，不重複寫兩次。
    function handleInputEvent(message: PkInputMessage) {
      const stateBeforeInput = arenaStateRef.current
      const wasBattling = stateBeforeInput.phase === 'battle'
      const slot = slotForPlayerId(stateBeforeInput, message.playerId)
      const rig = slot ? rigsRef[slot] : null

      if (message.type === 'move') {
        // 純視覺位移，不進 pkMatchState.ts 的狀態機，不需要呼叫 applyAndPublish。
        // 出拳鎖住期間（attackLockedUntil）忽略移動指令，見 CharacterRig.attackLockedUntil
        // 的說明——揮拳中角色應該定住不動，不能被移動指令拖著滑動。
        if (rig && wasBattling && performance.now() >= rig.attackLockedUntil) rig.moveInput = message.value
        return
      }

      if (message.type === 'attack' && wasBattling && slot && rig) {
        // 揮拳的動作立刻播出去（響應要即時），force:true 讓連續出拳每一拳都重新播放
        // ——不會因為「desiredAnim 已經是 Attack2」被 playClip 的既有去重邏輯當成沒事
        // 發生而跳過。命中判定則延後到揮擊動畫播到 ATTACK_IMPACT_FRACTION 那個時間點
        // 才真的算，用這個角色實際載入的攻擊 clip 長度換算延遲，不是寫死的絕對毫秒數
        // （兩個角色的 Attack2 clip 長度不保證一樣）——這兩點合起來解決使用者回報的
        // 「動畫幀跟扣血時機沒對上」：以前是「事件一到就立刻扣血，動畫播不播、播到哪
        // 都無所謂」，現在扣血真的等到揮擊動畫播到「揮出去」那個時間點才發生，而且
        // 每次出拳都保證有對應的一次完整揮擊動畫可看。
        playClip(rig, PK_ANIMATION_MAP[slot].attack, false, 0.1, true)
        const attackSlot = slot
        const attackRig = rig
        const token = ++attackRig.attackToken
        const attackDurationMs = getClipDurationMs(attackRig, PK_ANIMATION_MAP[attackSlot].attack)
        const impactDelayMs = attackDurationMs * ATTACK_IMPACT_FRACTION
        // 出拳當下立刻定住（歸零 moveInput）＋鎖住到命中判定那一刻（impactDelayMs）
        // 為止，見 CharacterRig.attackLockedUntil 的說明（使用者需求：「進行攻擊時，
        // 讓移動控制指令失效」，兩輪後續調整：先改成只鎖動畫時長的 0.6，再依使用者
        // 要求「攻擊特效觸發後馬上解除移動鎖定」，改成直接鎖到跟命中判定同一個時間
        // 點）。動畫本身仍然完整播到底（playClip 沒有被截斷），只是移動控制在命中
        // 特效觸發的當下就解鎖，不用等收拳動作播完。
        attackRig.moveInput = 0
        attackRig.attackLockedUntil = performance.now() + impactDelayMs
        window.setTimeout(() => {
          // destroyed 是這個大 effect 稍後（three.js 場景那段）宣告的旗標，卸載時會
          // 設成 true——閉包會抓到最新值，不用另外傳參數。attackToken 不符代表這拳
          // 已經被使用者緊接着的下一拳取代，這次延後判定的命中直接作廢（跟動畫視覺
          // 只看得到最新那一拳一致，不會「看到揮第二拳、卻扣到第一拳的血」）。
          if (destroyed || attackRig.attackToken !== token) return
          // 使用者回報「攻擊動作後半段還是太長了」：光是提早解鎖移動控制還不夠，揮擊
          // 動畫本身的收拳/回防尾段一樣拖得太長——命中特效觸發的同時，直接淡出切回
          // 待機動畫，不等 Attack clip 自然播完，把尾段真的剪掉，不是只讓角色能動而
          // 已。跟命中判定結果無關（不管這拳有沒有真的打中在攻擊距離內的對手，動畫
          // 該收就收），所以放在下面的距離判定之前。force 用預設值（false）就好——
          // 這裡切換到的是 idle，跟目前 desiredAnim（攻擊 clip）不同名字，去重邏輯
          // 本來就不會擋下來；如果使用者緊接著又出下一拳，attackToken 已經不符，這段
          // 根本不會執行到，不會跟下一拳的 force:true 揮擊動畫互搶。
          playClip(attackRig, PK_ANIMATION_MAP[attackSlot].idle, false)
          if (arenaStateRef.current.phase !== 'battle') return
          const opponentSlot: PlayerSlot = attackSlot === 'player1' ? 'player2' : 'player1'
          const opponentRig = rigsRef[opponentSlot]
          // 命中判定用「揮擊命中那一刻」的位置，不是「出拳那一刻」——延遲期間任一方
          // 可能還在移動，這樣才符合「打到了才算」的直覺。
          if (!opponentRig || !isWithinAttackRange(attackRig, opponentRig)) return
          applyAndPublish((state) => applyInput(state, message, performance.now()))
        }, impactDelayMs)
        return
      }

      applyAndPublish((state) => applyInput(state, message, performance.now()))

      if (!wasBattling || !rig) return
      if (message.type === 'jump' && rig.jumpStartedAt === null) rig.jumpStartedAt = performance.now()
    }
    handleInputEventRef.current = handleInputEvent
    joinAsPlayer1Ref.current = () => applyAndPublish((state) => applyJoin(state, LOCAL_PLAYER_ID, performance.now(), 'player1'))
    soloDebugRef.current = () => applyAndPublish((state) => startSoloBattle(state))

    // 「再來一局」：pkMatchState.ts 的 resetMatch() 只管血量/回合這些規則層的重置，
    // 角色的視覺狀態（位置、跳躍中、受擊閃紅、正在播的動畫）完全是 PkArenaView.tsx
    // 自己管的東西，reducer 不知道也不需要知道，這裡負責歸位。
    rematchRef.current = () => {
      for (const slot of ['player1', 'player2'] as const) {
        const rig = rigsRef[slot]
        if (!rig) continue
        rig.root.position.x = rig.baseX
        rig.root.position.y = rig.baseY
        rig.moveInput = 0
        rig.jumpStartedAt = null
        rig.hitFlashUntil = 0
        rig.attackLockedUntil = 0
        playClip(rig, PK_ANIMATION_MAP[slot].idle, false, 0.15, true)
      }
      applyAndPublish((state) => resetMatch(state, performance.now()))
    }

    function publishSignal(targetId: string, message: PkWebrtcSignalMessage) {
      client.publish(PK_WEBRTC_SIGNAL_PREFIX + targetId, JSON.stringify(message))
    }

    // 玩家二（重新）請求畫面時呼叫——不管是第一次加入還是重新整理操控頁重連，都是
    // 同一條路徑（跟 multi/VoiceBroadcastModule.js 的 _handlePull() 同一個道理），不用
    // 特別區分「第一次」跟「重連」。舊的 peer connection（如果有）先關掉再建新的，
    // 不會累積殘留連線。
    async function startBroadcastTo(targetId: string) {
      outPeerConnection?.close()
      const pc = new RTCPeerConnection({ iceServers: WEBRTC_ICE_SERVERS })
      outPeerConnection = pc
      outPeerTargetId = targetId

      // captureStream() 直接擷取 three.js 的 renderer.domElement（WebGLRenderer 自己
      // 建立、附加進 host 的那個 <canvas>），畫面上看到什麼就傳什麼，不需要另外做
      // 離屏渲染或截圖。WEBRTC_FPS 是「畫面更新頻率」，不是攻擊/移動判定的幀率，跟
      // three.js 本身的 render loop（那個是無上限，盡量跑）是兩件事。
      const canvasStream = (renderer.domElement as HTMLCanvasElement & { captureStream: (fps?: number) => MediaStream }).captureStream(WEBRTC_FPS)
      for (const track of canvasStream.getVideoTracks()) {
        // contentHint='detail'：WebRTC 預設把 canvas/screen 這類來源當成一般視訊通話
        // 處理，編碼器會優先顧「流暢度」（motion）犧牲清晰度，這正是使用者回報「畫質
        // 有點模糊」的主因——這個角色展示畫面／血量文字要看得清楚，動作流不流暢反而
        // 其次，明確告訴瀏覽器要優先顧清晰度。
        track.contentHint = 'detail'
        const sender = pc.addTrack(track, canvasStream)
        // 預設的 bitrate 上限通常是為了一般視訊通話（一張臉，動態範圍小）調的，對這種
        // 內容豐富的 3D 場景＋文字 UI 明顯不夠，畫面會被壓得糊糊的。明確拉高
        // maxBitrate（3Mbps，區網頻寬綽綽有餘）。setParameters() 失敗（例如某些瀏覽器
        // 在 addTrack 剛完成、還沒協商過一輪就呼叫會拒絕）不影響功能，只是retain
        // 預設畫質，用 catch 吞掉不讓它變成沒處理的 rejection。
        const params = sender.getParameters()
        params.encodings = params.encodings?.length ? params.encodings : [{}]
        params.encodings[0].maxBitrate = 3_000_000
        sender.setParameters(params).catch(() => {})
      }

      pc.onicecandidate = ({ candidate }) => {
        if (candidate) publishSignal(targetId, { from: LOCAL_PLAYER_ID, type: 'ice', candidate: candidate.toJSON() })
      }
      pc.onconnectionstatechange = () => {
        if (['failed', 'disconnected', 'closed'].includes(pc.connectionState) && outPeerConnection === pc) {
          outPeerConnection = null
          outPeerTargetId = null
        }
      }

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      publishSignal(targetId, { from: LOCAL_PLAYER_ID, type: 'offer', sdp: pc.localDescription! })
    }

    client.on('connect', () => {
      client.subscribe([PK_TOPICS.JOIN, PK_TOPICS.INPUT, PK_TOPICS.HEARTBEAT, PK_WEBRTC_SIGNAL_PREFIX + LOCAL_PLAYER_ID], { qos: 1 })
      publishState()
    })

    client.on('message', (topic, payload) => {
      let data: unknown
      try {
        data = JSON.parse(payload.toString())
      } catch (err) {
        console.error('[PkArenaView] 解析 MQTT 訊息失敗（已忽略）：', topic, err)
        return
      }

      if (topic === PK_TOPICS.JOIN) {
        // MQTT pk/join 一律代表玩家二（遠端操控端）——玩家一（本人）永遠是上面
        // joinAsPlayer1Ref 那條本機直接呼叫的路徑，兩者不會因為訊息到達順序而互換
        // slot，見 pkMatchState.ts 的 applyJoin() 說明。
        const { playerId } = data as PkJoinMessage
        applyAndPublish((state) => applyJoin(state, playerId, performance.now(), 'player2'))
        return
      }

      if (topic === PK_TOPICS.HEARTBEAT) {
        const { playerId, defending } = data as PkHeartbeatMessage
        applyAndPublish((state) => applyHeartbeat(state, playerId, defending, performance.now()))
        return
      }

      if (topic === PK_TOPICS.INPUT) {
        handleInputEvent(data as PkInputMessage)
        return
      }

      if (topic === PK_WEBRTC_SIGNAL_PREFIX + LOCAL_PLAYER_ID) {
        const signal = data as PkWebrtcSignalMessage
        if (signal.type === 'pull') {
          startBroadcastTo(signal.from).catch((err) => console.error('[PkArenaView] 建立畫面同步失敗：', err))
          return
        }
        if (!outPeerConnection || outPeerTargetId !== signal.from) return // 不是目前這條連線的對象，忽略
        if (signal.type === 'answer') {
          outPeerConnection.setRemoteDescription(new RTCSessionDescription(signal.sdp)).catch((err) =>
            console.error('[PkArenaView] 套用畫面同步 answer 失敗：', err),
          )
        } else if (signal.type === 'ice') {
          outPeerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch(() => {})
        }
      }
    })

    const countdownIntervalId = window.setInterval(() => {
      if (arenaStateRef.current.phase !== 'countdown') return
      applyAndPublish((state) => tickCountdown(state))
    }, 1000)

    const offlineIntervalId = window.setInterval(() => {
      applyAndPublish((state) => markOffline(state, performance.now(), OFFLINE_MS))
    }, HEARTBEAT_MS)

    // 玩家一（本人）的心跳——跟玩家二透過 MQTT 送 pk/heartbeat 是同一個目的（讓
    // markOffline 不會誤判離線），但玩家一是同一個瀏覽器分頁，不需要真的走網路，
    // 直接呼叫 applyHeartbeat。在真正 join 成功（見下面 camera effect）之前呼叫
    // 也無妨——applyHeartbeat 對不認得的 playerId 直接原樣回傳，是安全的 no-op。
    const localHeartbeatIntervalId = window.setInterval(() => {
      applyAndPublish((state) => applyHeartbeat(state, LOCAL_PLAYER_ID, localDefendingRef.current, performance.now()))
    }, HEARTBEAT_MS)

    // ── three.js 場景：兩個角色固定面對面，沒有 OrbitControls（擂台端鏡頭固定，
    // 不像單人展示卡讓使用者自由轉視角）──────────────────────────────────
    const host = hostRef.current!
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.05, 1000)
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setSize(window.innerWidth, window.innerHeight)
    host.appendChild(renderer.domElement)

    scene.add(new THREE.AmbientLight(0xffffff, 1.2))
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.5)
    dirLight.position.set(3, 5, 4)
    scene.add(dirLight)

    let destroyed = false
    let rafId = 0
    const clock = new THREE.Clock()

    async function loadScene() {
      const [char1, char2] = await Promise.all([
        loadCharacter(PK_ANIMATION_MAP.player1),
        loadCharacter(PK_ANIMATION_MAP.player2),
      ])
      if (destroyed) return

      const maxHeight = Math.max(char1.height, char2.height)
      // 兩個角色分別站在世界座標 x=-gap/2、x=+gap/2，面對面（rotation.y 讓角色轉向對方）
      // ——這兩個角色預設朝向沒有真的在瀏覽器裡視覺驗證過，跟 Aatrox3DShowcase 的
      // WASD 移動一樣假設模型預設朝 -Z，這裡先給一個合理猜測，實際角度不對的話只是
      // 調整這兩個 rotation.y 常數，不影響其他邏輯（見 docs/specs/0013 待人工驗證）。
      const gap = maxHeight * 1.6
      char1.root.position.set(-gap / 2, 0, 0)
      char1.root.rotation.y = Math.PI / 2
      char2.root.position.set(gap / 2, 0, 0)
      char2.root.rotation.y = -Math.PI / 2
      scene.add(char1.root)
      scene.add(char2.root)

      const rig1: CharacterRig = {
        root: char1.root,
        mixer: char1.mixer,
        clips: char1.clips,
        currentAction: null,
        desiredAnim: '',
        baseY: char1.root.position.y,
        baseX: char1.root.position.x,
        retreatLimitX: char1.root.position.x * RETREAT_LIMIT_FACTOR,
        height: char1.height,
        jumpStartedAt: null,
        hitFlashUntil: 0,
        flashPainted: false,
        originalEmissive: new Map(),
        moveInput: 0,
        attackToken: 0,
        attackLockedUntil: 0,
      }
      const rig2: CharacterRig = {
        root: char2.root,
        mixer: char2.mixer,
        clips: char2.clips,
        currentAction: null,
        desiredAnim: '',
        baseY: char2.root.position.y,
        baseX: char2.root.position.x,
        retreatLimitX: char2.root.position.x * RETREAT_LIMIT_FACTOR,
        height: char2.height,
        jumpStartedAt: null,
        hitFlashUntil: 0,
        flashPainted: false,
        originalEmissive: new Map(),
        moveInput: 0,
        attackToken: 0,
        attackLockedUntil: 0,
      }
      rigsRef.player1 = rig1
      rigsRef.player2 = rig2
      playClip(rig1, PK_ANIMATION_MAP.player1.idle, false)
      playClip(rig2, PK_ANIMATION_MAP.player2.idle, false)

      // 固定鏡頭：從兩個角色連線中點的側前方拍過去，距離依角色高度換算，兩人都在畫面內。
      camera.position.set(0, maxHeight * 0.9, gap * 1.3)
      camera.lookAt(0, maxHeight * 0.5, 0)
      camera.near = maxHeight / 100
      camera.far = maxHeight * 100
      camera.updateProjectionMatrix()
    }
    loadScene().catch((err) => console.error('[PkArenaView] 角色模型載入失敗：', err))

    // 受擊材質變紅：只在「開始閃紅」跟「結束閃紅」這兩個邊緣才真的走一次
    // rig.root.traverse()（遍歷全部 mesh/material），閃紅持續期間／完全沒被打過的
    // 幀數都直接跳過——不然兩個角色 60fps 逐幀全樹遍歷是白白浪費的效能。
    function applyHitFlash(rig: CharacterRig, now: number) {
      const active = now < rig.hitFlashUntil
      if (active === rig.flashPainted) return
      rig.flashPainted = active
      rig.root.traverse((obj) => {
        const mesh = obj as THREE.Mesh
        if (!mesh.isMesh) return
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        for (const mat of materials) {
          const m = mat as THREE.MeshStandardMaterial
          if (!m || !('emissive' in m)) continue
          if (active) {
            if (!rig.originalEmissive.has(m)) rig.originalEmissive.set(m, m.emissive.clone())
            m.emissive.setRGB(0.9, 0.1, 0.1)
          } else if (rig.originalEmissive.has(m)) {
            m.emissive.copy(rig.originalEmissive.get(m)!)
          }
        }
      })
    }

    function updateJump(rig: CharacterRig, now: number) {
      if (rig.jumpStartedAt === null) return
      const elapsed = now - rig.jumpStartedAt
      if (elapsed >= JUMP_DURATION_MS) {
        rig.root.position.y = rig.baseY
        rig.jumpStartedAt = null
        return
      }
      const t = elapsed / JUMP_DURATION_MS
      rig.root.position.y = rig.baseY + Math.sin(t * Math.PI) * JUMP_HEIGHT * rig.height
    }

    // 手在畫面左右位置連續控制前進/後退（見 pkMovement.ts、docs/adr/0014「攻擊改成
    // 需要距離夠近」）。每個角色只能沿著自己面對對手的那條軸移動，不能退得比出生點
    // （baseX）還遠、也不能真的貼到/穿過對方——後面那個限制要等兩個角色都各自更新完
    // 位置才能一起算，所以分成 updateMovement()（單一角色，含出生點邊界）跟
    // clampMutualGap()（兩個角色一起算，含互相不能穿越的邊界）兩段。
    function updateMovement(rig: CharacterRig, slot: PlayerSlot, delta: number) {
      if (rig.moveInput === 0) return
      const speed = rig.height * MOVE_SPEED_HEIGHT_RATIO
      const nextX = rig.root.position.x + rig.moveInput * ADVANCE_DIRECTION[slot] * speed * delta
      // 不能退得比後退邊界（retreatLimitX）還遠——出生點在 -X 那側的角色（玩家一），
      // 合法範圍是 [retreatLimitX, +∞)；出生點在 +X 那側的角色（玩家二），合法範圍是
      // (-∞, retreatLimitX]。retreatLimitX 比 baseX 更外側，見其定義處的說明。
      rig.root.position.x = rig.retreatLimitX < 0 ? Math.max(nextX, rig.retreatLimitX) : Math.min(nextX, rig.retreatLimitX)
    }

    function clampMutualGap(rig1: CharacterRig, rig2: CharacterRig) {
      const minGap = Math.max(rig1.height, rig2.height) * MIN_GAP_HEIGHT_RATIO
      const gap = rig2.root.position.x - rig1.root.position.x
      if (gap >= minGap) return
      // 兩個角色各退回一半，維持最小距離，不會因為誰移動得比較快就整個被推開/穿過去。
      const overlap = minGap - gap
      rig1.root.position.x -= overlap / 2
      rig2.root.position.x += overlap / 2
    }

    function tick() {
      rafId = requestAnimationFrame(tick)
      const delta = clock.getDelta()
      const now = performance.now()
      for (const slot of ['player1', 'player2'] as const) {
        const rig = rigsRef[slot]
        if (!rig) continue
        rig.mixer.update(delta)
        updateMovement(rig, slot, delta)
        updateJump(rig, now)
        applyHitFlash(rig, now)
      }
      if (rigsRef.player1 && rigsRef.player2) clampMutualGap(rigsRef.player1, rigsRef.player2)
      renderer.render(scene, camera)
    }
    tick()

    function handleResize() {
      camera.aspect = window.innerWidth / window.innerHeight
      camera.updateProjectionMatrix()
      renderer.setSize(window.innerWidth, window.innerHeight)
    }
    window.addEventListener('resize', handleResize)

    return () => {
      destroyed = true
      window.clearInterval(countdownIntervalId)
      window.clearInterval(offlineIntervalId)
      window.clearInterval(localHeartbeatIntervalId)
      window.removeEventListener('resize', handleResize)
      cancelAnimationFrame(rafId)
      outPeerConnection?.close()
      client.end(true)
      for (const slot of ['player1', 'player2'] as const) {
        const rig = rigsRef[slot]
        if (!rig) continue
        scene.traverse((obj) => {
          const mesh = obj as THREE.Mesh
          if (!mesh.isMesh) return
          mesh.geometry?.dispose()
          const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
          for (const mat of materials) mat?.dispose?.()
        })
      }
      try {
        renderer.dispose()
      } catch (err) {
        console.error('[PkArenaView] renderer.dispose 失敗（已忽略）：', err)
      }
      renderer.domElement.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在掛載/卸載時跑一次
  }, [])

  // ── 玩家一（主持人本人）的鏡頭＋手勢辨識，獨立的 effect ──────────────────────
  // 刻意不塞進上面那個大 effect：鏡頭權限可能被拒絕，使用者要能單獨重試（按鈕把
  // cameraRetryToken +1，這個 effect 依賴它重新跑一次），不需要因此重新連 MQTT、
  // 重新載入兩個 3D 模型、把整場比賽狀態歸零——那些都跟「鏡頭有沒有權限」無關。
  // 透過 handleInputEventRef／joinAsPlayer1Ref 這兩個 ref 橋接進上面主 effect 的
  // 比賽狀態機（見那邊賦值處的說明），兩個 effect 平行運作、互不重新掛載對方。
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
    // 手離開畫面時重置回 null（不是留著舊值），見 pkMovement.ts smoothValue() 的說明。
    let smoothedTiltAngle: number | null = null

    setLocalCameraStatus('requesting')
    setLocalCameraError(null)

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
      setLocalGestureLabel(landmarks ? (gestureCategory && gestureCategory !== 'None' ? gestureCategory : '比個手勢試試') : '未偵測到手')

      const attackResult = updateEdgeTriggerState(attackState, gestureCategory, ATTACK_GESTURE)
      attackState = attackResult.state
      if (attackResult.fired) handleInputEventRef.current({ playerId: LOCAL_PLAYER_ID, type: 'attack' })

      const jumpResult = updateEdgeTriggerState(jumpState, gestureCategory, JUMP_GESTURE)
      jumpState = jumpResult.state
      if (jumpResult.fired) handleInputEventRef.current({ playerId: LOCAL_PLAYER_ID, type: 'jump' })

      const defenseResult = updateDefenseState(defenseState, gestureCategory)
      defenseState = defenseResult.state
      localDefendingRef.current = defenseState.defending
      if (defenseResult.changed) {
        handleInputEventRef.current({ playerId: LOCAL_PLAYER_ID, type: 'defense', defending: defenseState.defending })
      }

      // 移動：食指根部（landmarks[5]）相對於食指指尖（landmarks[8]）的傾斜角度連續
      // 控制前進/後退，跟手勢分類（gestureCategory）無關，手勢跟移動可以同時發生
      // （例如邊移動邊防禦）。2026-08-18 從「手在畫面裡的絕對位置」先改成「手腕傾斜
      // 角度」，使用者實測回報「單純手腕傾斜可能會誤判」（手掌整體移動/轉動就會被
      // 誤判成傾斜意圖）後，再改成量測食指自己的角度——向量完全落在食指這一節上，不
      // 經過手腕，見 pkMovement.ts 檔頭說明。本機直接呼叫，每幀都送沒有網路成本，不
      // 需要像 PkControllerView.tsx 那樣節流發布頻率。smoothValue() 平滑掉單幀雜訊，
      // 見 pkMovement.ts 說明（使用者實測回報「手放回中間有時角色還在動」，單靠死區
      // 不夠，加平滑才穩定）。
      if (landmarks) {
        smoothedTiltAngle = smoothValue(smoothedTiltAngle, mirrorAngle(handTiltAngle(landmarks[5], landmarks[8])))
      } else {
        smoothedTiltAngle = null // 手離開畫面，下次重新出現用新角度，不留舊的平滑殘留
      }
      const moveValue = smoothedTiltAngle !== null ? tiltToMoveValue(smoothedTiltAngle) : 0
      handleInputEventRef.current({ playerId: LOCAL_PLAYER_ID, type: 'move', value: moveValue })
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
      // 頁面不是 secure context（不是 https:// 也不是 localhost）——瀏覽器連 API 本身
      // 都不會給，這裡先擋一次，丟出一個好懂的訊息，不要讓後面 .getUserMedia() 直接
      // 對 undefined 取屬性炸出一句看不懂的 TypeError（使用者已經實際踩過這個坑，見
      // docs/specs/0013「已知風險」）。
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('insecure-context')

      const { FilesetResolver, GestureRecognizer } = await import('@mediapipe/tasks-vision')
      const vision = await FilesetResolver.forVisionTasks(WASM_BASE_URL)
      if (destroyed) return

      try {
        recognizer = await GestureRecognizer.createFromOptions(vision, buildRecognizerOptions('GPU'))
      } catch (err) {
        console.error('[PkArenaView] GPU delegate 建立失敗，改用 CPU 重試：', err)
        recognizer = await GestureRecognizer.createFromOptions(vision, buildRecognizerOptions('CPU'))
      }
      if (destroyed) {
        recognizer.close()
        return
      }

      // 不加 facingMode:'user'，見 PkControllerView.tsx 同一處的說明——外接 USB
      // 攝影機沒有「朝向」概念，這個約束在部分廠牌驅動上會直接讓 getUserMedia 失敗。
      stream = await navigator.mediaDevices.getUserMedia({ video: true })
      if (destroyed) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }

      videoEl.srcObject = stream
      await videoEl.play()
      if (destroyed) return

      setLocalCameraStatus('active')
      // 鏡頭真的授權成功才把自己加入比賽（成為玩家一）——如果還沒授權就先讓比賽
      // 開始，玩家一會卡在「明明是玩家一卻沒辦法出手」的破圖狀態，見使用者需求
      // 「確保有攝影機授權功能」，這裡是這個要求具體落地的地方。
      joinAsPlayer1Ref.current()
      rafId = requestAnimationFrame(loop)
    }

    setup().catch((err) => {
      console.error('[PkArenaView] 玩家一鏡頭啟用失敗：', err)
      if (destroyed) return
      setLocalCameraStatus('error')
      setLocalCameraError(describeCameraError(err))
    })

    return () => {
      destroyed = true
      if (rafId) cancelAnimationFrame(rafId)
      if (recognizer) {
        try {
          recognizer.close()
        } catch (err) {
          console.error('[PkArenaView] recognizer.close 失敗（已忽略）：', err)
        }
      }
      stream?.getTracks().forEach((t) => t.stop())
      videoEl.srcObject = null
    }
  }, [cameraRetryToken])

  return (
    <div className="fixed inset-0 z-50 bg-black text-white">
      <div ref={hostRef} className="absolute inset-0" />

      <button
        type="button"
        onClick={() => {
          if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
          else onExit()
        }}
        className="absolute right-4 top-4 rounded-full bg-white/10 px-4 py-2 text-sm font-medium backdrop-blur-sm hover:bg-white/20"
      >
        退出 PK 模式（或按 ESC）
      </button>

      {uiState.phase === 'waiting' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60 px-6 text-center">
          <p className="text-lg font-semibold">
            {uiState.player1 ? '等待對手加入' : '等待鏡頭授權…'}
          </p>
          {!uiState.player1 && (
            <p className="text-sm text-stone-300">
              你是玩家一（{PK_ANIMATION_MAP.player1.displayName}），需要先允許鏡頭權限才能開始
            </p>
          )}

          {joinUrl === null ? (
            <div className="flex w-full max-w-xs flex-col gap-2">
              <p className="text-sm text-stone-300">
                這台裝置是用 localhost 開的，手機連不到——請輸入這台電腦的區網 IP（跑
                <code className="mx-1 rounded bg-white/10 px-1">npm run dev</code>
                時終端機印出的「Network: http://...」那個位址）：
              </p>
              <input
                type="text"
                inputMode="numeric"
                placeholder="例如 192.168.0.171"
                value={lanIp}
                onChange={(e) => handleLanIpChange(e.target.value)}
                className="rounded-lg border border-white/20 bg-white/10 px-3 py-2 text-center font-mono text-sm text-white placeholder:text-stone-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
              />
            </div>
          ) : (
            <>
              <p className="text-sm text-stone-300">請對手用手機掃描或開啟：</p>
              {qrDataUrl && (
                <img src={qrDataUrl} alt={`加入網址 QR code：${joinUrl}`} className="rounded-lg bg-white p-2" width={220} height={220} />
              )}
              <p className="rounded-lg bg-white/10 px-4 py-2 font-mono text-sm">{joinUrl}</p>
              {(window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') && (
                <button
                  type="button"
                  onClick={() => handleLanIpChange('')}
                  className="text-xs text-stone-400 underline hover:text-stone-200"
                >
                  IP 錯了？點這裡重新輸入
                </button>
              )}
            </>
          )}

          <p className="text-xs text-stone-400">
            {uiState.player1 ? '✅ 你（玩家一）已就緒' : '⏳ 等待你允許鏡頭權限'} ・{' '}
            {uiState.player2 ? '✅ 對手已加入' : '⏳ 等待對手掃 QR code 加入'}
          </p>

          {uiState.player1 && !uiState.player2 && (
            <button
              type="button"
              onClick={() => soloDebugRef.current()}
              className="mt-1 rounded-full border border-white/20 px-4 py-1.5 text-xs text-stone-300 hover:bg-white/10"
            >
              單人測試模式（跳過等待，直接進入除錯）
            </button>
          )}
        </div>
      )}

      {uiState.phase === 'countdown' && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40">
          <p className="text-8xl font-bold">{uiState.countdown}</p>
        </div>
      )}

      {uiState.phase === 'paused' && (
        <div className="absolute inset-x-0 top-4 flex justify-center">
          <p className="rounded-full bg-amber-500/90 px-4 py-1.5 text-sm font-medium text-black">
            對戰暫停中，等待玩家重新連線…
          </p>
        </div>
      )}

      {(uiState.phase === 'battle' || uiState.phase === 'paused' || uiState.phase === 'finished') && uiState.player1 && uiState.player2 && (
        <div className="absolute inset-x-4 top-4 flex justify-between gap-6">
          <div className="w-1/3">
            <p className="mb-1 text-sm font-semibold">{PK_ANIMATION_MAP.player1.displayName}</p>
            <div className="h-3 w-full overflow-hidden rounded-full bg-white/20">
              <div className="h-full bg-emerald-500 transition-all" style={{ width: `${(uiState.player1.hp / HP_MAX) * 100}%` }} />
            </div>
          </div>
          <div className="w-1/3 text-right">
            <p className="mb-1 text-sm font-semibold">{PK_ANIMATION_MAP.player2.displayName}</p>
            <div className="h-3 w-full overflow-hidden rounded-full bg-white/20">
              <div className="ml-auto h-full bg-rose-500 transition-all" style={{ width: `${(uiState.player2.hp / HP_MAX) * 100}%` }} />
            </div>
          </div>
        </div>
      )}

      {/* 單人測試模式：玩家二還沒加入，只顯示玩家一血條，讓主持人在除錯時也看得到
          血量/連線狀態有沒有正常運作，不用等真的湊到兩人才有任何回饋畫面。 */}
      {uiState.phase === 'battle' && uiState.player1 && !uiState.player2 && (
        <div className="absolute inset-x-4 top-4 flex justify-between gap-6">
          <div className="w-1/3">
            <p className="mb-1 text-sm font-semibold">{PK_ANIMATION_MAP.player1.displayName}（單人測試模式）</p>
            <div className="h-3 w-full overflow-hidden rounded-full bg-white/20">
              <div className="h-full bg-emerald-500 transition-all" style={{ width: `${(uiState.player1.hp / HP_MAX) * 100}%` }} />
            </div>
          </div>
        </div>
      )}

      {uiState.phase === 'finished' && uiState.winner && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 bg-black/50">
          <p className="text-4xl font-bold">{PK_ANIMATION_MAP[uiState.winner].displayName} 獲勝！</p>
          <button
            type="button"
            onClick={() => rematchRef.current()}
            className={cn(
              'inline-flex items-center gap-2 rounded-full px-6 py-3 text-base font-semibold text-white shadow-lg',
              'bg-linear-to-r from-violet-500 to-pink-500 shadow-violet-500/30 hover:brightness-105',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2 focus-visible:ring-offset-black',
            )}
          >
            <RotateCcw className="size-5" aria-hidden="true" />
            再來一局
          </button>
        </div>
      )}

      {/* 玩家一（主持人本人）的鏡頭 PIP：全程顯示（不只是等待畫面），讓你在對戰中也
          看得到自己目前的手勢辨識狀態，跟 PkControllerView.tsx 給玩家二看的是同一種
          資訊，只是這裡疊在擂台畫面左下角。 */}
      <div className="absolute bottom-4 left-4 w-32 overflow-hidden rounded-xl border border-white/40 bg-black shadow-lg sm:w-36">
        <video ref={videoRef} className="block w-full scale-x-[-1]" muted playsInline aria-hidden="true" />
        <canvas ref={overlayRef} className="absolute inset-0 h-full w-full scale-x-[-1]" aria-hidden="true" />
        {localCameraStatus === 'requesting' && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-center text-[11px] text-white">
            等待鏡頭權限…
          </div>
        )}
        {/* 2026-08-18 修正：同一種疊圖對不準的問題，比照 PkControllerView.tsx 的修法
            （見那邊的完整說明）——原本不是 absolute，會撐開外層 div 的高度，害
            overlayRef 的骨架疊圖被拉伸到跟 video 自己的高度不一樣，垂直方向對不準。 */}
        {localCameraStatus === 'active' && (
          <p className="absolute inset-x-0 bottom-0 bg-black/70 px-2 py-1 text-center text-[11px] font-medium text-white">{localGestureLabel}</p>
        )}
        {localCameraStatus === 'error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/80 px-2 text-center">
            <p className="text-[11px] text-rose-400">{localCameraError}</p>
            <button
              type="button"
              onClick={() => setCameraRetryToken((t) => t + 1)}
              className="rounded-full bg-white/15 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-white/25"
            >
              重試
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
