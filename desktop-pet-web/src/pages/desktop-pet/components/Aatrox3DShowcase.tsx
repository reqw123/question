import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { Gamepad2, ScanFace, Swords } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { AatroxGestureTrigger } from './aatrox-gesture/AatroxGestureTrigger'

// 真正的 3D 模型（glTF/.glb），跟 HeroLive2DStage 的 Live2D／Spine 角色是完全不同的
// 呈現方式，這裡刻意不塞進那個卡片輪播（角色太大、應該有自己的大版面＋完整動作清單可以
// 展示，不是塞進小卡片裡）。資源沿用 C:\question\glb-viewer\ 已經驗證過可行的做法：
// GLTFLoader 載入、Box3 量包圍盒自動置中相機、AnimationMixer 播放具名動畫、
// OrbitControls 讓使用者自己拖曳看各個角度；操控模式的固定世界座標軸 WASD 移動也是
// 直接搬 glb-viewer 已經用 Playwright 驗證過「轉視角不影響移動方向」的版本過來，不是
// 重新設計一套。這裡是獨立的 Three.js WebGLRenderer，不跟 HeroLive2DStage 共用畫布/
// PIXI，兩邊完全沒有耦合。
const MODEL_URL = '/characters/models/亞托克斯_腥紅之月/aatrox-crimson-moon.glb'
// **2026-08-11 待機姿勢改用「劍已收好」的版本**：原本用 Idle1，實測（Playwright 逐幀
// 截圖）發現不管是待機還是攻擊，劍幾乎沒有真的收起來過——這是使用者回報「角色常常
// 舉著大劍」的來源。Idle_in_sheath（1.13s 循環）才是劍確實掛在背後、雙手空著的待機
// 姿勢，跟 Aatrox_Passive_INTO_Shlth.anm（見下面 SHEATH_ANIMATION 說明）這類過場動畫
// 收劍後的最終姿勢一致。
const DEFAULT_ANIMATION = 'Idle_in_sheath'
const RUN_ANIMATION = 'Run_Base'
// **2026-08-11 從 Attack1/2/3 隨機挑改成固定只用 Attack2**：逐幀截圖比對過，Attack2
// 真正在動的揮擊片段大概 0.5 秒，之後到動畫結束（2.3 秒）都是靜止收尾姿勢——這才是
// 「揮劍停留時間太久」的真正原因。ATTACK_ACTIVE_MS 只播這 0.5 秒，時間到了不管動畫本身
// 播到哪裡都直接打斷，接著換播收劍過場動畫，不等 Attack2 自然播完。固定只用 Attack2
// （不是隨機挑 3 個之一）是為了讓連續按空白鍵時每次打斷的時間點一致、動作看起來像
// 連續攻擊而不是三種招式隨機亂接。
const ATTACK_CLIP_NAME = 'Attack2'
const ATTACK_ACTIVE_MS = 500
const SHEATH_ANIMATION = 'Aatrox_ReSheath_fullbody.anm'
const ATTACK_KEY = ' '
const MOVE_KEYS = new Set(['w', 'a', 's', 'd'])
// **閒置演出**：待機姿勢（DEFAULT_ANIMATION）持續超過 IDLE_TIMEOUT_MS 沒有任何鍵盤操作
// （WASD／空白鍵）或選單動作（下拉選單切動畫）就隨機挑一個播一次，增加一點活潑感，
// 不要角色永遠一動不動定格著。這幾個都是模型內建、跟戰鬥/移動無關的純演出動畫。
const IDLE_FLAVOR_ANIMATIONS = ['Joke', 'Laugh', 'Dance_Loop', 'Taunt_loop']
const IDLE_TIMEOUT_MS = 10000

type LoadState = 'loading' | 'ready' | 'error'
type AnimationEntry = { name: string; duration: number }

