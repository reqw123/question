// 獨立可行性測試：驗證「D:\至臻_腥红之月_亚托克斯.glb」這份 glTF 2.0 3D 模型能不能用
// Three.js 正常載入、播放骨架動畫。跟 desktop-pet-web 的 PIXI 2D 渲染管線（Live2D／
// Spine）完全分開，不共用任何程式碼／WebGL context——這個資料夾本身就是「另外開一個
// 資料夾專門構建」的產物，純粹回答「這個檔案能不能用」，還沒有考慮怎麼整合進卡片輪播。
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

const app = document.getElementById('app')!
const statusEl = document.querySelector<HTMLDivElement>('[data-testid="status"]')!
const animSelect = document.querySelector<HTMLSelectElement>('[data-testid="anim-select"]')!

function setStatus(text: string, isError = false) {
  statusEl.textContent = text
  statusEl.style.color = isError ? '#ff8a8a' : '#8aff9e'
  console.log('[glb-viewer]', text)
}

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x1b1b22)

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.01, 1000)
camera.position.set(2, 1.6, 3)

const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setSize(window.innerWidth, window.innerHeight)
app.appendChild(renderer.domElement)

// 模型用了 KHR_materials_unlit（見排查記錄），理論上不需要打光也能看到正確顏色，
// 這裡還是加一組基本燈光——如果有材質不是 unlit（例如額外的特效/發光層），至少不會
// 整個黑掉看不見，用來排除「是模型本身的問題，還是燈光沒打對」這個變因。
scene.add(new THREE.AmbientLight(0xffffff, 1.2))
const dirLight = new THREE.DirectionalLight(0xffffff, 1.5)
dirLight.position.set(3, 5, 2)
scene.add(dirLight)

const grid = new THREE.GridHelper(4, 20, 0x444455, 0x2a2a35)
scene.add(grid)

const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0, 1, 0)
controls.enableDamping = true

let mixer: THREE.AnimationMixer | null = null
let currentAction: THREE.AnimationAction | null = null
let clips: THREE.AnimationClip[] = []
// 目前「應該」播的動畫名稱，跟 WASD 移動判斷是不是要換動畫用——playAnimation() 每次
// 呼叫都會 reset() 重播，如果每一幀都呼叫同一個名稱會一直從頭重播、動作卡住看起來像
// 沒在動，所以移動迴圈只在「想播的動畫真的變了」才呼叫 playAnimation()。
let desiredAnim = ''

function playAnimation(name: string) {
  if (!mixer || name === desiredAnim) return
  const clip = clips.find((c) => c.name === name)
  if (!clip) return
  desiredAnim = name
  const next = mixer.clipAction(clip)
  if (currentAction && currentAction !== next) {
    currentAction.fadeOut(0.2)
  }
  next.reset().fadeIn(0.2).play()
  currentAction = next
}

// WASD 移動：跟著攝影機目前的水平朝向算前後左右（常見的第三人稱操作習慣，不是死板的
// 世界座標軸），這樣不管 OrbitControls 轉到哪個角度，W 永遠是「往畫面裡面走」。
// moveSpeed 用模型包圍盒的最大邊長換算，不寫死固定數字——不然遇到不同比例匯出的模型
// （例如以公分為單位）速度會快到飛出去或慢到幾乎不動。
let modelRoot: THREE.Object3D | null = null
let moveSpeed = 1.5
const pressed = new Set<string>()
window.addEventListener('keydown', (e) => {
  if (['w', 'a', 's', 'd'].includes(e.key.toLowerCase())) pressed.add(e.key.toLowerCase())
})
window.addEventListener('keyup', (e) => {
  pressed.delete(e.key.toLowerCase())
})

const RUN_ANIM = 'Run_Base'
const IDLE_ANIM = 'Idle1'
const moveDir = new THREE.Vector3()
// 固定世界座標軸，不是跟著攝影機轉的第三人稱操作——W 永遠是 -Z、D 永遠是 +X，
// 不管滑鼠把視角轉到哪都一樣，跟場景本身的座標系綁在一起（例如要對照模型匯出時
// 原本的朝向、或幾個角色要有一致的移動基準時，這種比較好判斷）。
const WORLD_FORWARD = new THREE.Vector3(0, 0, -1)
const WORLD_RIGHT = new THREE.Vector3(1, 0, 0)
// 只在「從移動變成靜止」那一刻切回待機，不是靜止的每一幀都硬切——不然如果靜止時用
// 下拉選單手動選了別的動畫（例如 Attack1），下一幀立刻會被這裡蓋回 Idle1，選單等於
// 沒作用。移動中則每一幀都可以持續要求 Run_Base，playAnimation() 本身有擋「已經是
// 這個動畫就不重播」，不會有問題。
let wasMoving = false

