import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent } from 'react'
import { AnimatePresence, animate, motion, useReducedMotion } from 'motion/react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { cn } from '../../../lib/utils'
// Spine 支援（雅絲娜）：跟 pixi.js／pixi-live2d-display 走 <script> 全域載入不同，
// @pixi-spine 沒有對應的 vendor 版本可以複製，直接裝成 npm 套件、用 ES import。
// 版本鎖死在 3.1.2——這是唯一還支援 PixiJS v6（專案現有 window.PIXI 的版本）的
// pixi-spine 版本，新版都要求 PixiJS v7+（見 docs 討論記錄）。這裡 import 進來的
// pixi.js（npm 版）只用來建構 Loader／讀 Spine 資料，實際要顯示的 Spine 物件會被
// addChild 進 window.PIXI（全域、<script> 載入）建立的 stage——這兩個是不同的
// PIXI 模組實例，但實測過 PIXI v6 的 DisplayObject/Container 之間沒有嚴格 instanceof
// 檢查，跨實例 addChild 渲染正常，不需要為了 Spine 另開一個 WebGL context
// （多個 WebGL context 互相干擾正是這個共用畫布架構當初要解決的問題，見下面
// ActiveModelHandle 說明）。
import * as PIXI_NPM from 'pixi.js'
import { Spine } from '@pixi-spine/all-4.1'

// pixi.js / pixi-live2d-display 用 <script> 全域載入（見 index.html），跟
// C:\question\lib\ 的原版是同一份唯讀複製，不是另外裝 npm 版本，確保跟
// live2d_my_like/models/ 的資源相容性一致。這裡不用 npm 型別套件，直接宣告成 any——
// 這兩個全域變數的存在完全依賴 index.html 有沒有正確載入對應 script。
declare const PIXI: any

type BaseModelConfig = {
  id: string
  url: string
  label: string
}
// 點擊卡片觸發的展示動作——Live2D 用 motion group + index（沿用既有 model3.json 慣例），
// Spine 用具名動畫（見下面 SpineModelConfig）。兩種角色渲染引擎完全不同（Cubism vs
// Spine 骨骼動畫），只有「載入→量外框→置中→點擊觸發動作」這個外層流程共用，共用的部分
// 靠這個 ModelConfig 判別聯集（kind 欄位）在各個函式裡分支處理。
type Live2DModelConfig = BaseModelConfig & {
  kind: 'live2d'
  motionGroup: string
  motionIndices: number[]
  // 點擊技能動作播完之後要接回去的「待機」index（同一個 motionGroup 底下）——見
  // playRandomSkillFor() 的說明，沒有這個機制的話角色會永遠卡在技能動作播完那一幀。
  idleMotionIndex: number
}
type SpineModelConfig = BaseModelConfig & {
  kind: 'spine'
  // 待機時播放、且會一直循環的動畫名稱。
  idleAnimation: string
  // 點擊卡片時隨機挑一個播放，播完自動接回 idleAnimation（見 playRandomSkillFor()）。
  clickAnimations: string[]
  // 有些 Spine 資產是共用同一份骨架模板、靠切換 skin 變成不同角色，不填就用
  // Spine 資料本身的預設 skin（目前 Asuna 是唯一的 Spine 角色，用不到這個欄位，
  // 保留是因為之後加共用模板的 Spine 角色時會需要）。
  skinName?: string
}
type ModelConfig = Live2DModelConfig | SpineModelConfig

// 三個模型的 Motions 陣列內容、順序都不一樣，「點擊觸發」對應的 index 只能照各自
// model3.json/Spine 資料實際內容寫死，不能共用同一組 index。
//
// **2026-08-12 精簡回三個角色**：曾經一度加到七個（含 abeikelongbi_3、Hiyori、Mao 三個
// Live2D 角色、亞托克斯一個 Spine 角色），後來拿掉——abeikelongbi_3 混進一整套「主畫面
// 情境」道具/背景素材、有個怎麼都隱藏不掉的黑底矩形視覺 bug（pixi-live2d-display 這個
// 版本的 Live2DModel._render() 不吃 PIXI 標準的 alpha／mask，只有 model.visible 可靠，
// 是 vendor 函式庫這層的限制），Hiyori/Mao/亞托克斯的 Spine 資產則是使用者決定不再保留。
// 現在只剩 077、1024100（Live2D）、Asuna（Spine）三個乾淨的角色，不需要
// EXTRA_HIDDEN_PARTS/DRAWABLES 那套「額外美術資源」處理機制。
const MODELS: ModelConfig[] = [
  {
    kind: 'live2d',
    id: '077',
    url: '/characters/models/077/c_7002.model3.json',
    label: '模型 077',
    // Motions 只有一個未命名 group（key 是空字串），裡面 4 顆檔案：
    // index 0 是待機用的 c_7002，1~3 才是真正的技能動作（skill_02~04）。
    motionGroup: '',
    motionIndices: [1, 2, 3],
    idleMotionIndex: 0,
  },
  {
    kind: 'live2d',
    id: '1024100',
    url: '/characters/models/1024100/1024100.model3.json',
    label: '模型 1024100',
    // index 0 = 00_Skill_02、index 16 = 00_Skill_01，其餘都是表情/情緒動作，
    // index 17 = 00_Wait_01（motion3.json 本身 Loop:true，命名也看得出是待機動作）。
    motionGroup: '',
    idleMotionIndex: 17,
    motionIndices: [0, 16],
  },
  {
    // **2026-08-11 新增，第一個 Spine 角色**：雅絲娜（D:\雅絲娜\ 過來的資產）是
    // Spine 4.2.43 匯出的，專案 PixiJS 是 v6、能配的 pixi-spine（@pixi-spine/all-4.1
    // @3.1.2）runtime 只到 4.1——版本沒對齊，載入時 console 會印一行
    // 「Spine 4.1 loader cant load version 4.2.43」的警告，但實測骨架/貼圖/具名動畫
    // 都能正常載入播放，只有 4.2 才新增的物理約束系統（頭髮/裙擺次要晃動）不會生效，
    // 角色動作本身不受影響。已經實測過跨 PIXI 實例（npm 版 pixi-spine 建的 Spine
    // 物件 → 全域 window.PIXI 建的 stage）渲染正常，見上面 import 區塊的說明。
    kind: 'spine',
    id: 'Asuna',
    url: '/characters/models/asuna/asuna.json',
    label: '模型 Asuna',
    idleAnimation: '00_Idle',
    // 有名字看得出來是「招式」的三個動作，點擊隨機挑一個播，播完自動接回待機
    // （見 playRandomSkillFor()）。
    clickAnimations: ['08_SwordAttack', '05_MagicAttack', '06_PunchAttack'],
  },
  // **TODO：占位條目，等新角色資源確定後手動填**——id/url/label 目前是空字串，在這個
  // 狀態下這張卡片會顯示「角色載入失敗」（loadModel() fetch 空字串會失敗，但只有這
  // 張卡片壞掉，不影響其他角色，是既有的容錯機制），填好 url 之後才會正常。
  // 這裡先用 kind: 'live2d' 的欄位形狀起手；idleMotionIndex 是技能動作播完要接回去的
  // 待機 index（見 playRandomSkillFor()），不填對會導致角色永遠卡在技能動作最後一幀，
  // 這是實測過的真的 bug，不是可有可無的欄位。如果新角色是 Spine（沒有固定副檔名，
  // 資料夾裡會有一個 .atlas），把 motionGroup/motionIndices/idleMotionIndex 換成
  // idleAnimation/clickAnimations（可選 skinName），照上面 Asuna 那筆的形狀改，
  // 兩種 kind 的欄位不能混用（見上面 Live2DModelConfig／SpineModelConfig 的型別）。
  // 可以用 node public/characters/config/generate-manifest.js 掃出可用的
  // group/index 或 animations 清單當參考，不想看它的猜測值也沒關係，這裡本來就是
  // 全部空著讓你自己填。
  {
    kind: 'live2d',
    id: '',
    url: '',
    label: '',
    motionGroup: '',
    motionIndices: [],
    idleMotionIndex: 0,
  },
]