export function Aatrox3DShowcase({ onEnterPkArena }: { onEnterPkArena: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<LoadState>('loading')
  const [animations, setAnimations] = useState<AnimationEntry[]>([])
  const [currentAnim, setCurrentAnim] = useState('')
  const [controlMode, setControlMode] = useState(false)
  // 給 <select> 的 onChange 呼叫的「播放這個動作」函式，實際實作在下面掛載 effect
  // 裡（跟 mixer/clips 同一個閉包），用 ref 轉手給 render 出來的 JSX 用。
  const playAnimationRef = useRef<(name: string) => void>(() => {})
  // 「回到展示姿勢」：退出操控模式時呼叫，把角色位置/鏡頭都歸位，實作同樣在掛載
  // effect 裡（需要存取 modelRoot／camera／controls 的初始值）。
  const resetPoseRef = useRef<() => void>(() => {})
  // 空白鍵現在播的是「下拉選單目前選定的動作」，不再寫死揮劍——用 ref 而不是 state，
  // 理由跟 pressedKeysRef 一樣：keydown handler 在掛載 effect 的閉包裡，每次按空白鍵
  // 都要讀到最新選的值，用 state 會因為非同步更新拿到舊值。預設值是 ATTACK_CLIP_NAME，
  // 使用者完全沒動過下拉選單時，行為跟改版之前一模一樣（空白鍵＝揮劍）。
  const selectedActionRef = useRef<string>(ATTACK_CLIP_NAME)
  // 手勢模式（見 aatrox-gesture/AatroxGestureTrigger.tsx、docs/specs/0012、
  // docs/adr/0013）：比 👍 觸發的也是 triggerSelectedAction()，但那個函式定義在下面
  // 掛載 effect 的閉包裡，手勢元件是平行掛載的獨立元件、不在同一個閉包裡，所以需要
  // 一個 ref 轉手——跟 playAnimationRef／resetPoseRef 是同一種橋接模式。
  const triggerSelectedActionRef = useRef<() => void>(() => {})
  const [gestureMode, setGestureMode] = useState(false)
  const [gestureError, setGestureError] = useState<string | null>(null)
  // 選單（下拉選單切動畫）算一種「使用者互動」，要重置閒置計時器——下拉選單的
  // onChange 是 React 事件、跑在元件層級，跟鍵盤事件（掛載 effect 裡的
  // window.addEventListener）不是同一個地方，一樣用 ref 轉手給掛載 effect 裡的實作。
  const bumpIdleTimerRef = useRef<() => void>(() => {})
  // 目前按住的移動鍵，跟 controlModeRef 一樣用 ref 而不是 state——每一幀的移動計算
  // 需要讀最新值，用 state 會因為 setState 是非同步的、閉包拿到的還是舊值而抓不準。
  const pressedKeysRef = useRef<Set<string>>(new Set())
  const controlModeRef = useRef(false)

  useEffect(() => {
    controlModeRef.current = controlMode
    if (!controlMode) {
      // 退出操控模式：清掉還按著的鍵（避免下次進來時延續上次沒放開的 W），角色跟
      // 鏡頭都歸位到展示姿勢。initial mount 時 controlMode 本來就是 false，這裡也會
      // 呼叫一次，但那時候 resetPoseRef.current 還是預設的空函式，不會有副作用。
      pressedKeysRef.current.clear()
      resetPoseRef.current()
    }
  }, [controlMode])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let destroyed = false
    // 這個 effect 掛載時只註冊一個 IntersectionObserver，真正的 WebGLRenderer／
    // GLTFLoader／16MB 模型下載全部延後到「這個 section 第一次進入可視範圍」才觸發
    // （見下面 init()）——效能優化：使用者如果根本沒捲到這裡，就不用白開一個 WebGL
    // context、白下載一份不會被看到的模型。`started` 確保 init() 只執行一次，之後
    // 捲出/捲回視窗只是暫停/恢復渲染迴圈（見 stopRenderLoop／startRenderLoop），
    // 不會重新建立 renderer 或重新下載模型。
    let started = false

    let scene: THREE.Scene
    let camera: THREE.PerspectiveCamera
    let renderer: THREE.WebGLRenderer
    let controls: OrbitControls
    let clock: THREE.Clock
    let mixer: THREE.AnimationMixer | null = null
    let currentAction: THREE.AnimationAction | null = null
    let clips: THREE.AnimationClip[] = []
    // 目前「應該」播的動畫名稱，只在真的換動畫時才呼叫 mixer.clipAction()/play()，
    // 避免下拉選單沒動、或移動迴圈每一幀都重複呼叫時把同一個動畫從頭重播一次。
    let desiredAnim = ''
    // 操控模式專用狀態：modelRoot 跟 loader 載入的 scene 是同一個物件（見下面
    // loader.load 的 callback），moveSpeed 用包圍盒最大邊長換算，不寫死固定數字。
    let modelRoot: THREE.Object3D | null = null
    let moveSpeed = 1
    let modelHeight = 1
    let isAttacking = false
    let wasMoving = false
    let initialCameraPosition = new THREE.Vector3()
    let initialTarget = new THREE.Vector3()
    // 閒置演出計時：見上面 IDLE_TIMEOUT_MS／IDLE_FLAVOR_ANIMATIONS 的說明。用
    // performance.now()（跟 clock 同一種單調時鐘來源）而不是 Date.now()，不受系統時間
    // 被調整影響。從掛載那一刻開始算，模型還沒載完之前 desiredAnim 不會是
    // DEFAULT_ANIMATION，checkIdleFlavor() 自然不會觸發，不用另外處理「還沒載完」的情況。
    let lastInteractionAt = performance.now()
    // triggerSelectedAction() 用 setTimeout 提前截斷揮劍動畫（見 ATTACK_ACTIVE_MS 說明），
    // attackToken 是每次揮劍就遞增的序號，避免上一次揮劍的 timeout 在新一次揮劍已經
    // 開始之後才觸發、把新的攻擊又蓋成收劍動畫（正常情況下 isAttacking guard 就會擋掉
    // 重複觸發，這裡是防禦性的第二層保護，尤其是 resetPoseRef 清空 isAttacking 之後）。
    let attackToken = 0
    // 型別故意寫死 number（不是 ReturnType<typeof window.setTimeout>）：新增 mqtt 依賴
    // 後它間接拉進 @types/node 全域宣告，導致 ReturnType<typeof window.setTimeout>
    // 誤判成 NodeJS.Timeout，見 HeroLive2DStage.tsx 同樣的說明。
    let attackTimeoutId: number | undefined

    function playAnimation(name: string) {
      if (!mixer || name === desiredAnim) return
      const clip = clips.find((c) => c.name === name)
      if (!clip) return
      desiredAnim = name
      const next = mixer.clipAction(clip)
      if (currentAction && currentAction !== next) {
        currentAction.fadeOut(0.25)
      }
      next.reset().fadeIn(0.25).play()
      currentAction = next
      setCurrentAnim(name)
    }
    playAnimationRef.current = playAnimation

    // **回到「揹劍待機」只定格在姿勢上，不要一直重播動作**：Idle_in_sheath 本身是一段
    // 1.13 秒的循環動畫，用 playAnimation() 的預設 LoopRepeat 播放時，實測會不斷重複
    // 同一段小動作，看起來很像卡頓／機械式重播，使用者回報「一直重複待機動作很奇怪」。
    // 這裡改成跟 triggerSelectedAction()／收劍動畫同一種播法（LoopOnce + clampWhenFinished）：
    // 播一次到最後一幀就定格，維持「劍揹在背後」的姿勢，但不會無限循環那段小動作。
    // 只用在「回到待機」這幾個地方（載入完成、攻擊/收劍結束、停止移動、退出操控模式
    // 歸位）——下拉選單手動選動畫時（playAnimationRef／playAnimation）刻意不套用這個，
    // 那裡是要如實展示每個動畫本來的樣子（含循環動畫，例如 Dance_Loop），不應該被定格。
    function playIdlePose() {
      if (!mixer || desiredAnim === DEFAULT_ANIMATION) return
      const clip = clips.find((c) => c.name === DEFAULT_ANIMATION)
      if (!clip) return
      desiredAnim = DEFAULT_ANIMATION
      const next = mixer.clipAction(clip)
      next.reset()
      next.setLoop(THREE.LoopOnce, 1)
      next.clampWhenFinished = true
      if (currentAction && currentAction !== next) currentAction.fadeOut(0.25)
      next.fadeIn(0.25).play()
      currentAction = next
      setCurrentAnim(DEFAULT_ANIMATION)
    }

    // 使用者真的做了鍵盤操作／選單動作，重置閒置計時器。播放閒置演出動畫本身「不算」
    // 使用者互動，但演出播完銜接回待機時一樣要重置這個時間戳，不然下一幀 checkIdleFlavor()
    // 會立刻發現「已經超過 10 秒沒互動」又馬上觸發下一個，變成閒置動畫一個接一個連續
    // 播不停——見下面 triggerIdleFlavor() 的 'finished' handler。
    function bumpIdleTimer() {
      lastInteractionAt = performance.now()
    }
    bumpIdleTimerRef.current = bumpIdleTimer

    // 閒置超過 IDLE_TIMEOUT_MS 沒有鍵盤操作／選單動作時，隨機挑一個純演出動畫播一次
    // （LoopOnce + clampWhenFinished，跟 playIdlePose() 同一種「播一次定格」邏輯，不過
    // 這裡播完是重新判斷要不要接回待機，不是永遠定格在演出動畫的最後一幀）。播完接回
    // playIdlePose()，讓角色回到揹劍待機姿勢，同時重置計時器，等下一次滿 10 秒才會再演一次。
    function triggerIdleFlavor() {
      if (!mixer) return
      const pool = IDLE_FLAVOR_ANIMATIONS.filter((name) => clips.some((c) => c.name === name))
      if (!pool.length) return
      const name = pool[Math.floor(Math.random() * pool.length)]
      const clip = clips.find((c) => c.name === name)!
      desiredAnim = name
      const next = mixer.clipAction(clip)
      next.reset()
      next.setLoop(THREE.LoopOnce, 1)
      next.clampWhenFinished = true
      if (currentAction && currentAction !== next) currentAction.fadeOut(0.3)
      next.fadeIn(0.3).play()
      currentAction = next
      setCurrentAnim(name)

      const onFinished = (event: THREE.AnimationMixerEventMap['finished']) => {
        if (event.action !== next) return
        mixer!.removeEventListener('finished', onFinished)
        // desiredAnim 沒變（== name）代表期間沒有其他東西（移動／攻擊／使用者手動選了
        // 別的動畫）打斷過，才接回待機；已經被打斷的話這裡不用做任何事，打斷的那個
        // 呼叫（playAnimation／triggerAttack／playIdlePose）自己會處理好接下來要播什麼。
        if (desiredAnim === name) {
          desiredAnim = ''
          playIdlePose()
        }
        lastInteractionAt = performance.now()
      }
      mixer.addEventListener('finished', onFinished)
    }

    // 每幀檢查一次：只有角色目前真的停在待機姿勢（不是移動中、攻擊中、或使用者手動
    // 從下拉選單選了別的動畫在看）才會觸發，避免打斷使用者正在做的事。
    function checkIdleFlavor() {
      if (!mixer || isAttacking || desiredAnim !== DEFAULT_ANIMATION) return
      if (performance.now() - lastInteractionAt < IDLE_TIMEOUT_MS) return
      triggerIdleFlavor()
    }

    // 收劍過場的 'finished' handler 存成外層變數，讓 triggerSelectedAction() 在連續攻擊、中途
    // 打斷收劍動畫時可以主動移除，不會累積用不到的 listener（正常情況下播完會自己
    // remove，這裡只是連段時提早打斷的防禦性清理）。
    let sheathFinishedHandler: ((event: THREE.AnimationMixerEventMap['finished']) => void) | null = null

    // 播一次收劍過場動畫，播完接回待機（或如果角色還在移動就交給下一幀的
    // updateMovement() 接管，同樣的「清空 desiredAnim 交回判斷」模式見下面說明）。
    // fromAction 是揮劍那個 clip 的 action，只是拿來 fadeOut，跟這個函式本身無關。
    function playSheathThenIdle(fromAction: THREE.AnimationAction) {
      const sheathClip = mixer ? clips.find((c) => c.name === SHEATH_ANIMATION) : undefined
      if (!mixer || !sheathClip) {
        isAttacking = false
        desiredAnim = ''
        return
      }
      desiredAnim = SHEATH_ANIMATION
      const sheathAction = mixer.clipAction(sheathClip)
      sheathAction.reset()
      sheathAction.setLoop(THREE.LoopOnce, 1)
      sheathAction.clampWhenFinished = true
      fromAction.fadeOut(0.15)
      sheathAction.fadeIn(0.15).play()
      currentAction = sheathAction
      setCurrentAnim(SHEATH_ANIMATION)

      const onSheathFinished = (event: THREE.AnimationMixerEventMap['finished']) => {
        if (event.action !== sheathAction) return
        mixer!.removeEventListener('finished', onSheathFinished)
        sheathFinishedHandler = null
        isAttacking = false
        // 清空 desiredAnim，逼下一幀的移動迴圈／這裡直接接回待機重新判斷一次要播
        // 什麼（角色可能在收劍過程中按住了移動鍵，接回去的應該是 Run 不是 Idle）。
        desiredAnim = ''
        if (!(pressedKeysRef.current.size > 0 && controlModeRef.current)) {
          playIdlePose()
        }
      }
      sheathFinishedHandler = onSheathFinished
      mixer.addEventListener('finished', onSheathFinished)
    }

    // 空白鍵：播「下拉選單目前選定的動作」（selectedActionRef.current），不再寫死揮劍。
    // 名稱是 Attack 開頭（Attack1/2/3，選單裡三招揮劍動作都是這個命名規則）才套用揮劍
    // 專屬的處理——只播 ATTACK_ACTIVE_MS（0.5 秒）這段真正在動的揮擊本身（見上面
    // ATTACK_ACTIVE_MS 的說明，這是逐幀截圖比對 Attack2 量出來的時間，Attack1/3 是同一
    // 個角色的同類型招式，沿用同一個數字），時間到了不管動畫本身播到哪裡，直接淡出換播
    // 收劍過場動畫（playSheathThenIdle），不等自然播完那長達近 2 秒的靜止收尾。選了其他
    // 非揮劍類動作（Dance_Loop、Taunt_loop…）不套用這段揮劍專屬的截斷+收劍過場——那些
    // 動作沒有「劍還沒收好」的問題，跟 triggerIdleFlavor() 播閒置演出動畫同一種「播一次、
    // 自然播完再接回待機」處理，不強制打斷。
    //
    // **連續觸發**：不管目前是還在播動作中還是已經進入收劍過場，只要再按一次空白鍵，就
    // 打斷目前播放的東西、重新從頭播新選的動作——揮劍時就是「按幾下連續揮幾刀」的連段
    // 手感，不用等前一刀的收劍過場播完。isAttacking 全程維持 true（從動作開始播到真正
    // 結束回到待機為止，不只限於揮劍），理由不變：擋住移動迴圈把這整段過場蓋成 Run_Base。
    function triggerSelectedAction() {
      if (!mixer) return
      const name = selectedActionRef.current || ATTACK_CLIP_NAME
      const clip = clips.find((c) => c.name === name)
      if (!clip) return
      if (sheathFinishedHandler) {
        mixer.removeEventListener('finished', sheathFinishedHandler)
        sheathFinishedHandler = null
      }
      isAttacking = true
      desiredAnim = name
      const next = mixer.clipAction(clip)
      next.reset()
      next.setLoop(THREE.LoopOnce, 1)
      next.clampWhenFinished = true
      if (currentAction && currentAction !== next) currentAction.fadeOut(0.1)
      next.fadeIn(0.08).play()
      currentAction = next
      setCurrentAnim(name)

      const token = ++attackToken
      window.clearTimeout(attackTimeoutId)

      if (name.startsWith('Attack')) {
        attackTimeoutId = window.setTimeout(() => {
          if (token !== attackToken) return
          playSheathThenIdle(next)
        }, ATTACK_ACTIVE_MS)
        return
      }

      // 非揮劍類動作：不強制截斷，讓它自然播完（LoopOnce + clampWhenFinished 已經確保
      // 只播一次不會無限循環），播完接回待機——跟 triggerIdleFlavor() 的 'finished'
      // handler 同一種模式，token 比對避免上一次觸發的舊 callback 在新一次觸發後才誤觸發。
      const onFinished = (event: THREE.AnimationMixerEventMap['finished']) => {
        if (event.action !== next) return
        mixer!.removeEventListener('finished', onFinished)
        if (token !== attackToken) return
        isAttacking = false
        if (desiredAnim === name) {
          desiredAnim = ''
          if (!(pressedKeysRef.current.size > 0 && controlModeRef.current)) {
            playIdlePose()
          }
        }
      }
      mixer.addEventListener('finished', onFinished)
    }
    triggerSelectedActionRef.current = triggerSelectedAction

    // 固定世界座標軸移動（跟 glb-viewer 已經用 Playwright 驗證過的版本一致）：W 永遠是
    // -Z、D 永遠是 +X，不管滑鼠把 OrbitControls 的視角轉到哪都一樣。
    const WORLD_FORWARD = new THREE.Vector3(0, 0, -1)
    const WORLD_RIGHT = new THREE.Vector3(1, 0, 0)
    const moveDir = new THREE.Vector3()
    const cameraFollowOffset = new THREE.Vector3()

    function updateMovement(delta: number) {
      if (!modelRoot || !controlModeRef.current) return
      const pressed = pressedKeysRef.current

      moveDir.set(0, 0, 0)
      if (pressed.has('w')) moveDir.add(WORLD_FORWARD)
      if (pressed.has('s')) moveDir.sub(WORLD_FORWARD)
      if (pressed.has('d')) moveDir.add(WORLD_RIGHT)
      if (pressed.has('a')) moveDir.sub(WORLD_RIGHT)

      const isMoving = moveDir.lengthSq() > 0
      if (isMoving) {
        moveDir.normalize()
        modelRoot.position.addScaledVector(moveDir, moveSpeed * delta)
        // 面朝移動方向，用最短路徑轉過去，避免從 350° 轉回 10° 硬轉一大圈。
        const targetAngle = Math.atan2(moveDir.x, moveDir.z)
        let angleDiff = targetAngle - modelRoot.rotation.y
        angleDiff = ((angleDiff + Math.PI) % (Math.PI * 2)) - Math.PI
        modelRoot.rotation.y += angleDiff * Math.min(1, delta * 10)
        if (!isAttacking) playAnimation(RUN_ANIMATION)
      } else if (wasMoving && !isAttacking) {
        playIdlePose()
      }
      wasMoving = isMoving

      // 鏡頭跟著角色走，不然操控模式下走幾步就走出畫面框外了；只在操控模式下才拉
      // target，退出後鏡頭歸位交給 resetPoseRef（下面）處理，不會互相打架。
      cameraFollowOffset.set(0, modelHeight * 0.5, 0)
      controls.target.lerp(modelRoot.position.clone().add(cameraFollowOffset), 0.15)
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (!controlModeRef.current) return
      bumpIdleTimer()
      const key = e.key.toLowerCase()
      if (MOVE_KEYS.has(key)) {
        e.preventDefault()
        pressedKeysRef.current.add(key)
      } else if (e.key === ATTACK_KEY) {
        e.preventDefault()
        // e.repeat 是瀏覽器按住不放時自動觸發的 keydown（通常延遲後每秒重複十幾二十次），
        // 現在 triggerSelectedAction() 不再有 isAttacking guard 擋重複觸發（連續攻擊就是要讓
        // 按第二下能打斷第一下），如果不濾掉 repeat，按住空白鍵不放會變成瘋狂連續打斷、
        // 動畫閃爍，不是使用者想要的「按幾下連續攻擊幾次」。只擋自動重複，放開再按下去
        // 的每一次真正按鍵都還是會觸發。
        if (!e.repeat) triggerSelectedAction()
      }
    }
    function handleKeyUp(e: KeyboardEvent) {
      const key = e.key.toLowerCase()
      if (MOVE_KEYS.has(key)) pressedKeysRef.current.delete(key)
    }
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)

    let rafId = 0
    let resizeObserver: ResizeObserver | null = null

    // 恢復渲染迴圈前先呼叫一次 clock.getDelta() 丟掉暫停期間累積的間隔（可能是幾秒到
    // 幾分鐘），不然恢復那一幀 delta 會突然暴衝，mixer.update()/updateMovement() 用這個
    // delta 算出來的動畫進度／移動距離會跳一大步，跟單純凍結畫面的體感不一致。
    function startRenderLoop() {
      if (rafId) return
      clock.getDelta()
      tick()
    }
    function stopRenderLoop() {
      if (!rafId) return
      cancelAnimationFrame(rafId)
      rafId = 0
    }
    function tick() {
      rafId = requestAnimationFrame(tick)
      const delta = clock.getDelta()
      updateMovement(delta)
      checkIdleFlavor()
      mixer?.update(delta)
      controls.update()
      renderer.render(scene, camera)
    }

    // **效能：整個 WebGLRenderer／GLTFLoader／16MB 模型下載延後到第一次進入可視範圍**。
    // 只執行一次（started 旗標擋住重複呼叫），跟上面渲染迴圈的啟停是兩件事——這裡處理
    // 的是「值不值得建立」，渲染迴圈處理的是「值不值得每幀畫」，捲出視窗後只暫停渲染，
    // 不會把已經建立好的 renderer／已經下載好的模型丟掉重來。
    function init() {
      if (started || !host) return
      started = true

      scene = new THREE.Scene()
      camera = new THREE.PerspectiveCamera(35, Math.max(1, host.clientWidth) / Math.max(1, host.clientHeight), 0.01, 1000)
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
      renderer.setSize(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight))
      renderer.setClearColor(0x000000, 0)
      host.appendChild(renderer.domElement)

      // 模型用了 KHR_materials_unlit（見 glb-viewer 排查記錄），理論上不需要打光，這裡
      // 還是加一組基本燈光保底，避免萬一有非 unlit 的材質（例如特效層）整個變黑看不見。
      scene.add(new THREE.AmbientLight(0xffffff, 1.2))
      const dirLight = new THREE.DirectionalLight(0xffffff, 1.5)
      dirLight.position.set(3, 5, 2)
      scene.add(dirLight)

      controls = new OrbitControls(camera, renderer.domElement)
      controls.enableDamping = true
      controls.minDistance = 0.5
      controls.maxDistance = 50

      clock = new THREE.Clock()

      const loader = new GLTFLoader()
      loader.load(
        MODEL_URL,
        (gltf) => {
          if (destroyed) return
          const model = gltf.scene
          scene.add(model)
          modelRoot = model

          // 動態量包圍盒算相機距離/目標點，不寫死猜的數字——不同來源的 glTF 匯出習慣
          // （單位、原點）差很多，見 glb-viewer 的排查記錄。
          const box = new THREE.Box3().setFromObject(model)
          const size = box.getSize(new THREE.Vector3())
          const center = box.getCenter(new THREE.Vector3())
          const maxDim = Math.max(size.x, size.y, size.z)
          modelHeight = size.y
          moveSpeed = maxDim * 0.6
          controls.target.copy(center)
          camera.position.set(center.x, center.y + size.y * 0.1, center.z + maxDim * 1.4)
          camera.near = maxDim / 100
          camera.far = maxDim * 100
          camera.updateProjectionMatrix()
          controls.update()
          initialCameraPosition = camera.position.clone()
          initialTarget = controls.target.clone()

          clips = gltf.animations ?? []
          mixer = new THREE.AnimationMixer(model)
          setAnimations(clips.map((c) => ({ name: c.name, duration: c.duration })))

          // 找不到 DEFAULT_ANIMATION（理論上不會發生，這份模型確認過有這個 clip）才退回
          // 用第一個動畫、走一般循環播放；正常情況下用 playIdlePose() 定格在揹劍姿勢。
          if (clips.some((c) => c.name === DEFAULT_ANIMATION)) {
            playIdlePose()
          } else if (clips[0]) {
            playAnimation(clips[0].name)
          }

          setStatus('ready')
        },
        undefined,
        (err) => {
          console.error('[Aatrox3DShowcase] glTF 模型載入失敗：', err)
          if (!destroyed) setStatus('error')
        },
      )

      // 退出操控模式時呼叫：角色位置/朝向、鏡頭位置/target 全部歸回載入完成時算好的
      // 初始值，回到單純展示的樣子，不會讓角色卡在操控模式走到的某個地方。
      resetPoseRef.current = () => {
        if (modelRoot) {
          modelRoot.position.set(0, 0, 0)
          modelRoot.rotation.set(0, 0, 0)
        }
        // 退出操控模式當下如果剛好卡在揮劍／收劍過場中途，把還沒觸發的 setTimeout／
        // 'finished' callback 都作廢（attackToken 遞增後，callback 裡的 token 比對會
        // 失敗直接 return），不然歸位後那個延遲 callback 才觸發，會把已經歸位的
        // Idle_in_sheath 又蓋成收劍動畫。如果是卡在收劍動畫播放中途（已經掛上
        // sheathFinishedHandler，不是還在等 setTimeout），一併移除，不然等它自然播完
        // 一樣會呼叫 playIdlePose() 蓋掉這裡剛歸位的姿勢。
        ++attackToken
        window.clearTimeout(attackTimeoutId)
        if (sheathFinishedHandler && mixer) {
          mixer.removeEventListener('finished', sheathFinishedHandler)
          sheathFinishedHandler = null
        }
        if (mixer) {
          isAttacking = false
          wasMoving = false
          desiredAnim = ''
          playIdlePose()
        }
        camera.position.copy(initialCameraPosition)
        controls.target.copy(initialTarget)
        controls.update()
      }

      resizeObserver = new ResizeObserver(() => {
        const w = host.clientWidth
        const h = host.clientHeight
        if (w < 1 || h < 1) return
        camera.aspect = w / h
        camera.updateProjectionMatrix()
        renderer.setSize(w, h)
      })
      resizeObserver.observe(host)
    }

    // **效能：不可視時整個渲染迴圈直接停掉，不是只是「畫了但沒人看到」**。這個 section
    // 通常在首頁往下捲好幾頁才會看到，沒有這道門檻的話，Three.js 的 render loop 從
    // mount 那一刻就會不間斷佔用主執行緒／GPU，不管使用者到底有沒有捲到這裡——實測
    // (Playwright + CDP Profiler) 過這是這個頁面持續性 CPU 成本的主要來源之一。
    const intersectionObserver = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (!entry) return
        if (entry.isIntersecting) {
          init()
          startRenderLoop()
        } else {
          stopRenderLoop()
          // 捲出可視範圍時一併關掉手勢模式——鏡頭沒必要在使用者看不到這張卡片時繼續開著
          // （見 docs/specs/0012 Edge Cases）。setGestureMode 是 useState 的 setter，
          // identity 穩定，掛載時閉包捕捉到的這一份直接呼叫即可，不需要另外用 ref 轉手。
          setGestureMode(false)
          // 同理也要關掉操控模式——不關的話，全域的 keydown/keyup 監聽（見下面
          // handleKeyDown）只認 controlModeRef，跟這張卡片有沒有捲出畫面無關，使用者
          // 捲走之後 W/A/S/D/Space 還是會被攔截並 preventDefault()，而且操控模式又
          // 沒有 Escape 鍵可以離開，只能捲回來找退出按鈕——是真的會卡住鍵盤輸入的 bug，
          // 不只是「鏡頭沒必要開著」那種效能考量。setControlMode(false) 會觸發上面
          // controlMode 變化的 effect，順便清掉還按著的鍵、把角色/鏡頭歸位。
          setControlMode(false)
        }
      },
      { threshold: 0.01 },
    )
    intersectionObserver.observe(host)

    return () => {
      destroyed = true
      window.clearTimeout(attackTimeoutId)
      stopRenderLoop()
      intersectionObserver.disconnect()
      resizeObserver?.disconnect()
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      if (!started) return
      controls.dispose()
      // traverse 釋放 geometry/material/texture，避免 GPU 資源洩漏（跟
      // HeroLive2DStage 卸載時 model.destroy() 是同一個理由）。
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh
        if (!mesh.isMesh) return
        mesh.geometry?.dispose()
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        for (const mat of materials) {
          if (!mat) continue
          for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap'] as const) {
            ;(mat as any)[key]?.dispose?.()
          }
          mat.dispose()
        }
      })
      try {
        renderer.dispose()
      } catch (err) {
        console.error('[Aatrox3DShowcase] renderer.dispose 失敗（已忽略）：', err)
      }
      renderer.domElement.remove()
    }
  }, [])

  return (
    <section id="aatrox-3d" aria-labelledby="aatrox-3d-heading" className="mx-auto max-w-6xl px-4 py-16">
      <div className="mx-auto max-w-xl text-center">
        <h2
          id="aatrox-3d-heading"
          className="text-3xl font-bold tracking-tight text-stone-900 md:text-4xl dark:text-white"
        >
          高精度 3D 模型展示
        </h2>
        <p className="mt-3 text-stone-500 dark:text-stone-400">
          拖曳滑鼠環繞視角，右側下拉選單直接切換她內建的動作，或進入操控模式親自走兩步，空白鍵播放下拉選單選定的動作（預設揮劍）——也可以開手勢模式，開鏡頭比個 👍 隔空觸發。
        </p>
      </div>

      <div className="mt-12 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_18rem]">
        <div
          ref={hostRef}
          className={cn(
            'relative aspect-video w-full touch-none overflow-hidden rounded-2xl border border-violet-200/60',
            'bg-linear-to-br from-violet-100 via-pink-50 to-pink-100 shadow-2xl shadow-violet-500/20',
            'dark:border-violet-900/40 dark:from-violet-950 dark:via-stone-900 dark:to-pink-950',
          )}
        >
          {status === 'loading' && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-violet-500/70 dark:text-violet-400/60">
              載入 3D 模型中…
            </div>
          )}
          {status === 'error' && (
            <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-stone-500 dark:text-stone-400">
              模型載入失敗，請確認資源檔案存在
            </div>
          )}
          {controlMode && (
            <div
              className={cn(
                'pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full px-4 py-1.5',
                'bg-stone-900/70 text-xs font-medium text-white backdrop-blur-sm',
              )}
            >
              W/A/S/D 移動・空白鍵播放選定動作
            </div>
          )}
          {gestureMode && (
            <AatroxGestureTrigger
              onTrigger={() => triggerSelectedActionRef.current()}
              onError={(message) => {
                setGestureMode(false)
                setGestureError(message)
              }}
            />
          )}
        </div>

        <div className="flex flex-col gap-4 rounded-2xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              type="button"
              onClick={() => setControlMode((v) => !v)}
              disabled={status !== 'ready' || gestureMode}
              aria-pressed={controlMode}
              className={cn(
                'inline-flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2',
                'disabled:cursor-not-allowed disabled:opacity-50',
                controlMode
                  ? 'bg-stone-900 text-white hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white'
                  : 'bg-linear-to-r from-violet-500 to-pink-500 text-white shadow-lg shadow-violet-500/30',
              )}
            >
              <Gamepad2 className="size-4" aria-hidden="true" />
              {controlMode ? '退出操控模式' : '進入操控模式'}
            </button>

            {/* 手勢模式：開鏡頭比 👍 觸發下拉選單選定的動作，等同「鏡頭版的空白鍵」。跟
                操控模式互斥（見 docs/adr/0013）——一次只能開一種輸入方式，避免操控模式下
                打字/按 WASD 的手部動作被鏡頭誤判成手勢。 */}
            <button
              type="button"
              onClick={() => {
                setGestureError(null)
                setGestureMode((v) => !v)
              }}
              disabled={status !== 'ready' || controlMode}
              aria-pressed={gestureMode}
              className={cn(
                'inline-flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2',
                'disabled:cursor-not-allowed disabled:opacity-50',
                gestureMode
                  ? 'bg-stone-900 text-white hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white'
                  : 'border border-violet-300 bg-white text-violet-700 hover:bg-violet-50 dark:border-violet-800 dark:bg-stone-950 dark:text-violet-300 dark:hover:bg-stone-800',
              )}
            >
              <ScanFace className="size-4" aria-hidden="true" />
              {gestureMode ? '關閉手勢模式' : '手勢模式'}
            </button>

            {/* PK 對戰模式：離開這張卡片、進全螢幕、需要另一位玩家拿手機加入，是完全不同
                於上面兩個「原地切換」按鈕的體驗（見 docs/adr/0014）。點下去交給
                DesktopPetPage 把整個 <main> 換成 PkArenaView。 */}
            <button
              type="button"
              onClick={onEnterPkArena}
              disabled={status !== 'ready'}
              className={cn(
                'inline-flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:ring-offset-2',
                'disabled:cursor-not-allowed disabled:opacity-50',
                'bg-linear-to-r from-rose-500 to-orange-500 text-white shadow-lg shadow-rose-500/30 hover:brightness-105',
              )}
            >
              <Swords className="size-4" aria-hidden="true" />
              PK 對戰模式
            </button>
          </div>

          {gestureError && (
            <p className="text-xs text-rose-600 dark:text-rose-400">{gestureError}</p>
          )}

          <div>
            <label htmlFor="aatrox-anim-select" className="text-xs font-medium text-stone-500 dark:text-stone-400">
              內建動作（共 {animations.length} 個）
            </label>
            <select
              id="aatrox-anim-select"
              value={currentAnim}
              onChange={(e) => {
                bumpIdleTimerRef.current()
                selectedActionRef.current = e.target.value
                playAnimationRef.current(e.target.value)
              }}
              disabled={status !== 'ready' || controlMode || gestureMode}
              className={cn(
                'mt-2 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500',
                'disabled:cursor-not-allowed disabled:opacity-50',
                'dark:border-stone-700 dark:bg-stone-950 dark:text-white',
              )}
            >
              {animations.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name}（{a.duration.toFixed(2)}s）
                </option>
              ))}
            </select>
          </div>

          <p className="text-xs text-stone-400 dark:text-stone-500">
            {gestureMode
              ? '手勢模式中：卡片右上角是鏡頭畫面，比 👍 播放下拉選單選定的動作，跟空白鍵效果一樣。再按一次上面的按鈕退出。'
              : controlMode
                ? '操控模式中：W/A/S/D 走動、空白鍵播放下拉選單選定的動作（預設是揮劍），鏡頭視角不影響移動方向。再按一次上面的按鈕退出。'
                : `這份模型是遊戲真正拆出來的高精度資產，內建 ${animations.length || 97} 個具名動作，這裡完整保留，不像卡片輪播只挑幾個技能展示。`}
          </p>
        </div>
      </div>
    </section>
  )
}