function updateMovement(delta: number) {
  if (!modelRoot) return

  moveDir.set(0, 0, 0)
  if (pressed.has('w')) moveDir.add(WORLD_FORWARD)
  if (pressed.has('s')) moveDir.sub(WORLD_FORWARD)
  if (pressed.has('d')) moveDir.add(WORLD_RIGHT)
  if (pressed.has('a')) moveDir.sub(WORLD_RIGHT)

  const isMoving = moveDir.lengthSq() > 0
  if (isMoving) {
    moveDir.normalize()
    modelRoot.position.addScaledVector(moveDir, moveSpeed * delta)
    // 面朝移動方向，用 atan2 直接算目標角度再夾一段最短路徑轉過去，避免轉圈圈那種
    // 從 350° 轉回 10° 硬轉一大圈的問題。
    const targetAngle = Math.atan2(moveDir.x, moveDir.z)
    let angleDiff = targetAngle - modelRoot.rotation.y
    angleDiff = ((angleDiff + Math.PI) % (Math.PI * 2)) - Math.PI
    modelRoot.rotation.y += angleDiff * Math.min(1, delta * 10)
    playAnimation(RUN_ANIM)
    // 移動中把下拉選單同步顯示成 Run_Base，滑鼠沒去動它時看起來才跟畫面一致。
    if (animSelect.value !== RUN_ANIM) animSelect.value = RUN_ANIM
  } else if (wasMoving) {
    playAnimation(IDLE_ANIM)
    animSelect.value = IDLE_ANIM
  }
  wasMoving = isMoving

  // 攝影機的環繞目標跟著模型走，不然她移動幾步就走出畫面框外了。
  controls.target.lerp(modelRoot.position.clone().add(new THREE.Vector3(0, 1, 0)), 0.15)
}

setStatus('載入中…')
const loader = new GLTFLoader()
loader.load(
  '/models/aatrox-crimson-moon.glb',
  (gltf) => {
    const model = gltf.scene
    scene.add(model)

    // 模型的實際尺寸/原點未知（不同來源的 glTF 匯出習慣差很多），先量它的包圍盒，
    // 動態算相機距離跟 OrbitControls 目標點，不要寫死猜的數字——寫死的話遇到單位
    // 不一樣的模型（例如以公分為單位匯出）畫面會整個對不上。
    const box = new THREE.Box3().setFromObject(model)
    const size = box.getSize(new THREE.Vector3())
    const center = box.getCenter(new THREE.Vector3())
    const maxDim = Math.max(size.x, size.y, size.z)
    controls.target.copy(center)
    camera.position.set(center.x + maxDim * 0.9, center.y + maxDim * 0.5, center.z + maxDim * 0.9)
    camera.near = maxDim / 100
    camera.far = maxDim * 100
    camera.updateProjectionMatrix()
    controls.update()

    modelRoot = model
    moveSpeed = maxDim * 0.6
    // 除錯用，devtools console 可以直接查角色/攝影機目前狀態，例如
    // window.__scene.modelRoot.position
    ;(window as any).__scene = { modelRoot, camera, controls }

    clips = gltf.animations
    mixer = new THREE.AnimationMixer(model)

    animSelect.innerHTML = ''
    for (const clip of clips) {
      const opt = document.createElement('option')
      opt.value = clip.name
      opt.textContent = `${clip.name}（${clip.duration.toFixed(2)}s）`
      animSelect.appendChild(opt)
    }
    animSelect.addEventListener('change', () => playAnimation(animSelect.value))

    const idleLike = clips.find((c) => /idle/i.test(c.name)) ?? clips[0]
    if (idleLike) {
      animSelect.value = idleLike.name
      playAnimation(idleLike.name)
    }

    setStatus(`載入成功！${clips.length} 個動畫、包圍盒尺寸 ${size.x.toFixed(2)}×${size.y.toFixed(2)}×${size.z.toFixed(2)}`)
  },
  undefined,
  (err) => {
    setStatus(`載入失敗：${(err as Error)?.message ?? err}`, true)
    console.error('[glb-viewer] 完整錯誤：', err)
  },
)

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
})

const clock = new THREE.Clock()
function tick() {
  requestAnimationFrame(tick)
  const delta = clock.getDelta()
  updateMovement(delta)
  mixer?.update(delta)
  controls.update()
  renderer.render(scene, camera)
}
tick()