// **2026-08-10 手動校正圖層，比照 desktop-pet（lib/live2d.js）manifest.json 的
// layout／names.json 機制**：不同角色的原始美術比例天生不一樣（有的角色站姿瘦高、有的
// 帶著大範圍特效展開），applyFitAt() 統一「塞進卡片高度 85%」的自動置中邏輯，套到不同
// 角色上視覺大小會不一致（例如站姿角色沒有展開的道具，量出來的框特別瘦高，跟卡片同
// 高度時寬度佔比很小，同一批角色裡 077 因為技能特效展開卻能佔到 84%）。
//
// desktop-pet 那邊本來就有同一類問題（每個模型 moc3 留白/比例不同套同一組 offsetX/
// offsetY/scale 會錯位），解法是 manifest.json 每個模型項目掛一個 layout 物件，
// 讀取時用「空字串＝未設定，維持原樣」的慣例合併進該角色的設定（見 lib/live2d.js
// 的 _mergeLayout()）。這裡複製同一套機制、同一種檔案格式（manifest.json 陣列＋
// names.json 路徑對名稱），差別只在合併對象：desktop-pet 的 cfg.scale 是乘在
// 「欄位寬度／模型原始寬度」這個桌面疊加層專用的基準上；這裡的 layout.scale 乘在
// applyFitAt() 本來就會自動算出來的置中縮放比例上（見 applyFitAt() 的呼叫方式），
// layout.offsetX／offsetY 則是疊加在自動算出的置中位置上的像素微調——公式基準不同（一個
// 是桌面全螢幕欄位、一個是卡片矩形），但「manifest.json 手動校正、疊加在自動基準上」
// 這個機制本身是同一套，不是另外發明一套新邏輯。
//
// **2026-08-11 資料夾改成跟 live2d_my_like 同一種 models/ + config/ 分開的結構**：
// 角色資產（.model3.json/.moc3/貼圖，或 Spine 的 .json/.atlas/貼圖）都在
// public/characters/models/{角色 id}/ 底下；manifest.json／names.json 這兩份設定檔
// 集中放 public/characters/config/，不再跟角色資產混在同一層——理由跟 live2d_my_like
// 當初分開的理由一樣：角色資產是大量的靜態檔案，設定檔是少數幾份會被人常常打開手動編輯
// 的檔案，混在一起找起來麻煩。Live2D／Spine 兩種角色共用同一組 models/config，不用因為
// 引擎不同就分成兩套目錄結構（manifest.json／names.json 本來就已經是共用的，見下面的
// 說明）。
//
// manifest.json 三個角色的 layout 大多是空字串（未校正），只有 1024100 手動校正過
// offsetY；names.json 也都先填成跟 id 一樣的預設值，等使用者自己在畫面上調好
// scale/offsetX/offsetY，用瀏覽器 console 呼叫 window.printLive2DLayout() 印出目前顯示中
// 角色的建議值，貼回 manifest.json 對應項目即可（用法跟 lib/live2d.js 的 L2D.printPos() 相同）。
const MANIFEST_URL = '/characters/config/manifest.json'
const NAMES_URL = '/characters/config/names.json'

type LayoutOverride = { offsetX: number; offsetY: number; scale: number }
const DEFAULT_LAYOUT: LayoutOverride = { offsetX: 0, offsetY: 0, scale: 1 }

// 從 MODELS[].url（例如 '/characters/models/077/c_7002.model3.json'）反推
// manifest.json／names.json 用的 path key（拿掉開頭的 '/characters/models/'，剩下
// '077/c_7002.model3.json'），跟 desktop-pet 那邊「manifest.json 的 path 相對
// live2d_my_like/models/」是同一種相對路徑慣例，Live2D／Spine 兩種角色 kind 共用
// 同一套推導規則，不用因為引擎不同分開處理。
function modelPathKey(config: ModelConfig): string {
  return config.url.replace(/^\/characters\/models\//, '')
}

// 跟 lib/live2d.js 的 _mergeLayout() 同一種合併規則：空字串／undefined／null 一律視為
// 「未設定」，不覆蓋預設值；其餘值一律轉成數字（manifest.json 手動編輯打成字串也不會壞）。
function mergeLayout(raw: unknown): LayoutOverride {
  const merged = { ...DEFAULT_LAYOUT }
  if (!raw || typeof raw !== 'object') return merged
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === '' || v === undefined || v === null) continue
    const num = Number(v)
    if (Number.isNaN(num)) continue
    if (k === 'offsetX' || k === 'offsetY' || k === 'scale') merged[k] = num
  }
  return merged
}

export type Box = { x: number; y: number; width: number; height: number }

// 手勢拖曳模組（GestureDragControl，包在這個元件外層的平行元件）跟這裡溝通的唯一介面：
// 目前顯示中模型的 PIXI 實例、量好的緊致外框、取畫布尺寸的方法、把模型標記成「已逃出」
// 的方法。這個元件（跟它管理的每個模型）完全不知道「手勢」這個概念存在，見 docs/specs/0010。
//
// **2026-08-10 改版**：整個 Hero 區塊只用一個共用的 PIXI.Application／stage，三個模型
// 全部常駐（eager 載入、載完就 addChild 進同一個 stage，不因為切卡片而卸載）。上一版每個
// 模型各自一個 PIXI.Application 的作法，實測發現同時存在兩個以上 WebGL context 時
// pixi-live2d-display 內部共用的 GL 資源會跨 context 誤用，背景模型畫不出東西（見
// docs/specs/0010「已知限制」段落）——這是換成單一共用畫布的直接原因。因為現在只有一套
// 座標系（永遠是這個共用畫布的大小），「逃出卡片」不再需要搬動任何 DOM 節點，單純是
// PIXI 的 `model.position`／`model.scale` 屬性 + 一個「不要因為切卡片被自動隱藏/歸位」
// 的旗標（markEscaped）。
export type ActiveModelHandle = {
  model: any
  tightBounds: Box
  getCanvasSize: () => { width: number; height: number }
  // 第一次選定、準備開始拖曳時呼叫：回傳 true 表示可以拖（之後這個模型的可見度/位置
  // 就不再受切卡片影響，見下方「所在位置」三種狀態）；回傳 false 表示已達
  // maxEscapedModels 上限，呼叫端不應該把這次手勢當成選定成功。已經逃出過的模型
  // 再呼叫一律回傳 true（不重複計數）。
  markEscaped: () => boolean
}

// **2026-08-12 真正的 Live2D/Spine 角色飛行**：卡片左下角的「叫大家飛出來」按鈕
// （在 Hero.tsx）觸發，讓 MODELS 目前已載入好的角色（就是輪播本身這三個，不是另外準備
// 的分身/假圖示）暫時一起可見、從卡片上方飛入疊在一起，停留一段時間後再飛出消失、還原
// 成正常的輪播狀態。之所以直接複用輪播現有的模型實例（而不是另開一個獨立 PIXI 畫布重新
// 載入一次），是因為這三個角色本來就已經在同一張共用畫布上（見上面「單一共用畫布」的
// 說明），飛行只是暫時解除「只有目前卡片那隻可見」的限制、把三隻的 position/scale
// 一起動畫化，不需要重複下載資源或多開一個 WebGL context。用 forwardRef 把觸發方法
// 交給 Hero.tsx（按鈕在那邊，這個元件不知道按鈕長什麼樣子，只提供「飛」這個能力）。
export type HeroLive2DStageHandle = {
  // targetEl：飛行的目的地——頁面上任何一個 DOM 節點（例如某個 Spotlight 卡片的視覺
  // 面板），角色會飛到它目前的畫面位置疊在一起。不給就退回舊行為（飛在 Hero 卡片自己
  // 裡面），是防禦性 fallback，正常呼叫端應該都會給。
  flyIn: (targetEl?: HTMLElement | null) => void
}

// 直接從 Cubism 的 drawable 頂點資料算出角色真正輪廓的外框（單位：模型在 scale=1 時的
// 本地像素座標，跟 model.getBounds() 同一個慣例：以整張 moc3 畫布左上角為原點）。
//
// **2026-08-10 新增，取代原本用 renderer.extract.pixels() 對畫面做像素 alpha 掃描的做法**：
// 排查曾經一個角色的黑底矩形 bug（見上面 MODELS 的說明，該角色已移除）時發現，這個共用
// 畫布架構下 extract.pixels() 在 loadModel() 的執行時機點讀回來的畫面是全透明的（跟畫面
// 實際顯示的內容對不上），量出來的外框因此整個退回「量測失敗，直接用整張畫布」的保底
// 邏輯——不是只有那個角色受影響，是所有模型的「畫布留白」偵測都沒有真的生效，只是其他
// 模型的保底畫布沒有大到會被使用者注意到。改成直接讀 Cubism core 的頂點資料（`getDrawableVertexPositions`），
// 不牽涉任何一次額外的離屏渲染，沒有這個時機問題，而且比對整張 6000x6000 畫布做像素掃描
// 便宜得多。
//
// 頂點資料是「模型本地座標」（以角色中心為原點，pixelsPerUnit 決定跟像素的比例），要透過
// `internalModel.centeringTransform`（把本地座標映成整張 moc3 畫布像素座標的仿射矩陣）
// 換算成跟 model.getBounds() 同一套慣例的像素座標，applyFitAt() 才能直接拿來用。
function computeGeometryBounds(model: any, isExtraHidden: (index: number) => boolean): Box | null {
  const core = model.internalModel?.coreModel
  const ct = model.internalModel?.centeringTransform
  if (!core || !ct) return null

  const count = core.getDrawableCount()
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < count; i++) {
    if (isExtraHidden(i)) continue
    if (core.getDrawableOpacity(i) <= 0) continue
    const verts = core.getDrawableVertexPositions(i)
    if (!verts || verts.length === 0) continue
    for (let v = 0; v < verts.length; v += 2) {
      const x = verts[v]
      const y = verts[v + 1]
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  if (maxX < minX || maxY < minY) return null

  // 用矩陣的四個角分別換算，不假設 a/d 一定是正值（避免有模型的座標系統剛好上下或
  // 左右翻轉時算出負的寬高）。
  const corners = [
    [minX, minY],
    [maxX, minY],
    [minX, maxY],
    [maxX, maxY],
  ].map(([x, y]) => [x * ct.a + ct.tx, y * ct.d + ct.ty])
  const xs = corners.map((c) => c[0])
  const ys = corners.map((c) => c[1])
  const px0 = Math.min(...xs)
  const px1 = Math.max(...xs)
  const py0 = Math.min(...ys)
  const py1 = Math.max(...ys)
  return { x: px0, y: py0, width: px1 - px0, height: py1 - py0 }
}

// 量測模型「真正會顯示出來」的外框（scale=1 時的本地座標），只在每次模型載入完成時算一次，
// 結果會被 applyFitAt() 重複使用（包含 resize／逐幀跟著卡片外框移動時），不會每次都重新算。
function measureTightBounds(model: any, isExtraHidden: (index: number) => boolean): Box {
  const geometryBounds = computeGeometryBounds(model, isExtraHidden)
  if (geometryBounds) return geometryBounds

  // 保底：找不到 centeringTransform 或量不出任何可見 drawable 時，退回 PIXI 內建的
  // getBounds()——這個值在部分模型上會是整張 moc3 畫布（角色因此被縮得很小），但至少
  // 角色本身還會顯示出來，不會整個消失。
  model.scale.set(1)
  model.position.set(0, 0)
  const rawBounds = model.getBounds()
  return { x: rawBounds.x, y: rawBounds.y, width: rawBounds.width || 1, height: rawBounds.height || 1 }
}

// 把 measureTightBounds() 量出來的框（scale=1 時的本地座標）縮放並置中對齊到 rect 這個
// 矩形（rect 是「共用畫布」本地座標，不是永遠從 (0,0) 開始——這是跟舊版 applyFit() 的
// 唯一差別：舊版只服務單一個、永遠佔滿整個小畫布的模型，這版要能把任何模型置中對齊到
// 畫布裡的任意矩形，包含「目前是卡片外框的哪個位置」跟「被手勢拖到 Hero 區塊哪裡」兩種
// 情境，兩者都只是傳不同的 rect 進來，邏輯完全共用）。
// layout：manifest.json 的手動校正值（見上面 MANIFEST_URL 那段說明），預設
// { offsetX:0, offsetY:0, scale:1 }＝不校正，跟原本行為完全一樣。scale 是乘在自動算出的
// fit 縮放比例上，offsetX／offsetY 是加在自動算出的置中位置上的像素微調。
function applyFitAt(model: any, box: Box, rect: Box, layout: LayoutOverride = DEFAULT_LAYOUT) {
  const scale = Math.min((rect.width * 0.85) / box.width, (rect.height * 0.85) / box.height) * layout.scale
  model.scale.set(scale)
  model.position.set(
    rect.x + (rect.width - box.width * scale) / 2 - box.x * scale + layout.offsetX,
    rect.y + (rect.height - box.height * scale) / 2 - box.y * scale + layout.offsetY,
  )
}

type LoadState = 'loading' | 'ready' | 'error'

type ModelSlot = {
  model: any
  tightBounds: Box | null
  status: LoadState
  // 逃出過一次就永遠是 true（放開不會自動歸位）；true 的模型不再受「切卡片就隱藏/
  // 重新置中」影響，位置完全交給 GestureDragControl 透過 model.position 直接控制。
  escaped: boolean
  // manifest.json 讀回來、合併過空字串規則之後的校正值，預設 DEFAULT_LAYOUT（不校正）。
  layout: LayoutOverride
}

const flipVariants = {
  enter: (direction: number) => ({ rotateY: direction > 0 ? 90 : -90, opacity: 0 }),
  center: { rotateY: 0, opacity: 1 },
  exit: (direction: number) => ({ rotateY: direction > 0 ? -90 : 90, opacity: 0 }),
}

const fadeVariants = {
  enter: { opacity: 0 },
  center: { opacity: 1 },
  exit: { opacity: 0 },
}

export const HeroLive2DStage = forwardRef<
  HeroLive2DStageHandle,
  {
    className?: string
    // Hero.tsx 提供、蓋住整個 Hero 區塊的無裁切容器，真正的 <canvas> 會被 append 進這裡
    // 一次（掛載時），之後不會再搬動——跟上一版「每次切卡片就要搬 DOM」完全不同，這裡
    // 只有一次性的 appendChild，風險跟過去踩過的坑（createPortal 孤兒化節點、React
    // removeChild 打架）都無關。
    canvasHost?: HTMLElement | null
    onActiveModelChange?: (handle: ActiveModelHandle | null) => void
    // 手勢拖曳最多能同時讓幾個角色逃出卡片、飄在 Hero 區塊——刻意設成必填、不給預設值，
    // 這個數字唯一的來源是 config.ts 的 MAX_ESCAPED_MODELS（由 Hero.tsx 傳進來），避免
    // 這裡再放一份預設值造成兩處數字要一起改才不會兜不起來。見 docs/specs/0010。
    maxEscapedModels: number
    // flyIn() 執行期間／結束時通知 Hero.tsx，讓觸發按鈕能顯示「飛行中」的停用狀態。
    onFlyInStateChange?: (flying: boolean) => void
  }
>(function HeroLive2DStage(
  { className, canvasHost, onActiveModelChange, maxEscapedModels, onFlyInStateChange },
  ref,
) {
  const [index, setIndex] = useState(0)
  const [direction, setDirection] = useState(1)
  const [currentModelState, setCurrentModelState] = useState<LoadState>('loading')
  // names.json 讀回來的顯示名稱覆寫（見 MANIFEST_URL 那段說明），key 是 modelPathKey()
  // 的結果。沒讀到或該角色沒有對應項目就退回 MODELS[].label（下面 currentLabel 處理）。
  const [nameOverrides, setNameOverrides] = useState<Record<string, string>>({})
  const reduceMotion = useReducedMotion()
  const current = MODELS[index]
  const currentLabel = nameOverrides[modelPathKey(current)] ?? current.label

  // chromeRef：純粹拿來量測「卡片外框目前在畫布裡的矩形」的錨點，故意跟下面會做
  // rotateY 3D 翻牌動畫的 motion.div 分開——量測會翻轉中的元素不準（getBoundingClientRect()
  // 在套用 3D transform 時量到的是螢幕投影後的外框，翻到一半會被壓扁甚至趨近 0，這個
  // repo 已經踩過這個坑），這個錨點本身永遠不套用任何 transform，量出來的矩形才可靠。
  const chromeRef = useRef<HTMLDivElement>(null)
  const appRef = useRef<any>(null)
  const slotsRef = useRef<Record<string, ModelSlot>>(
    Object.fromEntries(MODELS.map((m) => [m.id, { model: null, tightBounds: null, status: 'loading', escaped: false, layout: DEFAULT_LAYOUT }])),
  )
  const homeRectRef = useRef<Box>({ x: 0, y: 0, width: 1, height: 1 })
  const escapedIdsRef = useRef<Set<string>>(new Set())
  const indexRef = useRef(0)
  const onActiveModelChangeRef = useRef(onActiveModelChange)
  const maxEscapedModelsRef = useRef(maxEscapedModels)
  // 切卡片時「上一張」對應的模型 id，用來讓舊模型淡出、新模型淡入（見下面切卡片的
  // useEffect）；transitionTokenRef 是每次切卡片就遞增的序號，切得夠快時舊的
  // animate() callback 還沒跑完就被下一次切卡片蓋過去，用這個序號讓過期的 callback
  // 變成 no-op，不會跟新的轉場動畫互相覆寫 alpha。
  const prevCurrentIdRef = useRef<string | null>(null)
  const transitionTokenRef = useRef(0)
  // **按需載入**：只有目前卡片＋左右鄰居會被載入，不是一次把全部 7 個角色的資源都載完
  // （見下面 ensureNeighborsLoaded 的說明）。requestedIdsRef 記錄「已經呼叫過
  // loadModel() 的角色 id」，避免同一個角色被重複觸發載入——status 不能拿來當這個判斷
  // 依據，因為 status 預設就是 'loading'，載入請求送出前後看起來是同一個值。
  // ensureNeighborsLoadedRef 是掛載 effect 裡定義的實際函式（需要存取 loadModel／
  // manifestPromise 等只在那個 effect 存在的變數），透過 ref 轉手給切卡片的 effect呼叫，
  // 跟 Aatrox3DShowcase 的 playAnimationRef／resetPoseRef 是同一種跨 effect 溝通模式。
  const requestedIdsRef = useRef<Set<string>>(new Set())
  const ensureNeighborsLoadedRef = useRef<(centerIndex: number) => void>(() => {})
  // flyIn() 的實際實作掛載在掛載 effect 裡（需要存取 localApp／slotsRef 等只在那個
  // effect 存在的變數），跟 ensureNeighborsLoadedRef 同一種跨 effect 溝通模式，透過
  // useImperativeHandle 轉手給 Hero.tsx 的 ref。flyingRef 是「目前是不是正在飛」的旗標，
  // goPrev/goNext/goTo／trackHomeRect 都要讀它來避免飛行中被切卡片邏輯打斷。
  const flyInImplRef = useRef<(targetEl?: HTMLElement | null) => void>(() => {})
  const flyingRef = useRef(false)
  const flyInTokenRef = useRef(0)
  const onFlyInStateChangeRef = useRef(onFlyInStateChange)
  // playRandomSkillFor() 用來避免「motionFinish 監聽器晚到」的過期回呼問題（見該函式
  // 說明）：key 是角色 id，value 是這個角色目前第幾次點擊，每次點擊遞增；
  // motionFinish callback 觸發時比對自己捕捉到的那個數字還是不是最新的，不是就代表
  // 使用者在待機動作接回去之前又點了一次，這個回呼作廢，不會蓋掉更新的那次點擊。
  const skillTokenRef = useRef<Map<string, number>>(new Map())

  useEffect(() => {
    onActiveModelChangeRef.current = onActiveModelChange
  }, [onActiveModelChange])
  useEffect(() => {
    maxEscapedModelsRef.current = maxEscapedModels
  }, [maxEscapedModels])
  useEffect(() => {
    indexRef.current = index
  }, [index])
  useEffect(() => {
    onFlyInStateChangeRef.current = onFlyInStateChange
  }, [onFlyInStateChange])

  useImperativeHandle(ref, () => ({ flyIn: (targetEl) => flyInImplRef.current(targetEl) }), [])

  function makeHandle(id: string): ActiveModelHandle {
    const slot = slotsRef.current[id]
    return {
      model: slot.model,
      tightBounds: slot.tightBounds as Box,
      getCanvasSize: () => ({ width: appRef.current?.screen.width ?? 0, height: appRef.current?.screen.height ?? 0 }),
      markEscaped: () => markEscaped(id),
    }
  }

  function markEscaped(id: string): boolean {
    const slot = slotsRef.current[id]
    if (!slot?.model) return false
    if (slot.escaped) return true
    if (escapedIdsRef.current.size >= maxEscapedModelsRef.current) return false
    escapedIdsRef.current.add(id)
    slot.escaped = true
    return true
  }

  // **2026-08-12 修掉「點過技能動作後角色永遠卡住」的 bug**：Live2D 這幾個角色的
  // model3.json 沒有名字剛好叫 "Idle" 的 motion group（都塞在同一個沒命名的空字串
  // group 裡），pixi-live2d-display 內建的自動待機機制只認 "Idle" 這個名字，所以
  // 從來沒有真的自動待機過——實測過（devtools 直接量 drawable 頂點資料）：不管等
  // 幾幀，角色的姿勢完全不會自己變。點技能動作播完之後，因為沒有東西接手，角色就
  // 永遠停在那個動作最後一幀不動，運氣不好停在哪一幀（有些技能動作只有 0.5~0.6 秒，
  // 明顯是設計成播完會馬上被待機接走的過場動作）看起來就像「突然少了一塊」（例如
  // 特效/披風/道具那類 ArtMesh 剛好淡出到一半）。Spine 角色（Asuna）不會有這個問題，
  // 因為 clickAnimations 播完本來就用 addAnimation() 手動接回 idleAnimation（見下面
  // else 分支）——這裡讓 Live2D 也做同一件事：監聽 motionManager 的 "motionFinish"
  // 事件，播完就手動接回 idleMotionIndex（見 MODELS 的說明），用 MotionPriority.IDLE
  // 播放（優先權最低，使用者下一次點擊的 FORCE 動作可以直接蓋過去，不會卡住）。
  // skillTokenRef 防的是「使用者連續快速點擊」：舊的 motionFinish 監聽器如果在新的
  // 技能動作已經開始播放之後才觸發，不比對 token 直接接回待機的話，會把剛播的新動作
  // 打斷、蓋成待機姿勢。
  function playRandomSkillFor(id: string) {
    const slot = slotsRef.current[id]
    if (!slot?.model) return
    const config = MODELS.find((m) => m.id === id)!
    try {
      if (config.kind === 'live2d') {
        const idx = config.motionIndices[Math.floor(Math.random() * config.motionIndices.length)]
        const token = (skillTokenRef.current.get(id) ?? 0) + 1
        skillTokenRef.current.set(id, token)
        slot.model.motion(config.motionGroup, idx, PIXI.live2d.MotionPriority.FORCE)
        const motionManager = slot.model.internalModel?.motionManager
        motionManager?.once('motionFinish', () => {
          if (skillTokenRef.current.get(id) !== token) return
          try {
            slot.model.motion(config.motionGroup, config.idleMotionIndex, PIXI.live2d.MotionPriority.IDLE)
          } catch (err) {
            console.error('[HeroLive2DStage] 技能動作播完接回待機失敗：', id, err)
          }
        })
      } else {
        const name = config.clickAnimations[Math.floor(Math.random() * config.clickAnimations.length)]
        // 播一次指定動作，播完自動排隊接回待機動畫（mixDuration=0：不用交叉淡出，
        // 這幾個招式動作起手/收尾本身就有到位，不用額外補間）。
        slot.model.state.setAnimation(0, name, false)
        slot.model.state.addAnimation(0, config.idleAnimation, true, 0)
      }
    } catch (err) {
      console.error('[HeroLive2DStage] 技能動作播放失敗：', err)
    }
  }

  // 唯一負責建立/銷毀 PIXI.Application 跟三個模型的 effect——只在 canvasHost 第一次
  // 從 null 變成真正的 DOM 節點時執行一次（[canvasHost] 依賴），之後不會再重跑，整個
  // 元件活著期間只有一個 PIXI.Application、三個模型全部常駐。
  useEffect(() => {
    if (!canvasHost) return

    let destroyed = false
    // flyIn() 停留階段（見下面 flyInImpl）用 setTimeout 排程「停留夠久了、開始飛出去」，
    // 卸載時如果還在停留階段要記得清掉，不然元件都銷毀了 callback 還會摸已經 destroy
    // 掉的 model。
    let flyInHoldTimeoutId: ReturnType<typeof window.setTimeout> | undefined
    // Spine 角色的逐幀 update（見下面 loadModel()）——掛在 localApp.ticker 上、卸載時
    // 要記得 remove 的 per-model callback，統一在這個清單裡收集，effect cleanup 時清掉。
    const perModelTickers: (() => void)[] = []

    // 載入 Spine 資料（雅絲娜）：@pixi-spine 的 loader 中介層註冊在 npm 版
    // PIXI_NPM.Loader 上（不是全域 window.PIXI.Loader），所以載入這段一定要用 npm
    // 版 Loader，跟 Live2DModel.from() 用全域 PIXI 是兩條不同的載入路徑——包成
    // Promise 統一介面，讓下面 loadModel() 可以跟 Live2D 那支共用同一段 Promise.all
    // 等待邏輯。回傳已經 new 好、autoUpdate 關掉（改由 loadModel() 掛 ticker 手動
    // update，理由見下面呼叫端註解）的 Spine 實例，跟 Live2DModel.from() 回傳「已經
    // 可以 addChild 的模型物件」是同一種介面形狀。
    function loadSpineModel(config: SpineModelConfig): Promise<any> {
      return new Promise((resolve, reject) => {
        const loader = new PIXI_NPM.Loader()
        loader.add(config.id, config.url)
        loader.load((_loader: PIXI_NPM.Loader, resources: Partial<Record<string, PIXI_NPM.LoaderResource>>) => {
          // spineData 型別是 @pixi-spine/base 版本無關的 ISkeletonData 介面，跟
          // Spine 建構子要的 runtime-4.1 具體 SkeletonData 類別對不上——這裡是型別
          // 系統太嚴格，不是真的不相容（loader-4.1 產出的物件本來就是 runtime-4.1
          // 的 SkeletonData，只是 loader 回傳型別故意寫得比較通用），直接用 any 跨過去。
          const spineData: any = (resources[config.id] as any)?.spineData
          if (!spineData) {
            reject(new Error(`Spine 資料載入失敗（resources.${config.id}.spineData 是空的，載入中介層可能沒有正確註冊）`))
            return
          }
          const spine = new Spine(spineData)
          spine.autoUpdate = false
          resolve(spine)
        })
        loader.onError.add((err: any) => reject(err instanceof Error ? err : new Error(String(err))))
      })
    }
    const localApp = new PIXI.Application({
      width: Math.max(1, canvasHost.clientWidth),
      height: Math.max(1, canvasHost.clientHeight),
      backgroundAlpha: 0,
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
    })
    appRef.current = localApp
    localApp.view.style.width = '100%'
    localApp.view.style.height = '100%'
    localApp.view.style.display = 'block'
    canvasHost.appendChild(localApp.view)

    // 手動校正輔助工具，比照 lib/live2d.js 的 L2D.printPos()：
    // 1) 在瀏覽器 devtools console 直接改 model.scale/position 試位置，例如
    //    `window.__live2dSlots['077'].model.position.x += 10`
    //    `window.__live2dSlots['077'].model.scale.set(0.2)`
    // 2) 畫面上調到滿意了，呼叫 `window.printLive2DLayout('077')`（不帶參數＝目前
    //    顯示中的角色），會反過來把模型目前實際的 scale／position 換算回
    //    offsetX/offsetY/scale，印出可以直接貼回 public/characters/config/manifest.json
    //    該角色 layout 欄位的 JSON，不用自己心算 applyFitAt() 的公式。
    ;(window as any).__live2dSlots = slotsRef.current
    ;(window as any).printLive2DLayout = (id?: string) => {
      const targetId = id ?? MODELS[indexRef.current].id
      const slot = slotsRef.current[targetId]
      if (!slot?.model || !slot.tightBounds) {
        console.warn(`[printLive2DLayout] "${targetId}" 還沒載入完成或找不到，先等載入完再試`)
        return
      }
      const box = slot.tightBounds
      const rect = homeRectRef.current
      const actualScale = slot.model.scale.x
      const baseScale = Math.min((rect.width * 0.85) / box.width, (rect.height * 0.85) / box.height)
      const baseX = rect.x + (rect.width - box.width * actualScale) / 2 - box.x * actualScale
      const baseY = rect.y + (rect.height - box.height * actualScale) / 2 - box.y * actualScale
      const layout = {
        offsetX: Math.round((slot.model.position.x - baseX) * 10) / 10,
        offsetY: Math.round((slot.model.position.y - baseY) * 10) / 10,
        scale: Math.round((actualScale / baseScale) * 1000) / 1000,
      }
      console.log(`[printLive2DLayout] "${targetId}" 目前實際 scale=${actualScale.toFixed(3)} position=(${slot.model.position.x.toFixed(1)}, ${slot.model.position.y.toFixed(1)})`)
      console.log(`[printLive2DLayout] 貼回 public/characters/config/manifest.json 該角色的 layout：`, JSON.stringify(layout))
    }

    // 卡片外框可能有浮動的閒置動畫（見 Hero.tsx 的 y bob），如果只在 resize 時量測
    // 矩形，模型的位置會跟外框的浮動脫節（外框飄、模型不飄）。改成掛在 PIXI 自己的
    // ticker 上、逐幀重新量測＋重新 fit——反正 PIXI 本來就每幀都在畫，多一次
    // getBoundingClientRect() 跟幾個乘法的成本可以忽略，換來的是模型永遠跟外框對齊，
    // 不需要另外去對兩個獨立的 CSS 動畫做時間同步。
    function trackHomeRect() {
      if (destroyed) return
      const chrome = chromeRef.current
      if (!chrome) return
      const chromeRect = chrome.getBoundingClientRect()
      const hostRect = canvasHost!.getBoundingClientRect()
      homeRectRef.current = {
        x: chromeRect.left - hostRect.left,
        y: chromeRect.top - hostRect.top,
        width: chromeRect.width,
        height: chromeRect.height,
      }
      // 飛行動畫進行中：目前這張卡片對應的模型 position/scale 由 flyIn() 自己的補間
      // 接管，這裡如果照常每幀強制 applyFitAt() 回卡片正中央，會跟飛行動畫打架
      // （每幀被拉回去，飛行看起來完全沒有在動）。
      if (flyingRef.current) return
      const slot = slotsRef.current[MODELS[indexRef.current].id]
      if (slot.model && slot.tightBounds && !slot.escaped) {
        applyFitAt(slot.model, slot.tightBounds, homeRectRef.current, slot.layout)
      }
    }
    localApp.ticker.add(trackHomeRect)

    // manifest.json／names.json 只需要抓一次，跟每個模型各自的 Live2DModel.from() 平行抓
    // （見下面 loadModel() 用 Promise.all 一起等），不用序列化拖慢載入。抓失敗一律退回
    // 空清單/空物件——所有角色維持 DEFAULT_LAYOUT（不校正）、預設中文 label，不會因為
    // 這兩份設定檔壞掉就讓角色整個載入不出來。
    const manifestPromise: Promise<[any[], Record<string, string>]> = Promise.all([
      fetch(MANIFEST_URL, { cache: 'no-store' })
        .then((r) => r.json())
        .catch((err) => {
          console.error('[HeroLive2DStage] manifest.json 讀取失敗，角色維持預設縮放/位置：', err)
          return []
        }),
      fetch(NAMES_URL, { cache: 'no-store' })
        .then((r) => r.json())
        .catch((err) => {
          console.error('[HeroLive2DStage] names.json 讀取失敗，角色名稱維持預設值：', err)
          return {}
        }),
    ])

    async function loadModel(config: ModelConfig) {
      const slot = slotsRef.current[config.id]
      let localModel: any
      let manifest: any[]
      let names: Record<string, string>
      try {
        ;[localModel, [manifest, names]] = await Promise.all([
          config.kind === 'live2d' ? PIXI.live2d.Live2DModel.from(config.url) : loadSpineModel(config),
          manifestPromise,
        ])
      } catch (err) {
        console.error('[HeroLive2DStage] 模型載入失敗：', config.id, err)
        if (!destroyed) {
          slot.status = 'error'
          if (MODELS[indexRef.current].id === config.id) setCurrentModelState('error')
        }
        return
      }
      if (destroyed) {
        localModel.destroy({ children: true })
        return
      }
      slot.model = localModel
      localModel.visible = false
      localApp.stage.addChild(localModel)

      // manifest.json 用 path（modelPathKey()）比對，跟 desktop-pet 的 byPath 查表邏輯一樣。
      const pathKey = modelPathKey(config)
      const manifestEntry = manifest.find((e) => e && e.path === pathKey)
      slot.layout = mergeLayout(manifestEntry?.layout)
      // names.json 是所有角色共用同一份物件，5 個模型都會呼叫到，但傳的是同一個 parse
      // 出來的物件參照，React 只會真的重新 render 一次（Object.is 比較會擋掉重複的）。
      setNameOverrides(names)

      // Spine 角色：播待機動畫、掛上逐幀 update。autoUpdate 關掉、改自己掛 ticker 手動
      // update()，是為了跟這裡其他所有東西（trackHomeRect、extraHidden.reapply）用
      // 同一個時鐘來源（localApp.ticker），不要依賴 pixi-spine 預設用的
      // PIXI.Ticker.shared——那是另一個獨立的全域計時器，混用兩套時鐘來源不好推理，
      // 也不好在元件卸載時保證真的停乾淨。
      if (config.kind === 'spine') {
        const spine = localModel
        // 部分 Spine 資產是共用骨架模板、靠切換 skin 變成不同角色（見 SpineModelConfig.
        // skinName 的說明），要在播動畫之前先套用，不然會顯示 Spine 資料裡的預設 skin
        // （不一定是這個角色的外觀）。找不到指定的 skin 名稱就記警告、退回預設 skin，
        // 不讓角色整個載入失敗。
        if (config.skinName) {
          try {
            spine.skeleton.setSkinByName(config.skinName)
            spine.skeleton.setSlotsToSetupPose()
          } catch (err) {
            console.warn(`[HeroLive2DStage] "${config.id}" 套用 skin "${config.skinName}" 失敗，退回預設 skin：`, err)
          }
        }
        if (spine.state.hasAnimation(config.idleAnimation)) {
          spine.state.setAnimation(0, config.idleAnimation, true)
        }
        // 下面 measureTightBounds() 要量測的 model.getBounds() 讀的是「目前已經算好」
        // 的 mesh 頂點，只有呼叫過 spine.update() 之後才有效——不呼叫的話骨架還停在
        // 完全沒 update 過的初始狀態，量出來的框會退化成 0 大小（曾經因此讓角色一開始
        // 不是目前顯示中卡片時，切過去整個消失／被縮放成離譜倍數，見下面 updateSpine
        // 的效能優化說明：一旦這裡不先強制 update 一次，隱藏中的角色永遠不會被
        // updateSpine 的 ticker callback 更新到，量測當下骨架就是壞的，之後也救不回來，
        // 因為 tightBounds 只在載入時算一次、之後重複使用）。這裡手動強制 update 一次
        // （dt=0，只是為了讓骨架擺出 idle 動畫第一幀姿勢，不是真的要推進時間），繞過
        // visible 檢查，只影響載入當下這一次，不影響「隱藏時不持續消耗運算」的優化本身。
        spine.update(0)
        // **效能：隱藏中的 Spine 角色不更新**。實測過（devtools 讀 spine.state.tracks[0].
        // trackTime）：這個 ticker callback 原本不管 spine.visible 一律呼叫 spine.update()，
        // 即使角色沒有顯示在畫面上，骨架姿勢還是每一幀都在算——1 秒真實時間 trackTime 就
        // 前進了 1 秒，等於白算。改成隱藏時直接跳過，動畫時間軸會凍結在切走那一刻，
        // 下次切回來才繼續往前算，不會有「補跑」或跳幀的問題（Spine 的 update(dt) 只吃
        // 這一幀的 deltaTime，不是累積時間，凍結期間完全不呼叫就不會累積）。Live2D 那邊
        // 查過 pixi-live2d-display 自己的 Live2DModel.update() 已經會在 visible=false 時
        // 提早跳過真正吃資源的 internalModel.update()，不需要在這裡另外處理。
        const updateSpine = () => {
          if (destroyed || !spine.visible) return
          spine.update(localApp.ticker.deltaMS / 1000)
        }
        localApp.ticker.add(updateSpine)
        perModelTickers.push(updateSpine)
      }

      // 模型剛掛上 stage 時還沒跑過任何一次待機動作/物理更新的 tick，量出來的
      // bounding box 是未變形的原始姿勢，直接拿去量測會讓角色整個縮得只剩一小點。
      // 等兩個 animation frame 讓 PIXI ticker 至少跑過一次 update 再量測。
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })
      if (destroyed) return

      const tightBounds = measureTightBounds(localModel, () => false)
      if (destroyed) return
      slot.tightBounds = tightBounds
      slot.status = 'ready'

      // 尊重 prefers-reduced-motion：不強制整個模型靜止（那樣角色會消失、比動態圖更奇怪），
      // 只關掉會不斷自動觸發新動作的待機動作循環，讓角色停在目前姿勢。
      if (reduceMotion) {
        if (config.kind === 'live2d') {
          const mm = localModel.internalModel?.motionManager
          if (mm) {
            mm.stopAllMotions()
            mm.startRandomMotion = () => Promise.resolve(false)
          }
        } else {
          // Spine 沒有「待機動作循環」的概念，timeScale=0 讓 update() 照跑（畫面不會
          // 整個消失）但動畫時間軸不再前進，效果跟 Live2D 那邊「停在目前姿勢」一致。
          localModel.state.timeScale = 0
        }
      }

      if (MODELS[indexRef.current].id === config.id) {
        applyFitAt(localModel, tightBounds, homeRectRef.current, slot.layout)
        localModel.visible = true
        setCurrentModelState('ready')
        onActiveModelChangeRef.current?.(makeHandle(config.id))
      }
    }

    // **按需載入，取代原本「掛載時把 7 個角色全部丟進 loadModel()」的做法**：實測過
    // （devtools + CDP）7 個角色全部搶頻寬同時下載，會讓「目前顯示中」那張卡片的載入
    // 時間被其他 6 個角色的資源（貼圖佔大宗，加起來將近 20MB）拖慢，即使程式邏輯上沒有
    // 真的「等全部載完」的依賴——只是頻寬被瓜分。改成只主動載入「目前卡片＋左右鄰居」
    // （使用者最容易按到的方向），其餘角色留到切卡片、變成鄰居時才觸發載入。
    function ensureLoaded(id: string) {
      if (requestedIdsRef.current.has(id)) return
      requestedIdsRef.current.add(id)
      const config = MODELS.find((m) => m.id === id)
      if (!config) return
      loadModel(config).catch((err) => console.error('[HeroLive2DStage] 初始化失敗：', config.id, err))
    }
    function ensureNeighborsLoaded(centerIndex: number) {
      const len = MODELS.length
      ensureLoaded(MODELS[centerIndex].id)
      ensureLoaded(MODELS[(centerIndex - 1 + len) % len].id)
      ensureLoaded(MODELS[(centerIndex + 1) % len].id)
    }
    ensureNeighborsLoadedRef.current = ensureNeighborsLoaded
    ensureNeighborsLoaded(0)

    // **flyIn(targetEl)**：見上面 HeroLive2DStageHandle 的說明。定義在這裡（不是元件
    // 外層）是因為需要存取這個 effect 專屬的 localApp／slotsRef／canvasHost 等變數，
    // 透過 flyInImplRef 轉手給 useImperativeHandle。
    //
    // **2026-08-12 支援飛到 Hero 區塊以外的目的地**：觸發按鈕搬到頁面下方「閒置動作＋
    // 語音閒聊」Spotlight 卡片裡，角色要真的從 Hero 一路飛到那塊面板——共用畫布
    // （canvasHost）平常是 position:absolute inset:0，只填滿 Hero 自己的
    // <section>，被 Hero 的 overflow-hidden 裁掉，飛不出 Hero。這裡改成飛行期間
    // 直接把 canvasHost 的 inline style 暫時蓋成 position:fixed inset:0（蓋滿整個
    // viewport、疊在其他區塊上面），飛完再清掉 inline style、讓 Hero.tsx 原本的
    // className（absolute inset:0）接手——只改 canvasHost 這個 DOM 節點的 CSS
    // 定位，<canvas> 本身沒有被搬動／重新 appendChild，不會有 GL context 遺失的風險。
    // 刻意不用「另開一個 PIXI.Application 塞進 Spotlight 面板」這條路：這個共用畫布
    // 架構換成單一畫布，就是因為實測過兩個以上 WebGL context 同時存在時
    // pixi-live2d-display 內部共用的 GL 資源會跨 context 誤用、背景模型畫不出東西
    // （見檔案開頭 ActiveModelHandle 的說明），這裡不能重蹈覆轍。
    const FLY_IN_HOLD_MS = 15000
    const FLY_IN_STACK_OFFSETS = [
      { x: -0.16, y: -0.06, rotateDeg: -8 },
      { x: 0.16, y: 0.04, rotateDeg: 7 },
      { x: 0, y: 0.16, rotateDeg: -3 },
    ]
    type FlyTarget = { slot: ModelSlot; targetScale: number; targetX: number; targetY: number; rotateDeg: number }

    // 飛行結束（或壓根沒觸發過）時角色應該長什麼樣：跟切卡片 effect 的
    // applyCurrentModel() 是同一套邏輯（目前卡片對應的模型置中顯示、其餘隱藏），這裡
    // 抽出來共用，因為 flyIn 收尾也需要「還原成正常輪播狀態」這個動作。
    function syncToCurrentModel() {
      const currentId = MODELS[indexRef.current].id
      for (const [id, slot] of Object.entries(slotsRef.current)) {
        if (!slot.model || slot.escaped) continue
        if (id === currentId && slot.tightBounds) {
          applyFitAt(slot.model, slot.tightBounds, homeRectRef.current, slot.layout)
          slot.model.visible = true
        } else {
          slot.model.visible = false
        }
      }
      const currentSlot = slotsRef.current[currentId]
      onActiveModelChangeRef.current?.(currentSlot?.model ? makeHandle(currentId) : null)
    }

    // 把頁面上任一個 DOM 節點目前的畫面位置換算成 canvasHost 本地座標（跟
    // homeRectRef 同一種慣例）。canvasHost 現在是不是 fixed 全螢幕、頁面有沒有捲動，
    // 這裡都不用管——getBoundingClientRect() 永遠回傳目前視窗座標，兩個都減掉
    // canvasHost 目前的視窗座標，相減後自然是正確的本地座標。
    function rectOf(el: HTMLElement): Box {
      const r = el.getBoundingClientRect()
      const hostRect = canvasHost!.getBoundingClientRect()
      return { x: r.left - hostRect.left, y: r.top - hostRect.top, width: r.width, height: r.height }
    }

    function playFlyExit(token: number, targets: FlyTarget[], lastRect: Box) {
      let pending = targets.length
      for (let order = 0; order < targets.length; order++) {
        const t = targets[order]
        const fromX = t.slot.model.position.x
        const fromY = t.slot.model.position.y
        const fromScale = t.slot.model.scale.x
        animate(0, 1, {
          duration: 0.35,
          ease: 'easeIn',
          delay: order * 0.1,
          onUpdate: (p) => {
            if (flyInTokenRef.current !== token) return
            t.slot.model.position.set(fromX, fromY - lastRect.height * 0.35 * p)
            t.slot.model.scale.set(Math.max(fromScale * (1 - p), 0.001))
          },
          onComplete: () => {
            if (flyInTokenRef.current !== token) return
            t.slot.model.visible = false
            pending -= 1
            if (pending === 0) {
              // canvasHost 的 fixed 覆寫還原成 Hero.tsx 原本的 className（absolute
              // inset:0），才不會永遠蓋在其他區塊上面擋住點擊/內容。
              canvasHost!.style.position = ''
              canvasHost!.style.inset = ''
              canvasHost!.style.zIndex = ''
              syncToCurrentModel()
              flyingRef.current = false
              onFlyInStateChangeRef.current?.(false)
            }
          },
        })
      }
    }

    function flyInImpl(targetEl?: HTMLElement | null) {
      if (flyingRef.current || !canvasHost) return
      const entries = MODELS
        .map((m) => slotsRef.current[m.id])
        .filter((slot): slot is ModelSlot => !!(slot?.model && slot.tightBounds && slot.status === 'ready' && !slot.escaped))
      // 少於兩隻能動的角色（還在載入中，或已經被拖出去）時，「飛在一起」沒有意義，不觸發。
      if (entries.length < 2) return
      flyingRef.current = true
      onFlyInStateChangeRef.current?.(true)
      // 飛行期間先把 handle 收回，避免 GestureDragControl 跟這裡的補間同時搶
      // model.position 的控制權。
      onActiveModelChangeRef.current?.(null)

      // 有目的地：canvasHost 先蓋成 fixed 滿版、疊在其他區塊上面，角色才飛得出 Hero
      // 的 overflow-hidden。沒有目的地（防禦性 fallback，正常不會發生）就維持原本
      // 「飛在 Hero 卡片自己裡面」的行為，不動 canvasHost。
      if (targetEl) {
        canvasHost.style.position = 'fixed'
        canvasHost.style.inset = '0'
        canvasHost.style.zIndex = '50'
      }

      // startRect：角色從 Hero 卡片本身「飛出來」的起點，用 chromeRef（量測卡片外框
      // 的錨點）現在的畫面位置——這裡量測時 canvasHost 的 fixed／z-index 都已經套用，
      // 量出來的本地座標才是正確的。
      const chrome = chromeRef.current
      const startRect = chrome ? rectOf(chrome) : homeRectRef.current
      const endRect = targetEl ? rectOf(targetEl) : startRect

      const targets: FlyTarget[] = entries.map((slot, order) => {
        const offset = FLY_IN_STACK_OFFSETS[order % FLY_IN_STACK_OFFSETS.length]
        const box = slot.tightBounds as Box
        const targetScale = Math.min((endRect.width * 0.55) / box.width, (endRect.height * 0.55) / box.height)
        const cx = endRect.x + endRect.width / 2 + offset.x * endRect.width
        const cy = endRect.y + endRect.height / 2 + offset.y * endRect.height
        return {
          slot,
          targetScale,
          targetX: cx - (box.x + box.width / 2) * targetScale,
          targetY: cy - (box.y + box.height / 2) * targetScale,
          rotateDeg: offset.rotateDeg,
        }
      })

      for (const t of targets) t.slot.model.visible = true

      const token = ++flyInTokenRef.current

      // 停留階段：目的地是頁面上真正的 DOM 節點（不是像 Hero 卡片那樣每幀自動跟著
      // 浮動的座標），這裡持續每幀重新量測 targetEl 的畫面位置並跟著重新定位——
      // 使用者在停留的 15 秒內捲動頁面，角色才會繼續黏在目的地面板上，不會捲一下就
      // 飄走。沒有 targetEl 時不需要追蹤（起點終點是同一個 Hero 卡片，已經有
      // trackHomeRect 在管）。追蹤 callback 掛進 perModelTickers，元件卸載時會被
      // 統一清掉，不用另外處理。
      let trackHoldPosition: (() => void) | null = null
      function beginHoldPhase() {
        if (targetEl) {
          trackHoldPosition = () => {
            const rect = rectOf(targetEl)
            for (let order = 0; order < targets.length; order++) {
              const t = targets[order]
              const offset = FLY_IN_STACK_OFFSETS[order % FLY_IN_STACK_OFFSETS.length]
              const box = t.slot.tightBounds as Box
              const cx = rect.x + rect.width / 2 + offset.x * rect.width
              const cy = rect.y + rect.height / 2 + offset.y * rect.height
              t.slot.model.position.set(cx - (box.x + box.width / 2) * t.targetScale, cy - (box.y + box.height / 2) * t.targetScale)
            }
          }
          localApp.ticker.add(trackHoldPosition, null, PIXI.UPDATE_PRIORITY.LOW)
          perModelTickers.push(trackHoldPosition)
        }
        flyInHoldTimeoutId = window.setTimeout(() => {
          if (flyInTokenRef.current !== token) return
          if (trackHoldPosition) {
            localApp.ticker.remove(trackHoldPosition)
            trackHoldPosition = null
          }
          playFlyExit(token, targets, targetEl ? rectOf(targetEl) : endRect)
        }, FLY_IN_HOLD_MS)
      }

      if (reduceMotion) {
        // 尊重 prefers-reduced-motion：直接擺到定位、不跑補間，但角色本身還是真的一起
        // 顯示出來（不是整個功能被關掉）。
        for (const t of targets) {
          t.slot.model.scale.set(t.targetScale)
          t.slot.model.position.set(t.targetX, t.targetY)
        }
        beginHoldPhase()
        return
      }

      let pendingEnter = targets.length
      targets.forEach((t, order) => {
        const offset = FLY_IN_STACK_OFFSETS[order % FLY_IN_STACK_OFFSETS.length]
        const box = t.slot.tightBounds as Box
        // 有目的地時，起點是「以同一組堆疊排列套在 Hero 卡片（startRect）上」算出來
        // 的位置——三隻角色會以跟終點一樣的疊放隊形從 Hero 卡片飛出來，不是三隻都從
        // 同一個點炸開，飛行距離＝startRect 到 endRect 的實際畫面距離，兩個區塊隔得
        // 越遠，這段飛行就越長。沒有目的地（fallback）維持舊行為：從卡片正上方飛入。
        const startX = targetEl
          ? startRect.x + startRect.width / 2 + offset.x * startRect.width - (box.x + box.width / 2) * t.targetScale
          : t.targetX
        const startY = targetEl
          ? startRect.y + startRect.height / 2 + offset.y * startRect.height - (box.y + box.height / 2) * t.targetScale
          : t.targetY - endRect.height * 1.3
        t.slot.model.position.set(startX, startY)
        t.slot.model.scale.set(t.targetScale * 0.4)
        t.slot.model.rotation = 0
        animate(0, 1, {
          type: 'spring',
          stiffness: 90,
          damping: 16,
          delay: order * 0.18,
          onUpdate: (p) => {
            if (flyInTokenRef.current !== token) return
            t.slot.model.position.set(startX + (t.targetX - startX) * p, startY + (t.targetY - startY) * p)
            t.slot.model.scale.set(t.targetScale * (0.4 + 0.6 * Math.min(Math.max(p, 0), 1)))
            t.slot.model.rotation = ((t.rotateDeg * Math.PI) / 180) * Math.min(Math.max(p, 0), 1)
          },
          onComplete: () => {
            if (flyInTokenRef.current !== token) return
            pendingEnter -= 1
            if (pendingEnter === 0) beginHoldPhase()
          },
        })
      })
    }
    flyInImplRef.current = flyInImpl

    const resizeObserver = new ResizeObserver(() => {
      if (destroyed || localApp.renderer?.destroyed) return
      const w = canvasHost!.clientWidth
      const h = canvasHost!.clientHeight
      if (w < 1 || h < 1) return
      localApp.renderer.resize(w, h)
      // 已經逃出去的模型：resize 不主動幫它們重新置中（跟舊版「拖曳位置不因 resize
      // 保留」是同一個刻意的取捨），但至少 clamp 回新的畫布範圍，避免縮小視窗後
      // 完全跑到看不見的地方。
      const canvasSize = { width: w, height: h }
      for (const id of escapedIdsRef.current) {
        const slot = slotsRef.current[id]
        if (!slot.model || !slot.tightBounds) continue
        const scale = slot.model.scale.x
        const box = { x: slot.tightBounds.x * scale, y: slot.tightBounds.y * scale, width: slot.tightBounds.width * scale, height: slot.tightBounds.height * scale }
        const clampedX = Math.min(Math.max(slot.model.position.x, -slot.tightBounds.x * scale), canvasSize.width - box.width - slot.tightBounds.x * scale)
        const clampedY = Math.min(Math.max(slot.model.position.y, -slot.tightBounds.y * scale), canvasSize.height - box.height - slot.tightBounds.y * scale)
        slot.model.position.set(clampedX, clampedY)
      }
    })
    resizeObserver.observe(canvasHost)

    return () => {
      destroyed = true
      resizeObserver.disconnect()
      localApp.ticker.remove(trackHomeRect)
      for (const fn of perModelTickers) localApp.ticker.remove(fn)
      onActiveModelChangeRef.current?.(null)
      // flyIn() 停留階段的 timer、跟正在跑的補間（靠遞增 token 讓過期的 onUpdate/
      // onComplete 變成 no-op，見 flyInImpl）——不清掉的話，元件卸載後 timer 觸發時
      // 還會摸已經 destroy 掉的 model，或呼叫已經沒用的 setState。
      flyInTokenRef.current++
      if (flyInHoldTimeoutId !== undefined) window.clearTimeout(flyInHoldTimeoutId)
      flyingRef.current = false
      // 萬一卸載時剛好飛到一半、canvasHost 還蓋著 fixed 全螢幕的 inline style，要還原
      // 掉，不然（理論上不太可能，但防禦性處理）殘留的 inline style 會一直蓋住其他
      // 區塊。canvasHost 這時候可能已經跟著 Hero.tsx 一起被拆掉，對已離開文件的節點
      // 設 style 是安全的 no-op。
      canvasHost.style.position = ''
      canvasHost.style.inset = ''
      canvasHost.style.zIndex = ''
      // slotsRef 存的是普通資料物件（不是 DOM 節點的 ref），不會被 React 換掉，
      // lint 這條「cleanup 裡讀 .current 可能已經變了」的提醒對 DOM ref 才成立，
      // 這裡讀取安全。
      for (const config of MODELS) {
        const slot = slotsRef.current[config.id]
        if (slot.model) {
          try {
            slot.model.destroy({ children: true })
          } catch (err) {
            console.error('[HeroLive2DStage] model.destroy 失敗（已忽略）：', err)
          }
        }
      }
      try {
        localApp.destroy(true)
      } catch (err) {
        console.error('[HeroLive2DStage] app.destroy 失敗（已忽略）：', err)
      }
      appRef.current = null
      delete (window as any).__live2dSlots
      delete (window as any).printLive2DLayout
    }
    // 刻意只依賴 canvasHost：這個元件整個生命週期只建立一次 PIXI Application，
    // reduceMotion／onActiveModelChange 用上面另外的 ref 保持最新值，不需要讓這個
    // effect 重跑（重跑代表重建整個 PIXI Application，違背這次改版的目的）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasHost])

  // 切換卡片：把「不是目前 index、也還沒逃出」的模型隱藏，目前這張卡片對應的模型
  // （若已經載入完成且還沒逃出）置中對齊到卡片外框、設成可見，並把 handle 換給
  // GestureDragControl。已經逃出去的模型完全不受這裡影響——這就是「拖出去的角色
  // 就算翻頁也不用歸位」的完整實作，不需要額外的搬家/收回邏輯。
  //
  // **2026-08-10 切卡片轉場，第二版：畫布本身做真的 3D 翻牌，轉場期間硬裁切在卡片範圍內**。
  // 第一版試過對 model.alpha 做補間（DOM 翻牌動畫原本的時長/緩動照搬過去），實測
  // pixi-live2d-display 這個版本的 Live2DModel._render() 不吃 PIXI 標準的 alpha／mask
  // （兩者都試過：alpha 補間數值本身完全正確、逐幀平滑，畫面卻是「切一半就整個消失／
  // 出現」，不是漸層；拿 tightBounds 畫矩形設成 model.mask 也一樣沒有效果，用
  // gl.readPixels 直接讀 WebGL framebuffer 驗證過，數值都對，只是沒有真的畫出來）——
  // 只有 model.visible 這個布林值可靠，問題在 vendor 函式庫這層，不是呼叫方式錯誤。
  // 第一版改用蓋在卡片上的 DOM 遮蓋層做淡出淡入，能用但看不出「翻牌」的視覺語言，跟
  // 下面 flipVariants／perspective 那組 DOM 動畫語言對不上。
  // 這一版直接對「共用畫布本身」（localApp.view，一個普通的 <canvas> DOM 節點）做
  // CSS 3D rotateY，跟 flipVariants 用同一組角度慣例（enter 90/-90 → center 0 →
  // exit -90/90），才會是真的看得到翻轉、不是只有底下那顆透明按鈕在轉。旋轉支點
  // （transformOrigin）動態設在卡片中心（homeRectRef），不是畫布正中心——畫布涵蓋
  // 整個 Hero 區塊（含左側文字欄），繞畫布中心轉的話卡片內容會被甩出一個很大的弧線。
  // 轉場期間額外對畫布套一個限制在卡片範圍內的 clip-path（結束後移除）：3D 旋轉會有
  // 透視形變，沒有這道硬裁切，轉場當下有機會看到角色短暫超出卡片邊界。clip-path 是瀏覽器原生的
  // 合成裁切，不經過 Live2DModel 的 render()，不受同一個限制影響。
  // 代價：clip-path／rotateY 是套在整個共用畫布上，若這個瞬間剛好有「逃出卡片」的角色
  // 飄在畫面其他地方，會跟著被裁到／輕微形變 0.2~0.45 秒——只在「同時符合：有角色已
  // 逃出 ＋ 使用者這時候切卡片」才會發生，範圍夠窄，換來翻牌效果看得見、角色不會在
  // 轉場中跑出卡片，這次判斷划算。
  useEffect(() => {
    // 切卡片時順便觸發「目前卡片＋左右鄰居」的按需載入（見掛載 effect 的
    // ensureNeighborsLoaded 說明）——已經載入過或正在載入的角色會被 requestedIdsRef
    // 擋掉，不會重複觸發；還沒載過的鄰居會在這裡第一次被排進載入佇列。
    ensureNeighborsLoadedRef.current(index)

    const token = ++transitionTokenRef.current
    const prevId = prevCurrentIdRef.current
    prevCurrentIdRef.current = current.id

    const canvasView = appRef.current?.view as HTMLCanvasElement | undefined

    function applyCurrentModel() {
      for (const [id, slot] of Object.entries(slotsRef.current)) {
        if (id !== current.id && slot.model && !slot.escaped) {
          slot.model.visible = false
        }
      }
      const slot = slotsRef.current[current.id]
      setCurrentModelState(slot.status)
      if (slot.model && slot.tightBounds && !slot.escaped) {
        applyFitAt(slot.model, slot.tightBounds, homeRectRef.current, slot.layout)
        slot.model.visible = true
        onActiveModelChangeRef.current?.(makeHandle(current.id))
      } else {
        // 還在載入中，或這個模型已經逃出去了：都沒有「卡片內可互動的模型」可以提供，
        // 手勢拖曳模組會收到 null、跟著清空選定狀態（見 GestureDragControl 對 handle
        // 變成 null 的處理）。
        onActiveModelChangeRef.current?.(null)
      }
    }

    function clearTransitionStyles() {
      if (!canvasView) return
      canvasView.style.transform = ''
      canvasView.style.transformOrigin = ''
      canvasView.style.clipPath = ''
    }

    // prevId 對應的模型還沒切換前是可見的，翻到「邊緣朝向使用者」（rotateY ±90）那一刻
    // 才是安全的切換時機；沒有「上一張」（首次掛載）、畫布還沒掛上 DOM、或使用者要求
    // 減少動態效果，就直接切，不跑動畫。
    if (!canvasView || !prevId || prevId === current.id || reduceMotion) {
      clearTransitionStyles()
      applyCurrentModel()
      return
    }

    const rect = homeRectRef.current
    const canvasSize = { width: appRef.current?.screen.width ?? 0, height: appRef.current?.screen.height ?? 0 }
    canvasView.style.transformOrigin = `${rect.x + rect.width / 2}px ${rect.y + rect.height / 2}px`
    canvasView.style.clipPath = `inset(${rect.y}px ${canvasSize.width - rect.x - rect.width}px ${canvasSize.height - rect.y - rect.height}px ${rect.x}px)`
    canvasView.style.backfaceVisibility = 'hidden'

    const duration = 0.45
    const halfDuration = duration / 2
    // 跟 flipVariants 同一套角度慣例：direction>0（往下一張）舊卡片轉去 -90，
    // 新卡片從 +90 轉回 0；反方向對調。
    const exitDeg = direction > 0 ? -90 : 90
    const enterStartDeg = direction > 0 ? 90 : -90

    canvasView.style.transform = 'perspective(1400px) rotateY(0deg)'
    animate(0, exitDeg, {
      duration: halfDuration,
      ease: 'easeInOut',
      onUpdate: (v) => {
        if (transitionTokenRef.current === token) {
          canvasView.style.transform = `perspective(1400px) rotateY(${v}deg)`
        }
      },
      onComplete: () => {
        if (transitionTokenRef.current !== token) return
        applyCurrentModel()
        animate(enterStartDeg, 0, {
          duration: halfDuration,
          ease: 'easeInOut',
          onUpdate: (v) => {
            if (transitionTokenRef.current === token) {
              canvasView.style.transform = `perspective(1400px) rotateY(${v}deg)`
            }
          },
          onComplete: () => {
            if (transitionTokenRef.current === token) clearTransitionStyles()
          },
        })
      },
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index])

  // 飛行動畫進行中不切卡片：三隻角色的可見度/位置這時候是 flyIn() 在管，切卡片會觸發
  // 下面「切換卡片」那個 effect 的 applyCurrentModel()，把其中一隻拉回卡片正中央、
  // 打斷飛行動畫。
  function goTo(next: number) {
    if (flyingRef.current || next === index) return
    setDirection(next > index ? 1 : -1)
    setIndex(next)
  }

  function goPrev() {
    if (flyingRef.current) return
    setDirection(-1)
    setIndex((i) => (i - 1 + MODELS.length) % MODELS.length)
  }

  function goNext() {
    if (flyingRef.current) return
    setDirection(1)
    setIndex((i) => (i + 1) % MODELS.length)
  }

  // 方向鍵切換卡片；Tab 移到箭頭／圓點按鈕後 Enter／Space 一樣能切（原生 <button> 內建行為），
  // 不用額外處理。
  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      goPrev()
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      goNext()
    }
  }

  return (
    <div
      className={cn('relative isolate overflow-hidden', className)}
      style={reduceMotion ? undefined : { perspective: 1400 }}
      onKeyDown={handleKeyDown}
      aria-roledescription="carousel"
      aria-label="桌寵角色卡片，共四張，可切換"
    >
      <p aria-live="polite" className="sr-only">
        目前顯示角色：{currentLabel}
      </p>

      {/* 量測用錨點，見上面 chromeRef 的說明；不畫任何東西、不套任何 transform。 */}
      <div ref={chromeRef} className="absolute inset-0" aria-hidden="true" />

      <AnimatePresence mode="wait" custom={direction} initial={false}>
        <motion.div
          key={current.id}
          custom={direction}
          variants={reduceMotion ? fadeVariants : flipVariants}
          initial="enter"
          animate="center"
          exit="exit"
          transition={{ duration: reduceMotion ? 0.2 : 0.45, ease: 'easeInOut' }}
          style={reduceMotion ? undefined : { transformStyle: 'preserve-3d', backfaceVisibility: 'hidden' }}
          className="absolute inset-0"
        >
          {/* 真正的模型畫在共用畫布上（不是這裡），這個 <button> 只負責點擊觸發技能
              動作＋鍵盤/螢幕報讀器可及性，位置對齊卡片外框整個範圍（模型視覺上就
              填滿這個範圍）。用真正的 <button> 而不是 role="button" 的 div，原生就有
              Tab/Enter/Space 行為，不用像舊版一樣自己接 onKeyDown。 */}
          {currentModelState === 'ready' && (
            <button
              type="button"
              onClick={() => playRandomSkillFor(current.id)}
              aria-label={`按一下讓桌寵角色（${currentLabel}）使出技能動作`}
              className={cn(
                'absolute inset-0 h-full w-full cursor-pointer bg-transparent',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-2',
              )}
            />
          )}
          {currentModelState === 'loading' && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-violet-500/70 dark:text-violet-400/60">
              載入角色中…
            </div>
          )}
          {currentModelState === 'error' && (
            <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-stone-500 dark:text-stone-400">
              角色載入失敗，請確認角色資源檔案存在
            </div>
          )}
        </motion.div>
      </AnimatePresence>

      <button
        type="button"
        onClick={goPrev}
        aria-label="上一個角色"
        className={cn(
          'absolute top-1/2 left-2 z-10 -translate-y-1/2 rounded-full p-2 text-stone-700 opacity-70',
          'bg-white/70 transition-opacity hover:opacity-100 hover:bg-white',
          'focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500',
          'dark:bg-stone-900/70 dark:text-stone-200 dark:hover:bg-stone-900',
        )}
      >
        <ChevronLeft className="size-5" aria-hidden="true" />
      </button>

      <button
        type="button"
        onClick={goNext}
        aria-label="下一個角色"
        className={cn(
          'absolute top-1/2 right-2 z-10 -translate-y-1/2 rounded-full p-2 text-stone-700 opacity-70',
          'bg-white/70 transition-opacity hover:opacity-100 hover:bg-white',
          'focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500',
          'dark:bg-stone-900/70 dark:text-stone-200 dark:hover:bg-stone-900',
        )}
      >
        <ChevronRight className="size-5" aria-hidden="true" />
      </button>

      <div className="absolute inset-x-0 bottom-3 z-10 flex justify-center gap-2" role="group" aria-label="角色選擇">
        {MODELS.map((m, i) => {
          const label = nameOverrides[modelPathKey(m)] ?? m.label
          return (
          <button
            key={m.id}
            type="button"
            onClick={() => goTo(i)}
            aria-current={i === index ? 'true' : undefined}
            aria-label={i === index ? `${label}（目前顯示）` : `切換到${label}`}
            className={cn(
              'size-2.5 rounded-full transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 focus-visible:ring-offset-1',
              i === index
                ? 'bg-violet-600 dark:bg-violet-400'
                : 'bg-white/60 hover:bg-white/90 dark:bg-stone-500/60 dark:hover:bg-stone-400/80',
            )}
          />
          )
        })}
      </div>
    </div>
  )
})
