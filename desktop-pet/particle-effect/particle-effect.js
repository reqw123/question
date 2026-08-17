// 桌寵模式的「光粒子裝飾」入口模組——獨立於 Live2D 角色之外的一塊常駐、可切換
// 開關的浮動裝飾，玩法跟 C:\morph-particles 同一套（GLB 表面取樣 → FBO
// GPGPU → 粒子聚合/消散），核心是單一模型「聚合 ⇄ 消散」。
//
// morph-particles 那個網站是用滑鼠捲動在 5 個模型（A→B→C→D→E）之間漸變，這裡
// 不做滑鼠捲動控制，改成「模型序列播放」：一鍵觸發、在 sources.js 的
// sequenceModels 清單（或全部模型）之間無限循環連續變形，直到手動停止，見
// window.setParticleSequencePlayback()／loadSequenceStages()／
// advanceSequencePlayback()。實作上重用跟 particle.animatedIdle 同一套
// uTextureModelA/B/uAnimBlend 兩張貼圖內插機制，只是內插的兩端從「同模型的不同
// 姿勢」換成「不同模型各自取樣出來的靜態形狀」。序列裡的模型是懶載入——真的
// 第一次觸發才會去讀 sequenceModels 清單、逐一取樣（見 startSequencePreload()），
// 不是 App 一開機就無條件背景讀，避免這個功能沒用到也白白佔資源；讀取期間會先
// 顯示一段「loading...」文字形狀的粒子佔位樣式頂著（見
// buildSequenceLoadingTexture()），背景讀完會自動接手開始真的播放。
//
// 開關由 main.js 的系統匣選單「光粒子特效」控制，走跟 setExtraPetWander 一樣的
// 模式：main.js 用 executeJavaScript 呼叫這裡掛在 window 上的 setParticleEffect()。
// 選單裡列出的模型清單來自 sources.js，main.js 動態 import() 讀取，選了哪個就呼叫
// 這裡的 window.setParticleActiveModel(key) 即時換模型（不用整頁 reload，見
// swapActiveModel()）。
//
// 3D 視角控制（拖曳旋轉／滾輪縮放／右鍵拖曳平移）直接沿用 OrbitControls，*不*
// 另外做開關，理由跟 index.html 既有的「點角色開聊天框」overlay 是同一套邏輯
// （見 index.html 裡「共用 canvas 預設 pointer-events:none」那段註解）：
//   1. 這個 canvas 全程 pointer-events:auto，但桌寵視窗預設是「穿透模式」
//      （main.js 的 clickThrough），穿透模式下整個視窗連滑鼠點擊都收不到，
//      pointer-events 設什麼都沒差——真正生效只會發生在使用者按 F9／系統匣
//      切到「互動模式」之後，等於白送一個「僅互動模式下可用」的閘門。
//   2. z-index 夾在 Live2D 角色 canvas 平常的 5 跟拖曳中的 9999、以及聊天
//      overlay/角色選擇按鈕的 50/10000+ 之間：角色平常不拖曳時 canvas 本身
//      也是 pointer-events:none，不會被我們擋到；使用者真的在拖角色時
//      canvas 會跳到 9999 蓋過我們，滑鼠自然優先給拖曳，不用寫互斥判斷。
//
// 「移到模型上游標變抓取」需要知道互動/穿透狀態——因為 win.setIgnoreMouseEvents
// 的 forward:true 選項，mousemove 在穿透模式下也會送到這裡（是既有 F9 機制本來
// 就有的行為，不是這裡加的），但穿透模式下實際上完全點不到、拖不動任何東西，
// 游標卻顯示可抓取會誤導使用者。這裡沒辦法只靠「有沒有收到 mousemove」自己判斷
// 是不是穿透模式，所以由 main.js 的 setClickThrough() 主動呼叫
// window.setParticleEffectInteractiveMode() 告知。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import FBO from './fbo.js';
import {
  sampleModelToParticles,
  sampleModelAnimationFrames,
  sampleAverageMaterialColor,
  positionsToDataTexture,
  createRandomDataTexture,
} from './particle-sampler.js';
import {
  simulationVertexShader,
  simulationFragmentShader,
  particlesVertexShader,
  particlesFragmentShader,
} from './shaders.js';
import sources, {
  sequenceModels as configuredSequenceModels,
  sequenceHoldSeconds as configuredSequenceHoldSeconds,
  sequenceTransitionSeconds as configuredSequenceTransitionSeconds,
  sequenceBgm as configuredSequenceBgm,
} from './sources.js';

// ── 可調參數 ────────────────────────────────────────────────────────────
// 候選模型清單（檔名 + 取樣校正 scale/position/rotation + 顏色）都集中在
// sources.js，格式仿照 morph-particles 自己的 sources.js。這裡只決定「一開始」
// 用哪一個，之後想換模型不用改這個常數——直接用系統匣「光粒子特效」子選單挑，
// 或呼叫 window.setParticleActiveModel(key)。
const DEFAULT_MODEL = 'virgoModel';

// 跟 morph-particles 的 Page.js 同一個 FBO 解析度（256*256 = 65536 顆粒子）——
// 「原版大小」不只是畫面範圍，粒子密度也要跟上，不然聚合出來的形狀會太稀疏。
const FBO_SIZE = 256;
const SCATTER_SPREAD = 6; // 散開狀態的粒子分佈範圍（跟模型座標系同單位）
const DEFAULT_COLOR = [0.55, 0.8, 1.0]; // sources.js 該項目沒填 color 時的預設淡藍色
const TRANSITION_MS = 1800; // 聚合／消散動畫時長
// 完全聚合後的閒置動畫，種類由 sources.js 每個模型自己的 idleMotion 決定（見
// normalizeIdleMotion()），不再是全模型共用同一種 360 度自轉。這裡的四個常數只是
// 「sources.js 沒填 amplitude/speed 時」的預設值，跟 spin 類型原本唯一支援的
// IDLE_ROTATE_SPEED 是同一組角色。
const IDLE_ROTATE_SPEED = 0.15; // spin 類型（原本唯一的行為：繞 Y 軸連續 360 度自轉）預設角速度（rad/s）
const IDLE_BOB_AMPLITUDE = 0.18; // bob 類型（上下短距離來回，像 C:\morph-particles 設想的「模型1」）預設振幅（跟模型座標系同單位）
const IDLE_BOB_SPEED = 1.4; // bob 類型預設角頻率（數字越大來回越快）
const IDLE_SWING_AMPLITUDE = Math.PI / 9; // swing 類型（水平短距離轉動，像「模型2」左右擺頭）預設擺角（rad，約 20 度）
const IDLE_SWING_SPEED = 0.9; // swing 類型預設角頻率
const HOVER_THRESHOLD = 0.12; // Raycaster 命中粒子點雲的容許誤差（跟粒子分佈同單位）
const HOVER_STALE_MS = 400; // 超過這麼久沒收到 mousemove 才當作滑鼠真的離開了（見下方大註解）

// 「動畫粒子化」（sources.js 某模型的 particle.animatedIdle:true，或
// particle.periodicAnimation）沒指定要烘幾張關鍵幀貼圖時，particle-sampler.js 的
// sampleModelAnimationFrames() 會依這段動畫的總秒數自動算一個合理值（見該函式內
// ANIM_AUTO_FPS 相關常數的說明），不是這裡的常數，這裡不用重複定義。

// particle.periodicAnimation 沒填 intervalSeconds 時的預設觸發間隔（秒）。
const DEFAULT_PERIODIC_INTERVAL_SECONDS = 60;

// 「模型序列播放」（一鍵觸發、在 sources.js 設定的多個模型之間連續變形、無限
// 循環，直到手動停止）每一站拆成「停留」＋「轉換」兩段，秒數來自 sources.js 的
// sequenceHoldSeconds／sequenceTransitionSeconds（沒填就用這裡的預設值——例如
// 舊版 sources.js 還沒加這兩個 export 的情況）。Math.max() 夾住兩個數字：
// SEQUENCE_TRANSITION_SECONDS 至少要是一個很小的正數，不然
// advanceSequencePlayback() 算 blend 時會除以 0；SEQUENCE_HOLD_SECONDS 允許
// 到 0（＝完全沒有停留、一直在轉換），不需要下限。詳見 loadSequenceStages()／
// advanceSequencePlayback()。
const DEFAULT_SEQUENCE_HOLD_SECONDS = 3;
const DEFAULT_SEQUENCE_TRANSITION_SECONDS = 1.5;
const SEQUENCE_HOLD_SECONDS = Math.max(
  0,
  configuredSequenceHoldSeconds != null ? configuredSequenceHoldSeconds : DEFAULT_SEQUENCE_HOLD_SECONDS
);
const SEQUENCE_TRANSITION_SECONDS = Math.max(
  0.05,
  configuredSequenceTransitionSeconds != null ? configuredSequenceTransitionSeconds : DEFAULT_SEQUENCE_TRANSITION_SECONDS
);
const SEQUENCE_STAGE_DURATION = SEQUENCE_HOLD_SECONDS + SEQUENCE_TRANSITION_SECONDS;

// sources.js 某模型的 particle.sequenceVoice 填了檔名時，從「這一站進入停留段」
// 那一刻起算，滿這麼多秒後播放一次（見 sources.js 開頭 sequenceVoice 欄位說明、
// advanceSequencePlayback() 裡的觸發邏輯）。使用者需求就是固定 0.3 秒，不像
// SEQUENCE_HOLD_SECONDS/SEQUENCE_TRANSITION_SECONDS 那樣開放 sources.js 覆寫——
// 這是「進場後稍微停頓一下再開口」的節奏設計，不是取樣校正，沒有逐模型客製化
// 的需求。
const SEQUENCE_VOICE_DELAY_SECONDS = 0.3;

let renderer, scene, camera, canvas, fbo, controls;
let currentModelKey = DEFAULT_MODEL;
let progress = 0;
let transitionFrom = 0;
let transitionTarget = 0; // 0=散開（目標狀態）、1=聚合（目標狀態）
let transitionStart = null;
// 目前這個模型的閒置動畫設定（type/axis/amplitude/speed，見 normalizeIdleMotion()）
// 跟動畫自己的相位時鐘。idleElapsed 只在「完全聚合、沒轉場、使用者沒在拖」時往前走
// （跟原本 rotation.y 只在同一條件下累加是同一招），bob/swing 靠它算 sin() 相位，
// spin 則沿用原本「靠 delta 累加角度」的寫法（見 applyIdleMotion()）。
let currentIdleMotion = { type: 'spin', axis: 'y', amplitude: 0, speed: IDLE_ROTATE_SPEED };
let idleElapsed = 0;
// 「動畫粒子化」目前的播放狀態：currentAnimFrames 是 DataTexture 陣列（null 代表
// 目前這個模型是單幀定格、沒有動畫可播）；animPhase 是在 currentAnimClipDuration
// 這個循環週期裡的當前秒數，每幀不管有沒有轉場/使用者拖曳都會往前走（見 tick()
// 裡的 advanceAnimationPlayback()）——這是刻意跟 idleMotion 的暫停條件分開的：
// idleMotion 是「整團粒子的裝飾性搖擺」，使用者拖鏡頭時停下來才不會跟鏡頭打架；
// 這裡是「角色本身在呼吸/待機」，應該持續播放，跟拖不拖鏡頭無關。
let currentAnimFrames = null;
let currentAnimClipDuration = 1; // 秒；預設 1 只是避免 animPhase 取模時除以 0，static 模型用不到
let currentAnimSpeed = 1; // sources.js 的 particle.animationSpeed，倍率套在 delta 上，見 advanceAnimationPlayback()
let animPhase = 0;
// loadModelTexture() 回傳的完整結果（{type, texture} 或 {type, textures, clipDuration}）
// ——currentAnimFrames 只存了「目前綁在 uniform 上可能用到的那份參照」，animated
// 情況下換模型要把全部 N 張貼圖都 dispose() 掉，不能只看 uniform A/B 當下指到的那
// 兩張，所以額外留一份完整結果在這裡給 swapActiveModel() 換模型前呼叫
// disposeModelResult() 用。currentModelResult 現在是 { default, periodic } 這個
// 形狀（見 loadModelTexture()），default 就是原本單獨一份 modelResult，periodic
// 是下面這組「定時動作」用的，沒設定 particle.periodicAnimation 就是 null。
let currentModelResult = null;

// 「定時動作」：跟上面 currentAnimFrames／animPhase 那組「動畫粒子化」是兩套獨立
// 機制，共用同一組 shader uniform（uTextureModelA/B/uAnimBlend），但語意不同——
// currentAnimFrames 那組是「一直循環播放」（particle.animatedIdle），這組是
// 「預設定格在 bind pose，閒置滿 periodicIntervalSeconds 秒才觸發播一次，播完
// 自動退回定格姿勢」（particle.periodicAnimation，例如 aatroxModel 的 Recall）。
// 一個模型應該只用其中一種，不要兩個都設定，不然兩邊會搶著寫同一組 uniform，
// 誰在 tick() 裡後執行就蓋過誰，畫面會忽動忽靜。
let periodicFrames = null; // DataTexture[]，null 代表這個模型沒設定 periodicAnimation
let periodicClipDuration = 1;
let periodicAnimSpeed = 1; // sources.js 的 particle.periodicAnimation.speed，倍率套在 delta 上，見 advancePeriodicAnimation()
let periodicIntervalSeconds = DEFAULT_PERIODIC_INTERVAL_SECONDS;
let periodicTimer = 0; // 「已經閒置多久」的累加秒數，只在完全聚合/沒轉場/沒拖曳時累加，見 advancePeriodicAnimation()
let periodicPlaying = false; // 目前是不是正在播那段觸發動畫（true 期間 periodicTimer 不會動，播完才重新從 0 開始倒數）
let periodicPhase = 0; // 播放中的已播秒數，播到 periodicClipDuration 就算播完一輪（不循環，跟 animPhase 用 % 取模的邏輯不一樣）

// 「模型序列播放」：跟上面兩組（animatedIdle／periodicAnimation）是同一種
// 「換指標＋改一個 float」機制、寫進同一組 uTextureModelA/B/uAnimBlend uniform，
// 但語意是「跨模型」而不是「同一個模型的不同姿勢」——sequenceStages 陣列裡每一項
// 是不同模型（依 sources.js 的 sequenceModels 清單）各自取樣出來的靜態形狀 +
// 顏色。啟用期間會整個接管 uTextureModelA/B/uAnimBlend/uColor，tick() 裡改呼叫
// advanceSequencePlayback() 取代 advanceAnimationPlayback()／advancePeriodicAnimation()
// （見 tick() 的說明），兩邊不會同時搶著寫同一組 uniform。
//
// sequenceStages 故意不在 App 一開機就預載——sequenceModels 清單可能有好幾個
// 模型、甚至偏大的檔案，這個功能不是每次都會用到，無條件背景讀會白白佔頻寬/
// CPU/記憶體。改成「懶載入＋session 內快取」：第一次觸發（Ctrl+Alt+S／系統匣
// 選單）才呼叫 startSequencePreload() 真的去讀 sequenceModels 清單裡的模型，
// 讀取/取樣期間畫面先顯示 sequenceLoadingTexture 這個「載入中」佔位樣式頂著
// （見 buildSequenceLoadingTexture()），advanceSequencePlayback() 每幀檢查
// sequenceStages 是不是已經有值了，一旦背景讀完就自動接手開始真的播放，不用
// 另外喚醒。sequenceStages 一旦填好就留著給同一個 session 之後的觸發重複
// 使用（不會每次停止/觸發都重讀一次），stopSequenceMode() 不會 dispose 它，
// 只有整個 renderer reload（F8、換角色...）這個模組重新初始化才會清空。
// 見 startSequencePreload()／advanceSequencePlayback()／window.setParticleSequencePlayback()。
let sequenceStages = null; // [{ texture, color }, ...] 或 null（還沒觸發過、或正在載入中）
let sequencePreloadPromise = null; // 進行中的載入 Promise，startSequencePreload() 用來擋重複觸發
let sequenceModeActive = false; // 使用者「要」序列模式（不代表 sequenceStages 已經就緒，可能還在顯示 loading 佔位樣式）
let sequenceLoadingTexture = null; // sequenceStages 還沒就緒時顯示的佔位貼圖，真的開始播放／停止時要 dispose()
const SEQUENCE_LOADING_COLOR = new THREE.Color(0.15, 0.85, 1.0); // 電光藍/青色，科幻 HUD 常見的「系統讀取中」配色，跟任何一個模型自己的配色都不撞
// loading 佔位圖案「左到右掃描顯現」動畫的相位時鐘＋世界座標邊界（見
// computeSequenceLoadingPositions() 算出來的實際包圍盒，不是憑空猜的數字）。
// 掃過一輪就從頭再掃一次（見 advanceSequenceLoadingSweep()），不是掃一次就停，
// 因為背景載入實際要花多久不確定，掃描動畫要撐得住任意長的等待時間。
let sequenceLoadingSweepPhase = 0;
let sequenceLoadingBoundsMinX = -1.5;
let sequenceLoadingBoundsMaxX = 1.5;
const SEQUENCE_LOADING_SWEEP_SECONDS = 10; // 掃過一輪（最左到最右）要幾秒，再放慢 1.2 倍（2.6 * 1.2）
let sequencePhase = 0;
let sequenceTotalDuration = 1; // 秒；預設 1 避免 sequencePhase 取模時除以 0

// 序列播放每站的 sequenceVoice 觸發狀態：sequenceVoiceLastIndexA 記著「上一次檢查
// 時 indexA 是誰」，indexA 變了（進入新的一站的停留段）就重設 sequenceVoiceFired
// 成 false，讓這一站重新有機會觸發一次語音；withinStage 累加到
// SEQUENCE_VOICE_DELAY_SECONDS 才真的播放並把 sequenceVoiceFired 設成 true，同一站
// 停留段剩下的時間就不會重複播。-1 是不可能的 indexA 值，確保序列播放第一次啟動、
// 第 0 站也會正常觸發（不會被誤判成「已經是這一站，不用重新算」）。見
// advanceSequencePlayback()／window.setParticleSequencePlayback()（重新啟動時歸零）。
let sequenceVoiceLastIndexA = -1;
let sequenceVoiceFired = false;
// 「模型序列播放」期間唯一的背景音樂（sources.js 的 sequenceBgm），null 代表沒填
// 或還沒開始播放。見 startSequenceBgm()／stopSequenceBgm()。
let sequenceBgmAudio = null;

let rafId = null;
let ready = false;
let pendingEnabled = null;
let modelSwapPending = false;
let lastFrameTime = null;
let userInteracting = false; // 使用者正在用 OrbitControls 拖/滾的時候，暫停自動緩慢自轉
let interactiveMode = false; // 桌寵視窗目前是不是「互動模式」，由 main.js 同步（見檔案開頭說明）
// 3D 模型微調 debug 模式是否開啟：由 Ctrl+Alt+N（main.js 全域快捷鍵，見該檔案
// window.toggleParticleNudgeMode 那段）切換，見 handleManualNudgeKey() 開頭的說明——
// 原本借用 interactiveMode 當開關，但那個模式在正常使用中（開聊天輸入框打字）就會是
// true，方向鍵反而被這裡搶走，改成獨立的開關才不會互相干擾。
let manualNudgeModeActive = false;
let hovering = false; // 滑鼠目前是不是停在粒子點雲上（決定要不要顯示抓取游標）
let lastMouseMoveAt = 0; // 最後一次收到 mousemove 的時間戳，見 HOVER_STALE_MS

const raycaster = new THREE.Raycaster();
raycaster.params.Points.threshold = HOVER_THRESHOLD;
const pointerNDC = new THREE.Vector2(9999, 9999); // 一開始擺在畫面外，避免還沒收過 mousemove 就誤判命中

// ── 手動微調 debug 工具 ─────────────────────────────────────────────────
// 互動模式下用鍵盤即時微調目前模型的 position/rotationY/scale，每按一下把差量
// 疊加在畫面上、同時印到 Console，方便用眼睛判斷夠了沒，滿意後手動把數字抄進
// sources.js（見 particle-effect/動畫參數說明.md、handleManualNudgeKey()）。
// 這三個值只影響畫面顯示，不會寫回 sources.js、也不會在換模型/reload 後留著。
const MANUAL_NUDGE_STEP = 0.05; // 一般幅度：position 每按一下累加的量（跟模型座標系同單位）
const MANUAL_NUDGE_STEP_FINE = 0.005; // 按住 Shift 時用這個較小的幅度，方便收尾精修
const MANUAL_NUDGE_ROT_STEP = 0.1; // 一般幅度：rotationY 每按一下累加的量（rad）
const MANUAL_NUDGE_ROT_STEP_FINE = 0.01; // 按住 Shift 時用這個較小的幅度
// scale 是「倍率」不是「差量」（跟 position/rotationY 用加法不一樣，scale 本身
// 就是乘法性質——sources.js 的 scale 也是拿去乘表面頂點座標，見
// particle-sampler.js 的 placed.scale()），所以這裡用「每按一下乘上/除以一個
// 比例」而不是「加上/減掉一個固定量」，才不會在小 scale 時每步感覺太大、
// 大 scale 時每步又感覺太小。
const MANUAL_NUDGE_SCALE_FACTOR = 1.05; // 一般幅度：每按一下乘上/除以 5%
const MANUAL_NUDGE_SCALE_FACTOR_FINE = 1.01; // 按住 Shift 時用這個較小的幅度：1%
const manualOffset = new THREE.Vector3(0, 0, 0); // 累加的手動 position 偏移，疊加在 idleMotion 算出的值上面
let manualRotationY = 0; // 累加的手動 rotationY 偏移（rad），疊加在 idleMotion 算出的值上面
let manualScale = 1; // 累加的手動 scale 倍率（乘法性質，基準是 1，不是 0），疊加在 fbo.particles.scale 上面

// 只要有任何一項還沒歸零/歸一，就代表使用者正在用手動微調工具校正。tick() 用這個
// 判斷要不要暫停閒置動畫（spin/bob/swing）——swing 每幀是直接覆蓋 rotation[axis]
// （不是疊加），如果閒置動畫繼續跑，手動調的 rotationY 會立刻被蓋掉，畫面上完全
// 看不出變化（只有 Console 印出來的累計數字是對的）；bob 同理會蓋掉 position 那一軸；
// spin 雖然是疊加不會蓋掉，但持續自轉也會讓人分不清「這是我調的」還是「它本來就在轉」。
// 一律暫停最單純，反正是校正 debug 用，不需要邊看閒置動畫邊校正。按 R 全部歸零後
// 這個判斷自然變 false，閒置動畫會恢復。
function hasManualNudge() {
  return manualOffset.x !== 0 || manualOffset.y !== 0 || manualOffset.z !== 0 || manualRotationY !== 0 || manualScale !== 1;
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// 把 sources.js 某個模型項目的 idleMotion 欄位換算成 applyIdleMotion() 可以直接
// 讀的完整設定（type/axis/amplitude/speed 都補齊，不用在 tick 熱路徑裡每幀判斷
// 「這個欄位有沒有填」）。沒填 idleMotion、或 type 打錯字不是 bob/swing 的，一律
// 退回 spin——也就是原本唯一支援的「繞 Y 軸連續自轉」，維持舊模型設定檔不用改
// 就跟以前行為一模一樣的向下相容。
function normalizeIdleMotion(raw) {
  if (!raw || (raw.type !== 'bob' && raw.type !== 'swing')) {
    return {
      type: 'spin',
      axis: 'y',
      amplitude: 0, // spin 用不到 amplitude，補 0 只是讓形狀一致，不會被讀到
      speed: raw && raw.speed != null ? raw.speed : IDLE_ROTATE_SPEED,
    };
  }
  const isBob = raw.type === 'bob';
  return {
    type: raw.type,
    axis: raw.axis || 'y',
    amplitude: raw.amplitude != null ? raw.amplitude : (isBob ? IDLE_BOB_AMPLITUDE : IDLE_SWING_AMPLITUDE),
    speed: raw.speed != null ? raw.speed : (isBob ? IDLE_BOB_SPEED : IDLE_SWING_SPEED),
  };
}

// 把 sources.js 的某個 key 換算成「這次要用的 GLB 網址、取樣校正、顏色、閒置動畫」。
// key 查無此模型時印一次 console.error（列出可用的 key）並回傳安全的預設值，
// 讓呼叫端（loadModelTexture）自然退回隨機散點，不用另外判斷。
// 把 particle-effect/audio/<subdir>/ 底下的一個檔名換算成絕對網址，跟 resolveModel()
// 裡 models/ 的算法同一招（用 import.meta.url，不依賴 index.html 的 base URL）。
// filename 是 falsy（sequenceVoice/sequenceBgm 沒填或空字串）就回傳 null，呼叫端
// 用這個訊號判斷「這個位置沒有音檔，不用建立 Audio」，不用另外判斷字串是否為空。
function resolveAudioUrl(subdir, filename) {
  if (!filename) return null;
  return new URL(`./audio/${subdir}/${filename}`, import.meta.url).href;
}

function resolveModel(key) {
  const source = sources[key];
  if (!source) {
    console.error(
      `[particle-effect] sources.js 裡找不到 "${key}"，先用隨機散點頂著。可用的 key：${Object.keys(sources).join(', ')}`
    );
    return {
      url: null,
      particleConfig: {},
      color: new THREE.Color(...DEFAULT_COLOR),
      idleMotion: normalizeIdleMotion(undefined),
    };
  }
  // 用 import.meta.url 算絕對路徑，不依賴 index.html 的 base URL（GLTFLoader
  // 內部是用一般 fetch，relative URL 預設是相對「文件」不是相對「這支模組」，
  // 這裡明確換算成絕對路徑，避免之後檔案搬動位置就找不到路徑）。
  return {
    url: new URL(`./models/${source.file}`, import.meta.url).href,
    particleConfig: source.particle || {},
    // null 代表「sources.js 沒填 color」，交給 loadModelTexture() 在 GLB 讀完之後
    // 從材質自動取色（見 sampleAverageMaterialColor()）——這裡不能直接退回
    // DEFAULT_COLOR，那樣自動取色永遠沒機會跑。
    color: source.color ? new THREE.Color(...source.color) : null,
    idleMotion: normalizeIdleMotion(source.idleMotion),
  };
}

// 換模型／重新初始化時呼叫：套用新模型的閒置動畫設定，並把粒子群組的
// position/rotation 歸零、相位時鐘歸零。歸零是必要的——不然假設上一個模型是
// bob（會動 position.y），消散動畫開始時 tick() 就不再呼叫 applyIdleMotion()，
// position.y 會停在消散當下的偏移值；如果沒歸零，新模型即使是 swing（只動
// rotation，不會去動 position）也會整團永遠偏移，看起來像是聚合錯位置。
function applyIdleMotionConfig(idleMotion) {
  currentIdleMotion = idleMotion;
  idleElapsed = 0;
  if (fbo) {
    fbo.particles.position.set(0, 0, 0);
    fbo.particles.rotation.set(0, 0, 0);
  }
}

// 完全聚合、沒有動畫在跑、使用者也沒在拖鏡頭時，tick() 每幀呼叫這個套用「這個模型
// 該有的閒置動畫」。bob/swing 是純函式（用 idleElapsed 算 sin() 相位），本身不會
// 累積誤差；spin 沿用原本「靠 delta 累加角度」的寫法，因為它本來就是無界的連續
// 旋轉，用 sin() 表示不了。
function applyIdleMotion(delta) {
  const motion = currentIdleMotion;
  switch (motion.type) {
    case 'bob': // 上下（或指定軸向）短距離來回：只動 position，不動 rotation
      fbo.particles.position[motion.axis] = Math.sin(idleElapsed * motion.speed) * motion.amplitude;
      break;
    case 'swing': // 水平（或指定軸向）短距離轉動：只動 rotation，不動 position
      fbo.particles.rotation[motion.axis] = Math.sin(idleElapsed * motion.speed) * motion.amplitude;
      break;
    default: // spin：跟原本行為一樣，繞 Y 軸連續自轉
      fbo.particles.rotation.y += delta * motion.speed;
      break;
  }
}

// 手動微調 debug 工具的按鍵處理，見上面 manualOffset/manualRotationY/manualScale
// 宣告處的說明。只有 Ctrl+Alt+N 開過「微調模式」（manualNudgeModeActive）才生效——
// 曾經借用 interactiveMode 當開關，但方向鍵這幾顆同時也是聊天輸入框打字時要用的鍵，
// interactiveMode 開著才能打字，兩邊搶同一組鍵；改成獨立、預設關閉的開關，平常打字
// 不會被這個 debug 工具吃掉按鍵，只有明確按過 Ctrl+Alt+N 才會生效：
//   ← / →           position.x -/+ 步距
//   ↑ / ↓           position.y +/- 步距
//   [ / ]           position.z -/+ 步距（不在方向鍵上，借用中括號代表「深度」）
//   PageUp / PageDown   rotationY -/+ 步距
//   Home / End          scale ×/÷ 一個倍率
//   按住 Shift       上面幾個都改用比較小的 FINE 幅度，方便收尾精修
//   R               全部歸零（含 scale），重新開始微調
//   P               不改變數值，只是重印一次目前的累計狀態（想再看一眼但不小心
//                   清掉 Console 記錄時用）
// ⚠️ 全部刻意選「非印刷字元」的功能鍵（方向鍵/中括號/PageUp/PageDown/Home/End），
// 不用逗號句號/加減號這類標點符號鍵——中文輸入法開著、標點設成全形的話，這類鍵
// 送到瀏覽器前就先被轉成全形標點（，。＋－），e.key 收到的不是我們判斷的半形
// 字元，鍵就會「看起來沒反應」。方向鍵/PageUp/PageDown/Home/End 這類導覽鍵不會
// 被輸入法攔截，才選它們。
// 每次按鍵都直接把這次的差量/倍率套用到 fbo.particles 上（不是每幀重複疊加），
// manualOffset/manualRotationY/manualScale 只是跟著同步累計、給下面的
// console.log 顯示用，應該永遠對得上。只要有任何一項不是預設值，tick() 就會
// 透過 hasManualNudge()（見宣告處說明）自動暫停這個模型的閒置動畫（spin/bob/
// swing），不然像 swing 那種每幀直接覆蓋 rotation[axis] 的閒置動畫，會把手動調
// 的 rotationY 立刻蓋掉、畫面上看不出變化。按 R 全部歸零後閒置動畫會自動恢復，
// 不用手動再做什麼。
// 每次按鍵都會印出「這次的差量/倍率」＋「目前累計的偏移/倍率」＋這顆模型在
// sources.js 裡目前生效的 position/rotationY/scale 參考值（沒填就是 auto-fit，
// 提醒去看模型載入時 particle-sampler.js 印的那行自動置中 log）——最後要填回
// sources.js 的數字：
//   position/rotationY（加法性質）＝ 參考值 + 累計偏移
//   scale（乘法性質，因為 sources.js 的 scale 本來就是拿去乘表面頂點座標）
//     ＝ 參考值 × 累計倍率（各軸分別乘，這裡假設是等比縮放，三軸乘同一個倍率）
const MANUAL_NUDGE_KEYS = new Set([
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '[', ']', 'PageUp', 'PageDown', 'Home', 'End', 'r', 'R', 'p', 'P',
]);
function handleManualNudgeKey(e) {
  if (!manualNudgeModeActive || !fbo) return;
  if (!MANUAL_NUDGE_KEYS.has(e.key)) return;
  e.preventDefault();

  const posStep = e.shiftKey ? MANUAL_NUDGE_STEP_FINE : MANUAL_NUDGE_STEP;
  const rotStep = e.shiftKey ? MANUAL_NUDGE_ROT_STEP_FINE : MANUAL_NUDGE_ROT_STEP;
  const scaleFactor = e.shiftKey ? MANUAL_NUDGE_SCALE_FACTOR_FINE : MANUAL_NUDGE_SCALE_FACTOR;
  let label = '';
  switch (e.key) {
    case 'ArrowLeft':
      fbo.particles.position.x -= posStep;
      manualOffset.x -= posStep;
      label = `position.x -${posStep}`;
      break;
    case 'ArrowRight':
      fbo.particles.position.x += posStep;
      manualOffset.x += posStep;
      label = `position.x +${posStep}`;
      break;
    case 'ArrowUp':
      fbo.particles.position.y += posStep;
      manualOffset.y += posStep;
      label = `position.y +${posStep}`;
      break;
    case 'ArrowDown':
      fbo.particles.position.y -= posStep;
      manualOffset.y -= posStep;
      label = `position.y -${posStep}`;
      break;
    case '[':
      fbo.particles.position.z -= posStep;
      manualOffset.z -= posStep;
      label = `position.z -${posStep}`;
      break;
    case ']':
      fbo.particles.position.z += posStep;
      manualOffset.z += posStep;
      label = `position.z +${posStep}`;
      break;
    case 'PageDown':
      fbo.particles.rotation.y -= rotStep;
      manualRotationY -= rotStep;
      label = `rotationY -${rotStep}`;
      break;
    case 'PageUp':
      fbo.particles.rotation.y += rotStep;
      manualRotationY += rotStep;
      label = `rotationY +${rotStep}`;
      break;
    case 'Home':
      fbo.particles.scale.multiplyScalar(1 / scaleFactor);
      manualScale /= scaleFactor;
      label = `scale ÷${scaleFactor}`;
      break;
    case 'End':
      fbo.particles.scale.multiplyScalar(scaleFactor);
      manualScale *= scaleFactor;
      label = `scale ×${scaleFactor}`;
      break;
    case 'r':
    case 'R':
      // 歸零：把已經套用到 fbo.particles 上的累計偏移/倍率還原回去（不是直接
      // set(0,0,0)/set(1,1,1)——fbo.particles.position/rotation/scale 上可能還
      // 疊著 idleMotion 這一幀算出來的值，直接蓋掉會連 idleMotion 的部分一起洗掉）。
      // position/rotation 是加法性質用減的還原，scale 是乘法性質用除的還原。
      fbo.particles.position.x -= manualOffset.x;
      fbo.particles.position.y -= manualOffset.y;
      fbo.particles.position.z -= manualOffset.z;
      fbo.particles.rotation.y -= manualRotationY;
      fbo.particles.scale.divideScalar(manualScale);
      manualOffset.set(0, 0, 0);
      manualRotationY = 0;
      manualScale = 1;
      label = '重置歸零';
      break;
    case 'p':
    case 'P':
      label = '（沒改變，只是重印）';
      break;
  }

  const source = sources[currentModelKey];
  const basePosition = source && source.particle && source.particle.position;
  const baseRotationY = source && source.particle && source.particle.rotationY;
  const baseScale = source && source.particle && source.particle.scale;
  console.log(
    `[particle-debug] "${currentModelKey}" ${label} → 累計偏移 position: [${manualOffset.x.toFixed(3)}, ${manualOffset.y.toFixed(3)}, ${manualOffset.z.toFixed(3)}]，rotationY: ${manualRotationY.toFixed(3)}，scale 倍率: ${manualScale.toFixed(3)}\n` +
      `  目前 sources.js 生效的參考值：position: ${basePosition ? `[${basePosition.join(', ')}]` : '(未填，auto-fit，看模型載入時 Console 印的那行自動置中 log)'}，` +
      `rotationY: ${baseRotationY != null ? baseRotationY.toFixed(3) : '(未填，預設 0)'}，` +
      `scale: ${baseScale ? `[${baseScale.join(', ')}]` : '(未填，auto-fit，看模型載入時 Console 印的那行自動置中 log)'}\n` +
      `  要填回 sources.js 的數字＝ position/rotationY：參考值 + 累計偏移（相加）；scale：參考值 × 累計倍率（相乘，不是相加）`
  );
}

// Ctrl+Alt+N（main.js 全域快捷鍵）呼叫的入口：切換上面 handleManualNudgeKey() 的
// manualNudgeModeActive 開關。回傳切換後的狀態，main.js 目前沒有用到回傳值（跟
// toggleIdleChatSound()/toggleTtsSound() 一樣單純 fire-and-forget），保留是因為
// 之後如果想在畫面上顯示目前是否在微調模式，這裡已經有現成的值可以用。
window.toggleParticleNudgeMode = function toggleParticleNudgeMode() {
  manualNudgeModeActive = !manualNudgeModeActive;
  console.log(
    manualNudgeModeActive
      ? '[particle-debug] 微調模式：開啟——方向鍵/[ ]/PageUp/PageDown/Home/End/R/P 現在會調整目前 3D 模型（按 Ctrl+Alt+N 再關閉）'
      : '[particle-debug] 微調模式：關閉——方向鍵等鍵恢復原本用途（例如聊天輸入框的游標移動）'
  );
  return manualNudgeModeActive;
};

// 「動畫粒子化」的播放推進：currentAnimFrames 是 null 就什麼都不做（static 模型，
// A/B 已經在 applyAnimationState() 設定成同一張，不用每幀動）。有的話，把
// animPhase（在 currentAnimClipDuration 這個循環週期裡的秒數）換算成「該顯示第
// 幾幀、跟下一幀之間內插多少」，更新 uTextureModelA/B/uAnimBlend 這三個 uniform，
// 兩幀之間的形變交給 GPU（shaders.js 的 mix()）——不是每幀都重新取樣/上傳新貼圖，
// 貼圖在 loadModelTexture() 就全部烘好了，這裡純粹是「換指標＋改一個 float」，
// 對效能幾乎沒有額外負擔。
//
// 不管有沒有轉場、使用者拖不拖鏡頭都會呼叫（跟 idleMotion 那組「使用者拖曳時暫停」
// 的邏輯是分開的，見 currentAnimFrames 宣告處的說明）。
function advanceAnimationPlayback(delta) {
  if (!currentAnimFrames || currentAnimFrames.length < 2) return;

  animPhase = (animPhase + delta * currentAnimSpeed) % currentAnimClipDuration;
  const frameFloat = (animPhase / currentAnimClipDuration) * currentAnimFrames.length;
  const frameIndexA = Math.floor(frameFloat) % currentAnimFrames.length;
  const frameIndexB = (frameIndexA + 1) % currentAnimFrames.length;
  const blend = frameFloat - Math.floor(frameFloat);

  fbo.simulationMaterial.uniforms.uTextureModelA.value = currentAnimFrames[frameIndexA];
  fbo.simulationMaterial.uniforms.uTextureModelB.value = currentAnimFrames[frameIndexB];
  fbo.simulationMaterial.uniforms.uAnimBlend.value = blend;
}

// 「定時動作」的播放推進：跟上面 advanceAnimationPlayback() 是同一種「換指標＋改
// 一個 float」機制、寫進同一組 uniform，但語意是「預設定格在 default 貼圖，閒置滿
// periodicIntervalSeconds 秒才觸發播一次 periodicFrames、播完自動退回 default」，
// 不是持續循環。periodicFrames 是 null 就什麼都不做（這個模型沒設定
// particle.periodicAnimation）。
//
// periodicPlaying=false 時只做一件事：累計「已經閒置多久」，且只在完全聚合、沒有
// 轉場、使用者沒在拖鏡頭時累加（跟 idleMotion 的暫停條件一致——拖曳中/轉場中不算
// 「閒置」，但也不會歸零，鏡頭放開後接著累計，不會因為拖了一下就整個重新等）。
// 累到門檻就切成播放模式，從第 0 幀開始。
//
// periodicPlaying=true 時，periodicPhase 從 0 累加到 periodicClipDuration 就代表
// 播完一輪——不像 animPhase 用 % 取模那樣無限循環，是播一次就停，接著把 A/B 都設
// 回 default 貼圖、periodicTimer 歸零重新倒數下一次觸發。
function advancePeriodicAnimation(delta) {
  if (!periodicFrames || periodicFrames.length < 2) return;

  if (periodicPlaying) {
    periodicPhase += delta * periodicAnimSpeed;
    if (periodicPhase >= periodicClipDuration) {
      periodicPlaying = false;
      periodicPhase = 0;
      periodicTimer = 0;
      const defaultResult = currentModelResult && currentModelResult.default;
      if (defaultResult) {
        const initial = firstTextureOf(defaultResult);
        fbo.simulationMaterial.uniforms.uTextureModelA.value = initial;
        fbo.simulationMaterial.uniforms.uTextureModelB.value = initial;
        fbo.simulationMaterial.uniforms.uAnimBlend.value = 0;
      }
      return;
    }

    const frameFloat = (periodicPhase / periodicClipDuration) * periodicFrames.length;
    const frameIndexA = Math.min(Math.floor(frameFloat), periodicFrames.length - 1);
    const frameIndexB = Math.min(frameIndexA + 1, periodicFrames.length - 1);
    const blend = frameFloat - Math.floor(frameFloat);
    fbo.simulationMaterial.uniforms.uTextureModelA.value = periodicFrames[frameIndexA];
    fbo.simulationMaterial.uniforms.uTextureModelB.value = periodicFrames[frameIndexB];
    fbo.simulationMaterial.uniforms.uAnimBlend.value = blend;
  } else if (transitionTarget === 1 && transitionStart === null && !userInteracting) {
    periodicTimer += delta;
    if (periodicTimer >= periodicIntervalSeconds) {
      periodicPlaying = true;
      periodicPhase = 0;
    }
  }
}

// HSL 空間的色相內插：色相是環狀的（0 跟 1 是同一個角度），直接線性內插兩個
// 色相值可能會繞遠路（例如從 0.05 到 0.95，最短路徑其實是往負方向繞過 0，
// 不是往正方向繞一大圈），這裡挑最短路徑。回傳 0-1。
function lerpHue(h1, h2, t) {
  let diff = h2 - h1;
  if (diff > 0.5) diff -= 1;
  else if (diff < -0.5) diff += 1;
  let h = h1 + diff * t;
  if (h < 0) h += 1;
  if (h >= 1) h -= 1;
  return h;
}

const _hslA = { h: 0, s: 0, l: 0 };
const _hslB = { h: 0, s: 0, l: 0 };

// 兩個 THREE.Color 在 HSL 空間內插（不是 RGB 直線內插），寫回 target 並回傳。
// 色相差很大的兩個顏色（例如金色→暗紅）用 RGB 空間直線內插，中途容易經過一段
// 不上不下的髒灰色；HSL 空間沿色相環走最短路徑，中途的過渡色看起來更鮮活，
// 是「模型序列播放」轉換效果的一部分（見 advanceSequencePlayback()）。
function lerpColorHSL(colorA, colorB, t, target) {
  colorA.getHSL(_hslA);
  colorB.getHSL(_hslB);
  const h = lerpHue(_hslA.h, _hslB.h, t);
  const s = _hslA.s + (_hslB.s - _hslA.s) * t;
  const l = _hslA.l + (_hslB.l - _hslA.l) * t;
  return target.setHSL(h, s, l);
}

// stageA 在停留段（withinStage < SEQUENCE_HOLD_SECONDS）該顯示哪兩張貼圖＋blend：
// 沒有 sequenceAction 就是單純定格（A===B，blend=0）；有的話用跟
// advanceAnimationPlayback() 一樣的「frameIndexA/B + blend、% 取模無限循環」數學
// 播放那段動作——動作比 SEQUENCE_HOLD_SECONDS 短就自然循環用滿停留時間，比較長
// 就會在停留段結束時被直接截斷（見 sources.js sequenceAction 的說明，這是刻意
// 的行為，序列節奏不被個別模型的動作長度綁架）。
function resolveHoldFrames(stageA, holdElapsed) {
  if (!stageA.actionFrames || stageA.actionFrames.length < 2) {
    return { textureA: stageA.defaultTexture, textureB: stageA.defaultTexture, blend: 0 };
  }
  const actionElapsed = holdElapsed % stageA.actionDuration;
  const frameFloat = (actionElapsed / stageA.actionDuration) * stageA.actionFrames.length;
  const frameIndexA = Math.floor(frameFloat) % stageA.actionFrames.length;
  const frameIndexB = (frameIndexA + 1) % stageA.actionFrames.length;
  return {
    textureA: stageA.actionFrames[frameIndexA],
    textureB: stageA.actionFrames[frameIndexB],
    blend: frameFloat - Math.floor(frameFloat),
  };
}

// 「模型序列播放」的播放推進：跟 advanceAnimationPlayback() 是同一種「無限
// 循環、% 取模」骨幹，但每一站拆成兩段（見 SEQUENCE_HOLD_SECONDS／
// SEQUENCE_TRANSITION_SECONDS 的說明）：
//   停留段：indexA 這個模型定格顯示——除非它填了 sequenceAction，這種情況下
//     播放那段動作（見 resolveHoldFrames()），uAnimBlend 在這段期間是「動作
//     自己的姿勢內插」，不是模型間轉換，所以 uAnimBlendFX 這段時間關閉，
//     shaders.js 的 burst／尺寸/發光脈衝都不會誤套用到動作播放上。
//   轉換段：把 indexA 定格在「停留段結束那一刻」動作播到的那一幀（沒有
//     sequenceAction 就是它的預設姿勢），交叉淡化到 indexB 的預設姿勢，
//     uAnimBlend 從 0 線性跑到 1，這段才開啟 uAnimBlendFX，真正的「炫麗」
//     效果（每顆粒子時間錯開、中途外擴的 burst、尺寸/發光脈衝）交給
//     shaders.js 在 GPU 端做，這裡只需要把線性 blend 值傳過去。
// sequenceStages 每一項除了位置貼圖還帶了這個模型自己的顏色，轉換段額外用
// lerpColorHSL()（不是直接 RGB lerpColors()）在 JS 端算出 A/B 兩站顏色的內插
// 結果，直接寫回 uColor（本來就是每次換模型都會被 JS 端整個覆寫的 flat
// uniform，見 setupParticles()／swapActiveModel()），不用另外加
// uColorA/uColorB uniform；停留段（不管有沒有在播動作）維持 indexA 自己的
// 顏色，動作播放不換角色配色。
//
// 不管有沒有轉場、使用者拖不拖鏡頭都會走——跟 advanceAnimationPlayback() 一樣，
// 這是「序列本身在播放」，不是裝飾性的 idleMotion，兩者暫停條件不同。
// loading 佔位圖案「左到右掃描顯現」的播放推進：跟其他 advance* 函式一樣的
// 「% 取模、無限循環」骨幹，只是驅動的是 shaders.js 的 uLoadingSweep（世界座標
// X 門檻，見那邊 particlesFragmentShader 的說明），不是 uAnimBlend。只在還在
// 顯示 loading 佔位貼圖（sequenceLoadingTexture 非 null）時才有意義，真的開始
// 播放序列（advanceSequencePlayback() 進到下面那段）之後就不會再呼叫這個。
// 回傳這一幀有沒有剛好繞回一輪的起點（t 從接近 1 繞回 0）——advanceSequencePlayback()
// 用這個訊號判斷「這一輪掃描圖案是不是剛好畫完整圈」，見那邊的說明。
function advanceSequenceLoadingSweep(delta) {
  if (!sequenceLoadingTexture) return true;
  const next = sequenceLoadingSweepPhase + delta;
  const completedCycle = next >= SEQUENCE_LOADING_SWEEP_SECONDS;
  sequenceLoadingSweepPhase = next % SEQUENCE_LOADING_SWEEP_SECONDS;
  const t = sequenceLoadingSweepPhase / SEQUENCE_LOADING_SWEEP_SECONDS;
  const sweepX = sequenceLoadingBoundsMinX + t * (sequenceLoadingBoundsMaxX - sequenceLoadingBoundsMinX);
  fbo.renderMaterial.uniforms.uLoadingActive.value = 1;
  fbo.renderMaterial.uniforms.uLoadingSweep.value = sweepX;
  return completedCycle;
}

// 播放某一站的 sequenceVoice（stage.voiceAudio，createSequenceVoiceAudio() 建好的
// Audio 物件，沒填就是 null，直接跳過）。currentTime 歸零再播，讓同一站每次重新
// 觸發（序列繞回這一站的下一輪）都從頭播，不會因為上一輪的播放進度還沒歸零就
// 疊在中途接著播。play() 回傳的 Promise 在自動播放政策擋下時會 reject——這裡是
// 使用者已經主動點開「模型序列播放」才會走到，不是頁面一載入就自動播放音訊那種
// 會被瀏覽器擋的情境，理論上不會被擋，但還是接一個空 catch 保險，避免真的被擋
// 時噴一個沒人接的 unhandled rejection。
function playSequenceStageVoice(stage) {
  if (!stage.voiceAudio) return;
  try {
    stage.voiceAudio.currentTime = 0;
    stage.voiceAudio.play().catch(() => {});
  } catch (err) {
    console.warn('[particle-effect] 序列語音播放失敗：', err && err.message ? err.message : err);
  }
}

function advanceSequencePlayback(delta) {
  if (!sequenceStages || sequenceStages.length < 2) {
    advanceSequenceLoadingSweep(delta); // 還在等背景載入：讓 loading 佔位圖案的掃描動畫繼續跑
    return;
  }

  // 背景預載可能剛好在掃描圖案畫到一半時就完成了——不要立刻硬切，那樣看起來
  // 像圖案畫一半忽然消失。讓目前這一輪掃描先跑完（t 繞回 0 的那一刻，代表整個
  // 圖案剛好完整顯現過一次）才真正切到序列播放本身，代價最多是多等一輪掃描
  // （SEQUENCE_LOADING_SWEEP_SECONDS 秒），視覺上換來的是「圖案畫完了，接著才
  // 開始播放」的完整感。
  if (sequenceLoadingTexture) {
    const completedCycle = advanceSequenceLoadingSweep(delta);
    if (!completedCycle) return;
    sequenceLoadingTexture.dispose();
    sequenceLoadingTexture = null;
    fbo.renderMaterial.uniforms.uLoadingActive.value = 0; // 掃描顯現效果只在 loading 階段用，真的開始播放要關掉
  }

  // sequenceBgm 從這裡開始播，不是使用者一觸發「模型序列播放」就播——loading
  // 佔位圖案掃描顯現期間還沒看到真的模型，這時候先出背景音樂會讓聽覺跟視覺對不
  // 起來。這裡是 loading 剛結束、真的開始播放第一個模型的那一刻（上面
  // sequenceLoadingTexture 分支剛把佔位圖案收掉，或者 sequenceStages 是同一個
  // session 之前就快取好、這次觸發根本沒有 loading 階段，兩種情況都會第一時間
  // 走到這裡）。startSequenceBgm() 內部已經擋了「已經在播就不重複建立」，這裡
  // 不用另外記一個「是不是第一幀」的旗標，每幀呼叫都安全、成本也可忽略。
  startSequenceBgm();

  sequencePhase = (sequencePhase + delta) % sequenceTotalDuration;

  const stageIndexFloat = sequencePhase / SEQUENCE_STAGE_DURATION;
  const indexA = Math.floor(stageIndexFloat) % sequenceStages.length;
  const indexB = (indexA + 1) % sequenceStages.length;
  const withinStage = sequencePhase - Math.floor(stageIndexFloat) * SEQUENCE_STAGE_DURATION; // 0..SEQUENCE_STAGE_DURATION
  const stageA = sequenceStages[indexA];
  const stageB = sequenceStages[indexB];
  const inTransition = withinStage >= SEQUENCE_HOLD_SECONDS;

  // sequenceVoice 觸發：indexA 換了（進了一站新的停留段）就重新武裝，withinStage
  // 累加到 SEQUENCE_VOICE_DELAY_SECONDS 那一刻播一次，同一次停留段剩下的時間不會
  // 重複播——見 sequenceVoiceLastIndexA/sequenceVoiceFired 宣告處的說明。故意寫在
  // inTransition 判斷之外、不看 inTransition：sequenceHoldSeconds 如果被 sources.js
  // 設得比 0.3 秒還短，還是要在跨進轉換段之後補播，不能因為停留段太短就永遠沒
  // 機會觸發。
  if (indexA !== sequenceVoiceLastIndexA) {
    sequenceVoiceLastIndexA = indexA;
    sequenceVoiceFired = false;
  }
  if (!sequenceVoiceFired && withinStage >= SEQUENCE_VOICE_DELAY_SECONDS) {
    sequenceVoiceFired = true;
    playSequenceStageVoice(stageA);
  }

  let textureA, textureB, blend, colorBlend;

  if (!inTransition) {
    ({ textureA, textureB, blend } = resolveHoldFrames(stageA, withinStage));
    colorBlend = 0; // 停留段顏色固定是 stageA 自己的，不內插
  } else {
    // 轉換段的起點固定在「停留段結束那一刻」（withinStage 剛好等於
    // SEQUENCE_HOLD_SECONDS）動作播到的那一幀——不是這一幀當下的 withinStage，
    // 不然轉換段動作還會繼續往前播，跟「轉換時 indexA 應該是定格」的設計矛盾。
    textureA = resolveHoldFrames(stageA, SEQUENCE_HOLD_SECONDS).textureA;
    textureB = stageB.defaultTexture;
    blend = Math.min(1, (withinStage - SEQUENCE_HOLD_SECONDS) / SEQUENCE_TRANSITION_SECONDS);
    colorBlend = blend * blend * (3.0 - 2.0 * blend); // smoothstep，跟 shader 內 blendModels() 的緩動曲線大致同步
  }

  fbo.simulationMaterial.uniforms.uTextureModelA.value = textureA;
  fbo.simulationMaterial.uniforms.uTextureModelB.value = textureB;
  fbo.simulationMaterial.uniforms.uAnimBlend.value = blend;
  // particlesVertexShader／particlesFragmentShader 也要知道目前的 blend，才能算
  // 尺寸/發光脈衝（見 shaders.js 的說明），跟 simMaterial 那份保持同步。
  fbo.renderMaterial.uniforms.uAnimBlend.value = blend;

  // 加強版轉換效果只在真的跨模型轉換時開啟——停留段如果在播 sequenceAction，
  // 那段 uAnimBlend 循環是動作本身的姿勢內插，不是模型轉換，不該套用序列
  // 轉換專屬的 burst／尺寸/發光脈衝，見 shaders.js uAnimBlendFX 的說明。
  const fx = inTransition ? 1 : 0;
  fbo.simulationMaterial.uniforms.uAnimBlendFX.value = fx;
  fbo.renderMaterial.uniforms.uAnimBlendFX.value = fx;

  if (inTransition) {
    lerpColorHSL(stageA.color, stageB.color, colorBlend, fbo.renderMaterial.uniforms.uColor.value);
  } else {
    fbo.renderMaterial.uniforms.uColor.value.copy(stageA.color);
  }
}

function createCanvas() {
  const el = document.createElement('canvas');
  el.id = 'particle-effect-canvas';
  // 全螢幕（跟 morph-particles 原本的展示大小一致，不是右上角小面板）。
  // pointer-events:auto——為什麼不會擋到角色拖曳/點擊穿透，見檔案最上面那段
  // 大註解。z-index:6 疊在角色 canvas 平常的 5 之上、拖曳中的 9999 之下。
  // display:none 預設隱藏，開關切到 true 才顯示。
  el.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:auto;z-index:6;display:none;';
  document.body.appendChild(el);
  return el;
}

function setupScene() {
  canvas = createCanvas();

  renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setClearColor(0x000000, 0); // alpha 0：疊在透明桌寵視窗上，不能有底色
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false); // false：CSS 尺寸已經用 style 設好了

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 0, 4);
  camera.lookAt(0, 0, 0);

  // 拖曳旋轉／滾輪縮放／右鍵拖曳平移。只有桌寵視窗處在「互動模式」時才收得到
  // 這些事件（見檔案開頭大註解），穿透模式下形同沒接。
  controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0, 0);
  controls.minDistance = 1.5;
  controls.maxDistance = 15;
  controls.addEventListener('start', () => { userInteracting = true; });
  controls.addEventListener('end', () => { userInteracting = false; });

  // 滑鼠移到粒子點雲上就顯示「抓取」游標，離開就還原——用滑鼠位置換算成 NDC
  // 座標存起來，實際 raycast 放進 tick() 裡跟渲染同一個節奏做，不用每個
  // mousemove 都算一次（mousemove 觸發頻率通常比畫面更新更高）。
  //
  // 不用 mouseleave 判斷「離開」，改成記錄最後一次收到 mousemove 的時間、逾時
  // 才當作離開（見 updateHoverAndCursor() 的 HOVER_STALE_MS）——實測發現穿透模式下
  // win.setIgnoreMouseEvents(true,{forward:true}) 的轉發機制看起來是「游標下的
  // 像素透明度」驅動的，我們的粒子是稀疏、會動的半透明點，游標停在粒子間的透明
  // 縫隙時會被判定成「沒命中」，於是 mousemove/mouseleave 會在同一個游標位置
  // 高頻互相穿插觸發。如果 mouseleave 一收到就立刻重置座標，游標會瘋狂閃爍；
  // 改成「一段時間沒收到新 mousemove 才算離開」可以撐過這些穿插的假離開事件。
  canvas.addEventListener('mousemove', (e) => {
    lastMouseMoveAt = performance.now();
    const rect = canvas.getBoundingClientRect();
    pointerNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointerNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  });

  // 手動微調 debug 工具（互動模式下用鍵盤即時微調 position/rotationY），見
  // handleManualNudgeKey() 開頭的說明。掛在 window 不是 canvas——鍵盤事件不像
  // mousemove 需要知道游標相對 canvas 的座標，掛哪個元素都一樣收得到。
  window.addEventListener('keydown', handleManualNudgeKey);

  // 桌寵主視窗 resizable:false，正常情況下不會變尺寸，但螢幕/DPI 設定變動時
  // window.innerWidth/innerHeight 還是可能變，順手處理掉，跟 morph-particles
  // 的 Renderer.resize()/Camera.resize() 是同一種必要性。
  window.addEventListener('resize', () => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (fbo) fbo.renderMaterial.uniforms.uResolution.value.set(width, height);
  });
}

// 回傳值統一包成 { default, periodic, color } 三塊：
//   default:  這個模型「平常顯示」用的貼圖，跟以前一樣是 { type: 'static', texture }
//             或 { type: 'animated', textures, clipDuration } 兩種形狀之一
//             （animatedIdle 開了才會是 animated，其餘都是 static）。
//   periodic: 選用的「定時動作」貼圖組 { textures, clipDuration, intervalSeconds }，
//             沒設定 particle.periodicAnimation 就是 null。
//   color:    THREE.Color，永遠有值——resolveModel() 傳進來的 color 參數不是 null
//             （sources.js 明確填了）就直接用；是 null（沒填）就在這裡從 GLB 材質
//             自動取色（見 sampleAverageMaterialColor()），取不到色才退回
//             DEFAULT_COLOR。color 要在這裡（讀完 GLB 之後）才能真正確定，所以不能
//             放在 resolveModel() 那個同步函式裡決定。
// particleConfig.animatedIdle／periodicAnimation 開了但取樣失敗（動畫名稱打錯、
// 模型沒骨架...），都會印 console.error 並讓對應那塊維持容錯的預設值（default
// 退回單幀定格或隨機散點；periodic 就是 null，等於這個模型沒有定時動作可播），
// 不會讓整個模型讀取失敗。
// 對一個已載入的 gltf 做「單幀定格取樣 + 取色」，回傳 { texture, color } 或
// null（取樣不到表面資料時）。loadModelTexture() 的單幀定格分支、跟序列播放用的
// loadSequenceStages()（見下面）都呼叫這個，避免同一段「取樣＋取色」邏輯維護
// 兩份。color 傳明確值就直接用，傳 null/undefined 就從材質自動取色（見
// sampleAverageMaterialColor()），取不到才退回 DEFAULT_COLOR。
function sampleStaticStage(gltf, particleConfig, color, label) {
  const width = FBO_SIZE;
  const height = FBO_SIZE;
  const sampleCount = width * height;

  const positions = sampleModelToParticles(gltf, particleConfig, sampleCount, label);
  if (!positions) return null;

  const texture = positionsToDataTexture(positions, width, height);
  let resolvedColor = color;
  if (!resolvedColor) {
    const sampled = sampleAverageMaterialColor(gltf, label);
    resolvedColor = new THREE.Color(...(sampled || DEFAULT_COLOR));
  }
  return { texture, color: resolvedColor };
}

async function loadModelTexture({ url, particleConfig, color }) {
  const width = FBO_SIZE;
  const height = FBO_SIZE;
  const sampleCount = width * height;

  // url 是 null 代表 resolveModel() 查無此模型（已經印過 console.error 說明可用
  // 的 key），這裡就不用再嘗試 fetch 了。
  if (url) {
    try {
      const loader = new GLTFLoader();
      const gltf = await loader.loadAsync(url);

      let defaultResult = null;
      let resolvedColor = color; // 大多數情況會被下面的 static 分支覆寫成已解析的值

      if (particleConfig.animatedIdle && particleConfig.animation) {
        // 沒填 animationFrames 就傳 undefined，讓 sampleModelAnimationFrames() 依
        // 這段動畫的總秒數自動算一個合理的關鍵幀數量（見該函式內 resolvedFrameCount
        // 的說明）。
        const frameCount = particleConfig.animationFrames;
        const result = await sampleModelAnimationFrames(gltf, particleConfig, sampleCount, frameCount, 'particle-effect model');
        if (result && result.frames.length > 0) {
          defaultResult = {
            type: 'animated',
            textures: result.frames.map((positions) => positionsToDataTexture(positions, width, height)),
            clipDuration: result.clipDuration,
            // 播放速度倍率，套在 advanceAnimationPlayback() 的 delta 上——1 = 跟原始
            // GLB 動畫真實秒數一致（沒填的預設行為），>1 加快、<1 放慢。Math.max(0, ...)
            // 擋掉負數（負的 delta 累加會讓 animPhase 變負，取模/陣列索引都會壞掉）；
            // 0 是合法值，代表整條序列凍結在目前這一幀，不會前進。
            speed: particleConfig.animationSpeed != null ? Math.max(0, particleConfig.animationSpeed) : 1,
          };
        } else {
          console.error('[particle-effect] animatedIdle 取樣失敗（見上面 particle-sampler 的錯誤訊息），改走單幀定格。');
          // 不 return——故意往下掉到單幀定格那條路再試一次，跟 animation 找不到時
          // 單幀路徑本來就會自動退回 bind pose 是同一種容錯層次。
        }
      }

      if (!defaultResult) {
        const stage = sampleStaticStage(gltf, particleConfig, color, 'particle-effect model');
        if (stage) {
          defaultResult = { type: 'static', texture: stage.texture };
          resolvedColor = stage.color; // sampleStaticStage() 已經處理過明確填色/自動取色，不用重算
        } else {
          console.error('[particle-effect] 模型讀到了但取樣不到表面資料（可能沒有 Mesh），改用隨機散點頂著。');
        }
      }

      // periodicAnimation 是「額外」的一組貼圖，跟上面 default 是不是 animated
      // 無關（正常用法應該只挑一種，但程式碼不特別禁止兩個都填）。用同一份
      // gltf/particleConfig，只是把要播的動畫名稱換成 periodicAnimation.name——
      // scale/position/rotation 沿用 particleConfig 本身的值（如果有明確填），
      // 確保觸發動作播放時跟平常定格姿勢是同一個大小/位置，不會忽然跳一下。
      // name 跟 animation 欄位一樣可以是陣列（依序接續播放，播完整條序列才退回
      // 定格姿勢），這裡直接原封不動塞進 animConfig.animation，複用同一套
      // sampleModelAnimationFrames() 的陣列處理邏輯，不用另外寫一份。
      let periodicResult = null;
      if (particleConfig.periodicAnimation && particleConfig.periodicAnimation.name) {
        const pa = particleConfig.periodicAnimation;
        // 同上，沒填就交給 sampleModelAnimationFrames() 依總秒數自動算。
        const frameCount = pa.frameCount;
        const animConfig = { ...particleConfig, animation: pa.name };
        // 陣列時用 → 接起來顯示（比 JS 陣列預設的逗號字串化清楚是「依序播放」的意思），
        // 這裡只是給 log/錯誤訊息看的標籤，不影響實際取樣邏輯。
        const paLabel = Array.isArray(pa.name) ? pa.name.join(' → ') : pa.name;
        const result = await sampleModelAnimationFrames(
          gltf,
          animConfig,
          sampleCount,
          frameCount,
          `particle-effect model periodicAnimation(${paLabel})`
        );
        if (result && result.frames.length > 0) {
          periodicResult = {
            textures: result.frames.map((positions) => positionsToDataTexture(positions, width, height)),
            clipDuration: result.clipDuration,
            intervalSeconds: pa.intervalSeconds != null ? pa.intervalSeconds : DEFAULT_PERIODIC_INTERVAL_SECONDS,
            // 同 defaultResult.speed 的倍率機制，套在 advancePeriodicAnimation() 的
            // delta 上，見那邊的說明。0 會讓觸發動作卡在播放中不會播完退回定格姿勢，
            // 是合法但少見的用法（等同「觸發後凍結」），不特別擋。
            speed: pa.speed != null ? Math.max(0, pa.speed) : 1,
          };
        } else {
          console.error(
            `[particle-effect] periodicAnimation "${paLabel}" 取樣失敗（見上面 particle-sampler 的錯誤訊息），這個模型不會有定時動作。`
          );
        }
      }

      if (defaultResult) {
        // animatedIdle 那條路徑成功時，resolvedColor 還是最初傳進來的 color（可能
        // 是 null）——static 分支才會用 sampleStaticStage() 解析過，這裡補做同一件
        // 事，避免 animatedIdle 模型沒填 color 時漏掉自動取色。
        if (!resolvedColor) {
          const sampled = sampleAverageMaterialColor(gltf, 'particle-effect model');
          resolvedColor = new THREE.Color(...(sampled || DEFAULT_COLOR));
        }
        return { default: defaultResult, periodic: periodicResult, color: resolvedColor };
      }
    } catch (err) {
      console.warn(
        `[particle-effect] 讀不到 ${url}（還沒放 GLB 進去的話這是正常的），先用隨機散點頂著：`,
        err && err.message ? err.message : err
      );
    }
  }
  return {
    default: { type: 'static', texture: createRandomDataTexture(width, height, SCATTER_SPREAD * 0.6) },
    periodic: null,
    color: color || new THREE.Color(...DEFAULT_COLOR),
  };
}

// 「模型序列播放」的載入器：依 sources.js 的 sequenceModels 清單（空陣列就退回
// Object.keys(sources)，等於目前定義的全部模型都播一輪），把每個模型各自讀 GLB、
// 靜態單幀取樣（見 sampleStaticStage()——固定用該模型的靜態預設形狀，不管那個
// 模型自己有沒有設定 animatedIdle/periodicAnimation，序列本身就是動畫了，不疊加）。
// 如果這個模型另外填了 particle.sequenceAction，額外呼叫 sampleModelAnimationFrames()
// （跟 animatedIdle／periodicAnimation 同一套，重用同一份已經載入的 gltf，不用
// 多讀一次檔案）烘一組動作關鍵幀，給 advanceSequencePlayback() 在這個模型的
// 停留段播放用；沒填就是 null，advanceSequencePlayback() 會退回單純定格。
// 單一模型讀取/取樣失敗不會讓整個序列中斷：印 console.error，改用隨機散點頂著
// 那一站，比照 loadModelTexture() 遇到單一模型失敗時的容錯風格。回傳
// [{ defaultTexture, color, actionFrames, actionDuration }, ...]，長度可能小於
// 清單長度（key 在 sources.js 裡查無此模型的情況直接跳過，不會塞一個 null 進陣列）。
//
// 每一站內部也拆成好幾個小段，段落之間都會 await 一次 requestAnimationFrame
// 才繼續下一段——GLTFLoader 解析／sampleStaticStage() 的 MeshSurfaceSampler.build()
// ／sequenceAction 的 sampleModelAnimationFrames() 各自都是同步、會卡住整個
// render loop 的重工作，一站裡如果連續做完全部三段完全不讓出主執行緒，就算
// 站與站之間有 yield，這一站自己還是會感覺卡一下（尤其模型三角形數偏多、或
// 設定了 sequenceAction 要多跑一次動畫取樣的情況）。實測過純粹「站與站之間
// yield 一次」還是能感覺到頓挫，改成站內每段都 yield 才真的順——這些 yield
// 不會縮短總載入時間（甚至會因為多等好幾次 requestAnimationFrame 而略微拉長，
// 一次 yield 大約多等一個畫面更新週期），但能把「一次長卡頓」拆成更多段更短
// 的頓挫，觸發當下的體感會好很多，這是刻意拿「稍微多等幾秒」換「過程中不會
// 感覺卡住」的取捨。
// sources.js 某模型的 particle.sequenceVoice 建立對應的 Audio 物件，在
// loadSequenceStages() 讀取階段就先建好（不是等真的觸發播放那一刻才 new Audio()），
// 這樣 advanceSequencePlayback() 觸發時是瞬間播放，不會因為當下才去抓檔案而慢半拍
// 沒接上 SEQUENCE_VOICE_DELAY_SECONDS 那個精準的時間點。用全域被攔截過的
// window.Audio 建構子（見 index.html 開頭那段），會自動套用「閒置閒聊音效」那顆
// 靜音鈕的目前狀態、加進 _allAudio 讓靜音鈕能立刻停掉正在播的語音，不用另外接
// 靜音邏輯。filename 沒填或空字串（resolveAudioUrl() 回傳 null）就回傳 null，
// 呼叫端（advanceSequencePlayback() 裡的 playSequenceStageVoice()）看到 null 直接
// 跳過，不會出聲——這是使用者要求的「空字串跳過」語意。
function createSequenceVoiceAudio(filename, label) {
  const url = resolveAudioUrl('voice', filename);
  if (!url) return null;
  const audio = new Audio(url);
  audio.addEventListener('error', () => {
    console.error(`[particle-effect] 模型序列播放："${label}" 的 sequenceVoice "${filename}" 載入失敗，這一站不會有語音（檢查 particle-effect/audio/voice/ 底下有沒有這個檔案）。`);
  });
  return audio;
}

async function loadSequenceStages() {
  const width = FBO_SIZE;
  const height = FBO_SIZE;
  const sampleCount = width * height;
  const keys = configuredSequenceModels.length > 0 ? configuredSequenceModels : Object.keys(sources);

  function fallbackStage(color) {
    return {
      defaultTexture: createRandomDataTexture(width, height, SCATTER_SPREAD * 0.6),
      color: color || new THREE.Color(...DEFAULT_COLOR),
      actionFrames: null,
      actionDuration: 1,
      voiceAudio: null, // 讀取/取樣失敗才會退回這個後備 stage，沒有語音可播
    };
  }

  const stages = [];
  for (const key of keys) {
    await new Promise((resolve) => requestAnimationFrame(resolve));

    const modelInfo = resolveModel(key);
    if (!modelInfo.url) continue; // resolveModel() 已經印過 console.error 說明查無此 key

    try {
      const loader = new GLTFLoader();
      const tLoadStart = performance.now();
      const gltf = await loader.loadAsync(modelInfo.url);
      console.log(`[particle-effect][序列計時] "${key}" GLTFLoader.loadAsync() 耗時 ${(performance.now() - tLoadStart).toFixed(1)}ms`);

      // GLTFLoader 解析完成，MeshSurfaceSampler.build() 開始之前先讓一幀——
      // 兩段都是同步重工作，中間不隔一下的話等於沒拆。
      await new Promise((resolve) => requestAnimationFrame(resolve));

      const tSampleStart = performance.now();
      const stage = sampleStaticStage(gltf, modelInfo.particleConfig, modelInfo.color, `particle-effect sequence(${key})`);
      console.log(`[particle-effect][序列計時] "${key}" sampleStaticStage() 耗時 ${(performance.now() - tSampleStart).toFixed(1)}ms`);
      if (!stage) {
        console.error(`[particle-effect] 模型序列播放："${key}" 讀到了但取樣不到表面資料，改用隨機散點頂著這一站。`);
        stages.push(fallbackStage(modelInfo.color));
        continue;
      }

      let actionFrames = null;
      let actionDuration = 1;
      const sequenceAction = modelInfo.particleConfig.sequenceAction;
      if (sequenceAction && sequenceAction.name) {
        // 靜態定格取樣剛做完，動作關鍵幀取樣（同樣是 MeshSurfaceSampler，還要
        // 烘好幾張）開始之前再讓一幀，理由跟上面同一段。
        await new Promise((resolve) => requestAnimationFrame(resolve));

        const actionLabel = Array.isArray(sequenceAction.name) ? sequenceAction.name.join(' → ') : sequenceAction.name;
        const actionConfig = { ...modelInfo.particleConfig, animation: sequenceAction.name };
        const tActionStart = performance.now();
        const result = await sampleModelAnimationFrames(
          gltf,
          actionConfig,
          sampleCount,
          sequenceAction.frameCount,
          `particle-effect sequence(${key}) sequenceAction(${actionLabel})`
        );
        console.log(`[particle-effect][序列計時] "${key}" sampleModelAnimationFrames() 耗時 ${(performance.now() - tActionStart).toFixed(1)}ms（${result ? result.frames.length : 0} 幀，含每幀 rAF 讓幀時間）`);
        if (result && result.frames.length >= 2) {
          actionFrames = result.frames.map((positions) => positionsToDataTexture(positions, width, height));
          actionDuration = result.clipDuration || 1;
        } else {
          console.error(
            `[particle-effect] 模型序列播放："${key}" 的 sequenceAction "${actionLabel}" 取樣失敗，這一站的停留段改用靜態定格。`
          );
        }
      }

      const voiceAudio = createSequenceVoiceAudio(modelInfo.particleConfig.sequenceVoice, key);
      stages.push({ defaultTexture: stage.texture, color: stage.color, actionFrames, actionDuration, voiceAudio });
    } catch (err) {
      console.warn(
        `[particle-effect] 模型序列播放：讀不到 "${key}"（${modelInfo.url}），改用隨機散點頂著這一站：`,
        err && err.message ? err.message : err
      );
      stages.push(fallbackStage(modelInfo.color));
    }
  }

  return stages;
}

// 觸發「模型序列播放」的懶載入——只在 window.setParticleSequencePlayback(true)
// 發現 sequenceStages 還沒有值時才呼叫，不是 App 一開機就無條件讀（見
// sequenceStages 宣告處的說明，這樣功能沒用到就不會佔資源）。
// sequencePreloadPromise 擋重複觸發：同一個 session 裡不管觸發過幾次，只要
// 已經有一個載入在跑（或已經跑完），都回傳同一個 Promise，不會併發跑出兩份
// GLTFLoader 讀取（那樣除了浪費頻寬/CPU，兩份非同步完成的先後順序也不保證，
// 可能其中一份先完成又被另一份蓋過去）。
// 失敗（例如全部模型都讀取/取樣失敗）不會拋出，印 console.error 後
// sequenceStages 維持 null——使用者這次觸發會一直停在 loading 佔位樣式，這是
// 刻意的行為：比起讓觸發直接失敗、系統匣選單卻顯示「播放中」，「一直卡在
// loading」更誠實，至少畫面上看得出「這裡有問題」，不是靜默失敗。
function startSequencePreload() {
  if (sequencePreloadPromise) return sequencePreloadPromise;
  sequencePreloadPromise = loadSequenceStages()
    .then((stages) => {
      if (stages.length >= 2) {
        sequenceStages = stages;
        sequenceTotalDuration = sequenceStages.length * SEQUENCE_STAGE_DURATION;
      } else {
        console.error(
          '[particle-effect] 模型序列播放：背景預載完成，但取樣出來的站數不足 2 站（sources.js 的 sequenceModels 或全部模型清單可能太少、或都取樣失敗）。'
        );
        disposeSequenceStages(stages); // 站數不足沒辦法播，但已經取樣好的那 0~1 張貼圖還是要丟，不留著佔記憶體
      }
    })
    .catch((err) => {
      console.error('[particle-effect] 模型序列播放：背景預載失敗：', err);
    });
  return sequencePreloadPromise;
}

// defaultResult 是 loadModelTexture() 回傳值裡的 .default 那塊，取「第一張」貼圖
// 給 setupParticles() 當 simMaterial 初始值用（animated 情況下 A/B 一開始都指向
// 同一張，跟 static 情況數學上等價：uAnimBlend 還沒開始跑之前 mix(A,B,0)===A）。
function firstTextureOf(defaultResult) {
  return defaultResult.type === 'animated' ? defaultResult.textures[0] : defaultResult.texture;
}

// 換模型／初始化時呼叫：把新模型的動畫播放狀態（有沒有多關鍵幀可播、播放週期多長、
// 有沒有定時動作可播）記起來，並把 A/B 兩張貼圖、uAnimBlend 重設成「從預設姿勢的
// 第 0 幀開始」——不重設的話，比如從一個開了 animatedIdle 的模型換到一個 static
// 模型，simMaterial 上舊的 uTextureModelB 還指著上一個模型已經被 dispose() 的
// 貼圖，static 模型雖然每幀都會把 A/B 都設回同一張正確貼圖（見 tick() 的
// advanceAnimationPlayback()），但只有在 currentAnimFrames 非 null 時才會這樣
// 做——所以這裡才要主動重設，讓 currentAnimFrames=null 的 static 情況下 A/B 從
// 一開始就是新模型的正確貼圖。periodicTimer/periodicPlaying 也在這裡歸零，換模型
// 不會沿用上一個模型累積的閒置秒數。
function applyAnimationState(modelResult) {
  currentModelResult = modelResult;
  const defaultResult = modelResult.default;
  currentAnimFrames = defaultResult.type === 'animated' ? defaultResult.textures : null;
  currentAnimClipDuration = defaultResult.type === 'animated' ? defaultResult.clipDuration || 1 : 1;
  currentAnimSpeed = defaultResult.type === 'animated' && defaultResult.speed != null ? defaultResult.speed : 1;
  animPhase = 0;

  periodicFrames = modelResult.periodic ? modelResult.periodic.textures : null;
  periodicClipDuration = modelResult.periodic ? modelResult.periodic.clipDuration || 1 : 1;
  periodicAnimSpeed = modelResult.periodic && modelResult.periodic.speed != null ? modelResult.periodic.speed : 1;
  periodicIntervalSeconds = modelResult.periodic ? modelResult.periodic.intervalSeconds : DEFAULT_PERIODIC_INTERVAL_SECONDS;
  periodicTimer = 0;
  periodicPlaying = false;
  periodicPhase = 0;

  if (fbo) {
    const initial = firstTextureOf(defaultResult);
    fbo.simulationMaterial.uniforms.uTextureModelA.value = initial;
    fbo.simulationMaterial.uniforms.uTextureModelB.value = initial;
    fbo.simulationMaterial.uniforms.uAnimBlend.value = 0;
  }
}

// defaultResult（{type, texture|textures}）換模型時舊貼圖要記得 dispose()，不然
// GPU 記憶體會一直堆——animated 情況下是 N 張貼圖都要丟，不是只丟一張。
function disposeDefaultResult(defaultResult) {
  if (!defaultResult) return;
  if (defaultResult.type === 'animated') {
    for (const tex of defaultResult.textures) tex.dispose();
  } else {
    defaultResult.texture.dispose();
  }
}

// modelResult 是 loadModelTexture() 回傳的完整 { default, periodic }，換模型時
// 兩塊都要 dispose()，periodic 那組（如果有）也是 N 張都要丟。
function disposeModelResult(modelResult) {
  if (!modelResult) return;
  disposeDefaultResult(modelResult.default);
  if (modelResult.periodic) {
    for (const tex of modelResult.periodic.textures) tex.dispose();
  }
}

// loadSequenceStages() 回傳的 [{ defaultTexture, color, actionFrames, actionDuration }, ...]
// 整批 dispose()——有 sequenceAction 的那幾站，actionFrames 是一整組貼圖，也要
// 一起丟，不是只丟 defaultTexture。sequenceStages（背景預載快取、真的在播放的
// 那份）不會呼叫這個——它故意留著整個 session 重複使用，不隨每次觸發/停止而
// 重建（見 sequenceStages 宣告處的說明）。這裡是給 startSequencePreload() 遇到
// 「站數不足 2 站」這種放棄使用的結果，還是要把已經取樣好的貼圖丟掉，不留著
// 佔記憶體。
function disposeSequenceStages(stages) {
  if (!stages) return;
  for (const stage of stages) {
    stage.defaultTexture.dispose();
    if (stage.actionFrames) {
      for (const tex of stage.actionFrames) tex.dispose();
    }
  }
}

function setupParticles(modelResult, color) {
  const width = FBO_SIZE;
  const height = FBO_SIZE;
  const scatterTexture = createRandomDataTexture(width, height, SCATTER_SPREAD);
  const initialTexture = firstTextureOf(modelResult.default);

  // uTextureModelA/B + uAnimBlend 取代原本單一的 uTextureModel：static 模型
  // A===B、uAnimBlend 恆為 0（mix(A,B,0) 數學上就是 A，等同原本行為，沒有額外
  // 開銷）；animated 模型則由 tick() 裡的 advanceAnimationPlayback() 每幀更新
  // 這三個 uniform，在兩個相鄰關鍵幀貼圖之間做 GPU 端內插，見 shaders.js
  // simulationFragmentShader 的說明。
  const simMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uTextureScatter: { value: scatterTexture },
      uTextureModelA: { value: initialTexture },
      uTextureModelB: { value: initialTexture },
      uAnimBlend: { value: 0 },
      uAnimBlendFX: { value: 0 }, // 模型序列播放專用的加強版轉換開關，見 shaders.js 的說明
      uProgress: { value: 0 },
    },
    vertexShader: simulationVertexShader,
    fragmentShader: simulationFragmentShader,
  });

  const renderMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uPositions: { value: null },
      uSize: { value: 8 }, // 跟 morph-particles 原版粒子大小同一個量級（原本動態範圍 5-20）
      uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
      uProgress: { value: 0 },
      uColor: { value: color.clone() }, // clone：換模型時用 .copy() 原地覆寫，不用整個 material 重建
      uAnimBlend: { value: 0 }, // 跟 simMaterial 同名 uniform 同步，見 advanceSequencePlayback()
      uAnimBlendFX: { value: 0 },
      uLoadingActive: { value: 0 }, // loading 佔位圖案「左到右掃描顯現」開關，見 shaders.js／advanceSequenceLoadingSweep() 的說明
      uLoadingSweep: { value: 0 },
    },
    vertexShader: particlesVertexShader,
    fragmentShader: particlesFragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  fbo = new FBO(width, height, renderer, simMaterial, renderMaterial);
  scene.add(fbo.particles);
}

function setProgressUniform(value) {
  fbo.simulationMaterial.uniforms.uProgress.value = value;
  fbo.renderMaterial.uniforms.uProgress.value = value;
}

function updateHoverAndCursor() {
  const stale = performance.now() - lastMouseMoveAt > HOVER_STALE_MS;
  if (canvas.style.display === 'none' || stale) {
    hovering = false;
  } else {
    raycaster.setFromCamera(pointerNDC, camera);
    hovering = raycaster.intersectObject(fbo.particles).length > 0;
  }
  canvas.style.cursor = !interactiveMode ? 'default' : userInteracting ? 'grabbing' : hovering ? 'grab' : 'default';
}

function tick(now) {
  const delta = lastFrameTime ? (now - lastFrameTime) / 1000 : 0;
  lastFrameTime = now;

  if (transitionStart !== null) {
    const elapsed = now - transitionStart;
    const t = Math.min(elapsed / TRANSITION_MS, 1);
    progress = transitionFrom + (transitionTarget - transitionFrom) * easeInOutCubic(t);
    setProgressUniform(progress);
    if (t >= 1) {
      transitionStart = null;
      progress = transitionTarget;
      setProgressUniform(progress);
    }
  } else if (transitionTarget === 1 && !userInteracting && !hasManualNudge()) {
    // 完全聚合、沒有動畫在跑、使用者也沒在拖鏡頭、也沒在用手動微調工具：套用
    // 這個模型自己的閒置動畫（spin/bob/swing，見 sources.js 的 idleMotion 與
    // applyIdleMotion()）營造浮動感。使用者拖曳中就先停，不然鏡頭跟物件一起動
    // 很難對準想要的角度；正在用手動微調工具（hasManualNudge()）也先停，理由見
    // hasManualNudge() 宣告處的說明——不然 swing/bob 每幀直接覆蓋的那個軸，手動
    // 調的結果會立刻被蓋掉，畫面上完全看不出變化。
    idleElapsed += delta;
    applyIdleMotion(delta);
  }

  // 模型序列播放期間整個接管 uTextureModelA/B/uAnimBlend/uColor（見
  // advanceSequencePlayback() 開頭說明），跟平常這個模型自己的 animatedIdle／
  // periodicAnimation 是互斥的兩條路，不會同時跑、不會搶著寫同一組 uniform。
  if (sequenceModeActive) {
    advanceSequencePlayback(delta);
  } else {
    advanceAnimationPlayback(delta); // 跟上面的 if/else 分開、每幀都跑，見函式開頭說明
    advancePeriodicAnimation(delta); // 「定時動作」，內部自己判斷閒置/播放中該做什麼，見函式開頭說明
  }

  controls.update(); // enableDamping 需要每幀呼叫，慣性減速才會生效
  updateHoverAndCursor();
  fbo.update();
  renderer.render(scene, camera);

  if (transitionStart !== null || transitionTarget === 1 || userInteracting) {
    rafId = requestAnimationFrame(tick);
  } else {
    // 消散動畫跑完、目標狀態是「散開」、使用者也沒在拖：停掉 render loop、
    // 藏起 canvas，開關關閉時就不會在背景空轉浪費 GPU。
    rafId = null;
    lastFrameTime = null;
    canvas.style.display = 'none';
  }
}

function startTransition(target) {
  transitionFrom = progress;
  transitionTarget = target;
  transitionStart = performance.now();
  canvas.style.display = 'block';
  if (rafId === null) {
    lastFrameTime = null;
    rafId = requestAnimationFrame(tick);
  }
}

function applyEnabled(enabled) {
  const target = enabled ? 1 : 0;
  if (target === transitionTarget && transitionStart === null) return; // 已經是這個狀態，不用重跑
  startTransition(target);
}

// 等消散動畫真的跑完（canvas 藏起來）才 resolve，給 swapActiveModel() 換模型前
// 用——不能用「等 X 毫秒」這種土法煉鋼，使用者拖曳中會延後消散完成的時間點。
function disperseAndWait() {
  return new Promise((resolve) => {
    applyEnabled(false);
    const check = () => {
      if (transitionTarget === 0 && transitionStart === null && !userInteracting) resolve();
      else requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
}

// 停止模型序列播放，恢復成序列播放前顯示的那個單一模型——currentModelResult
// 在序列播放期間完全沒被動過（見 tick() 裡 sequenceModeActive 那個 if/else 分支），
// 直接重新套用就好，不用重新讀 GLB。window.setParticleSequencePlayback(false)
// 跟下面 swapActiveModel()（序列播放中被叫去換單一模型時，要先把序列收乾淨才能
// 換）都呼叫這個，避免兩處各寫一份「收尾」邏輯。
//
// 注意：這裡不會 dispose sequenceStages（背景預載快取），那份資料是刻意留著
// 整個 session 重複使用的，停止播放不代表要丟掉——下次再觸發直接就有現成的可
// 以播，不用重新讀一次 GLB。真正要 dispose 的只有 sequenceLoadingTexture（如果
// 停止當下背景預載還沒完成、畫面還在顯示 loading 佔位樣式）。

// 「模型序列播放」整段期間唯一的背景音樂（sources.js 的 sequenceBgm）——跟
// sequenceVoice 是兩件不同的事：這個不綁定任何一站，從 loading 佔位圖案結束、
// 真的開始播放第一個模型那一刻起播，到 session 結束才停（見
// advanceSequencePlayback() 裡的呼叫點），中途換模型不會跟著重播或換曲，也不會
// 跟 loading 掃描動畫同時出聲。sequenceBgmAudio 已經有值代表已經在播——
// advanceSequencePlayback() 每幀都會呼叫這裡（見那邊的說明），靠這個判斷式
// 擋掉「已經在播就不重複建立」，不用另外記一個「是不是第一幀」的旗標。
// sequenceBgm 沒填或空字串（resolveAudioUrl() 回傳 null）就整個跳過，不建立
// Audio 物件。
function startSequenceBgm() {
  if (sequenceBgmAudio) return;
  const url = resolveAudioUrl('bgm', configuredSequenceBgm);
  if (!url) return;
  const audio = new Audio(url);
  audio.loop = true;
  audio.addEventListener('error', () => {
    console.error(`[particle-effect] 模型序列播放：sequenceBgm "${configuredSequenceBgm}" 載入失敗，這次不會有背景音樂（檢查 particle-effect/audio/bgm/ 底下有沒有這個檔案）。`);
  });
  audio.play().catch(() => {}); // 同 playSequenceStageVoice()：使用者主動觸發才會走到這裡，理論上不會被自動播放政策擋，接空 catch 保險
  sequenceBgmAudio = audio;
}

function stopSequenceBgm() {
  if (!sequenceBgmAudio) return;
  try {
    sequenceBgmAudio.pause();
  } catch {}
  sequenceBgmAudio = null;
}

function stopSequenceMode() {
  if (!sequenceModeActive) return;
  sequenceModeActive = false;
  stopSequenceBgm();
  if (sequenceLoadingTexture) {
    sequenceLoadingTexture.dispose();
    sequenceLoadingTexture = null;
  }
  // 離開序列播放，加強版轉換效果（每顆粒子時間錯開、burst、尺寸/發光脈衝）跟
  // loading 佔位圖案的掃描顯現也要跟著關掉，不然下一次 animatedIdle／
  // periodicAnimation 的姿勢內插會被誤套用序列播放專屬的效果，見 shaders.js
  // uAnimBlendFX／uLoadingActive 的說明。
  fbo.simulationMaterial.uniforms.uAnimBlendFX.value = 0;
  fbo.renderMaterial.uniforms.uAnimBlendFX.value = 0;
  fbo.renderMaterial.uniforms.uLoadingActive.value = 0;
  if (currentModelResult) {
    applyAnimationState(currentModelResult);
    fbo.renderMaterial.uniforms.uColor.value.copy(currentModelResult.color);
    applyIdleMotionConfig(resolveModel(currentModelKey).idleMotion);
  }
}

// 換成 sources.js 裡另一個模型：如果目前正顯示/正在轉場，先播完整消散動畫、
// 讀新模型取樣完成後再重新聚合，視覺上就是「原本的消散、換了個新的聚合出來」，
// 不是貼圖硬切造成的瞬間位移。modelSwapPending 擋連續快速點選單造成的重疊載入。
async function swapActiveModel(key) {
  if (modelSwapPending) return;
  // 序列播放中如果被叫去換單一模型（例如使用者直接點了模型清單裡的某一項），
  // 先停掉序列、恢復成序列播放前的狀態，再照正常流程換到 key 指定的新模型——
  // 不這樣做的話序列的 uTextureModelA/B/uAnimBlend 還沒清乾淨就會被這次 swap
  // 蓋過去，兩邊互相打架。
  stopSequenceMode();
  modelSwapPending = true;
  try {
    const wasVisible = transitionTarget === 1 || transitionStart !== null;
    if (wasVisible) {
      await disperseAndWait();
    }

    const modelInfo = resolveModel(key);
    const modelResult = await loadModelTexture(modelInfo);

    const oldModelResult = currentModelResult;
    applyAnimationState(modelResult); // 先切到新的（設好 A/B/uAnimBlend、記住新的 currentAnimFrames）...
    disposeModelResult(oldModelResult); // ...再丟舊的，避免舊貼圖還在被 uniform 參照的空檔被提早釋放
    fbo.renderMaterial.uniforms.uColor.value.copy(modelResult.color);
    applyIdleMotionConfig(modelInfo.idleMotion);
    currentModelKey = key;

    if (wasVisible) applyEnabled(true);
  } finally {
    modelSwapPending = false;
  }
}

async function init() {
  setupScene();
  const modelInfo = resolveModel(currentModelKey);
  const modelResult = await loadModelTexture(modelInfo);
  setupParticles(modelResult, modelResult.color);
  applyAnimationState(modelResult); // setupParticles() 已經幫 A/B 設過初始值，這裡主要是記錄 currentAnimFrames/currentModelResult 供之後換模型 dispose 用
  applyIdleMotionConfig(modelInfo.idleMotion);
  ready = true;
  if (pendingEnabled !== null) {
    applyEnabled(pendingEnabled);
    pendingEnabled = null;
  }
  // 「模型序列播放」故意不在這裡預載——sequenceModels 清單可能有好幾個模型、
  // 甚至偏大的檔案，這個功能又不是每次都會用到，App 一開機就無條件在背景讀
  // 是白白佔頻寬/CPU/記憶體。改成真的第一次觸發（Ctrl+Alt+S／系統匣選單）才
  // 呼叫 startSequencePreload()，見 window.setParticleSequencePlayback()。
  //
  // loading 佔位圖案（見 buildSequenceLoadingTexture()）則相反，這裡先在背景
  // 算好——這一步只是畫一次 256×256 canvas＋掃描像素，不牽扯任何網路／檔案
  // I/O，成本跟 sequenceModels 那種可能要讀好幾十 MB GLB 的重工作完全不是
  // 同一個量級，不違反上面「功能沒用到就不要佔資源」的原則。先在這裡把它
  // 準備好，之後任何一次觸發序列播放都能瞬間顯示佔位圖案，不會卡在畫 canvas
  // 這一步（這步在使用者實際按下觸發鍵的當下才做，會讓那一下感覺卡頓，是
  // 之前這個效果做完後實測出來的問題）。用 requestAnimationFrame 讓出這一幀，
  // 不要卡在 init() 主流程完成的同一個 tick 上。
  requestAnimationFrame(() => {
    if (!cachedSequenceLoadingPositions) {
      cachedSequenceLoadingPositions = computeSequenceLoadingPositions(FBO_SIZE * FBO_SIZE);
    }
  });
}

// main.js 的 toggleParticleEffect() 用跟 setExtraPetWander 一樣的
// executeJavaScript 模式呼叫這個全域函式。GLB 還在載入、pipeline 還沒 ready
// 時先記住目標狀態，init() 完成後立刻補套用；回傳值代表「這次呼叫有沒有
// 立刻生效」，跟 toggleExtraPetWander() 判斷 ok 的用法一致。
window.setParticleEffect = function setParticleEffect(enabled) {
  if (!ready) {
    pendingEnabled = enabled;
    return false;
  }
  applyEnabled(enabled);
  return true;
};

// main.js 的 syncParticleEffectEnabledFromRenderer() 在頁面 reload 完後呼叫，讀回
// 「畫面上光粒子特效實際是不是開著」，讓 main.js 自己記的 particleEffectOn（系統匣
// 選單勾選狀態用的那份）能對齊——這個模組每次 reload 都是全新的模組實例，
// transitionTarget 這幾個 let 都會回到宣告時的初始值（0=關閉），沒有任何 reload
// 前的狀態會留下來，所以 F8／套用角色選擇之類觸發的 reload 之後，這裡永遠會回報
// false，除非 pendingEnabled 在 ready 之前就被叫成 true（正常操作流程不會發生：
// pendingEnabled 只有 setParticleEffect() 在 !ready 時才會設，而 reload 後第一時間
// 沒有任何呼叫方會搶在 init() 完成前呼叫它）。跟 getParticleActiveModel() 是同一種
// 「main.js 問 renderer 拿真值，不用在 main.js 那邊猜測/假設 reload 後一定是什麼
// 狀態」的寫法。
window.getParticleEffectEnabled = function getParticleEffectEnabled() {
  return transitionTarget === 1;
};

// main.js 系統匣「光粒子特效」子選單挑模型時呼叫。key 不存在就回傳 false
// （main.js 會印警告），已經是目前這個模型就直接當作成功、不重跑轉場——但序列
// 播放中不能走這條捷徑：currentModelKey 在序列播放期間不會變（見 tick() 的
// sequenceModeActive 分支），如果使用者點的剛好是序列開始前那個模型，這裡如果
// 直接短路回傳 true，會漏掉呼叫 swapActiveModel()／stopSequenceMode()，序列會
// 繼續在背景播、畫面卻已經顯示這個模型被選取，兩邊對不上。
window.setParticleActiveModel = function setParticleActiveModel(key) {
  if (!ready) return false;
  if (!sources[key]) return false;
  if (key === currentModelKey && !modelSwapPending && !sequenceModeActive) return true;
  swapActiveModel(key);
  return true;
};

// main.js 的 syncParticleModelFromRenderer() 在頁面 reload 完後呼叫，讀回「目前
// 真正在用的模型 key」去對齊系統匣選單的勾選狀態，不用在 main.js 那邊重複寫死
// DEFAULT_MODEL 這個預設值。
window.getParticleActiveModel = function getParticleActiveModel() {
  return currentModelKey;
};

// computeSequenceLoadingPositions() 算出來的結果快取在這裡——loading 佔位圖案
// 永遠長一樣（不依賴任何動態資料），沒有必要每次觸發序列播放都重新畫一次
// canvas／重新掃一次像素，見 buildSequenceLoadingTexture() 的說明。
let cachedSequenceLoadingPositions = null;

// 畫出一組「科技 HUD」風格的圖案（等寬字體、加字距的大寫 LOADING、左右取景框
// 括號、外圍兩段缺口弧線，排版概念上像遊戲/介面常見的「資料讀取中」儀表板，
// 不是單純一行純文字），取畫到的像素位置當粒子座標，回傳 Float32Array。
//
// 這裡是獨立於「背景模型載入頓挫」問題之外的優化（那個問題已經證實根源在
// GLTFLoader/MeshSurfaceSampler，跟這個函式完全無關，見開發過程的討論）——單純
// 想讓這個函式本身更輕量。要先說清楚這個函式真正的成本結構：主要成本是
// getImageData() 整張畫布讀回來、再掃一輪全部像素找不透明的位置，這兩步的
// 工作量跟 canvasSize 的平方成正比，**不是跟畫了幾個裝飾元素（括號/讀取環）
// 成正比**——拿掉裝飾元素本身省下來的運算量很有限，真正有意義的槓桿是
// canvasSize。所以這裡把 canvasSize 從 256 降到 192（工作量再省不到一半），
// 同時拿掉讀取環端點的 4 個小方塊裝飾（tick 標記，視覺上是錦上添花，不是核心
// 識別元素），保留 LOADING 文字＋取景框括號＋讀取環弧線這三個組成「這是一個
// 載入指示器」整體輪廓的核心元素。192 對這種只需要看得出輪廓的指示圖案來說
// 還是夠清楚，配合下面的快取（這個函式只會真的跑一次，見
// cachedSequenceLoadingPositions），這步的成本本來就只需要付一次，這次調整
// 幅度不大，是刻意的——不想為了省一個已經很便宜的一次性成本犧牲太多可讀性。
function computeSequenceLoadingPositions(sampleCount) {
  const canvasSize = 192;
  const cx = canvasSize / 2;
  const cy = canvasSize / 2;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = canvasSize;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#ffffff';
  ctx.lineCap = 'round';

  // 主文字：等寬字體＋大寫＋字距，比原本的一般 sans-serif 更有數位儀表板的
  // 「系統讀取中」感覺，不是隨手一行字。letterSpacing 是比較新的 Canvas2D API
  // （Chromium 99+，Electron 這個版本沒問題），用 in 判斷保留舊環境退化路徑。
  ctx.font = 'bold 20px "Consolas", "Courier New", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if ('letterSpacing' in ctx) ctx.letterSpacing = '4px';
  ctx.fillText('LOADING', cx, cy);

  // 左右各一個取景框括號夾住文字（HUD 常見的「這裡是重點資訊」視覺語彙），
  // 半寬用固定值抓一個大致包住 7 個大寫等寬字的距離，不特別靠 measureText()
  // 精算——letterSpacing 在不同引擎的 measureText() 回報不一定準，抓一個
  // 視覺上留有餘裕的數字更省事也更穩。
  const bracketHalfGap = 64;
  const bracketArmV = 11; // 括號垂直臂長
  const bracketArmH = 8; // 括號水平勾長
  ctx.lineWidth = 3;
  [-1, 1].forEach((side) => {
    const x = cx + side * bracketHalfGap;
    ctx.beginPath();
    ctx.moveTo(x - side * bracketArmH, cy - bracketArmV);
    ctx.lineTo(x, cy - bracketArmV);
    ctx.lineTo(x, cy + bracketArmV);
    ctx.lineTo(x - side * bracketArmH, cy + bracketArmV);
    ctx.stroke();
  });

  // 外圍兩段缺口弧線（不是完整的圓，故意留缺口，像儀表板上會轉動的讀取環）
  // 包住文字＋括號，補強「這是一個載入指示器」的整體輪廓，不只是一行字。
  // （原本缺口兩端還有 4 個小方塊 tick 標記，這輪簡化拿掉了——弧線本身的
  // 輪廓已經夠傳達「讀取環」這個概念，tick 標記是錦上添花，不是必要的。）
  const ringRadius = bracketHalfGap + 14; // 縮小讀取環半徑，整體圖案不要那麼大
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, ringRadius, -Math.PI * 0.38, Math.PI * 0.38);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, ringRadius, Math.PI * 0.62, Math.PI * 1.38);
  ctx.stroke();

  const pixels = ctx.getImageData(0, 0, canvasSize, canvasSize).data;
  const litPixels = []; // 攤平存 [x0,y0,x1,y1,...]，避免存一堆小陣列物件的配置開銷
  let minPx = canvasSize;
  let maxPx = 0;
  for (let y = 0; y < canvasSize; y++) {
    for (let x = 0; x < canvasSize; x++) {
      if (pixels[(y * canvasSize + x) * 4 + 3] > 128) {
        litPixels.push(x, y);
        if (x < minPx) minPx = x;
        if (x > maxPx) maxPx = x;
      }
    }
  }

  if (litPixels.length === 0) {
    console.warn('[particle-effect] 模型序列播放：loading 佔位圖案畫不出像素（canvas 渲染異常），改用隨機散點頂著。');
    return null;
  }

  const litPixelCount = litPixels.length / 2;
  const worldScale = 3 / canvasSize; // 大致對齊其他模型 auto-fit 目標尺寸（3 個單位）的視覺大小
  const jitter = worldScale * 1.5; // 同一個文字像素被重複抽到時加一點隨機位移，避免粒子完全疊在同一點

  // 「左到右掃描顯現」動畫（見 advanceSequenceLoadingSweep()）要知道圖案實際的
  // 世界座標 X 範圍才能掃得剛好從最左跑到最右，不是憑空猜一個數字——直接用
  // 上面掃像素時順便記下來的 minPx/maxPx 換算，跟 jitter 的抖動量對齊（往兩邊
  // 各多留半個 jitter，不然邊緣那批粒子的抖動偶爾會被掃描線捲進去/漏出去，
  // 兩端各差一點點）。
  sequenceLoadingBoundsMinX = (minPx - canvasSize / 2) * worldScale - jitter / 2;
  sequenceLoadingBoundsMaxX = (maxPx - canvasSize / 2) * worldScale + jitter / 2;

  const positions = new Float32Array(sampleCount * 3);
  for (let i = 0; i < sampleCount; i++) {
    const pick = Math.floor(Math.random() * litPixelCount) * 2;
    const px = litPixels[pick];
    const py = litPixels[pick + 1];
    positions[i * 3 + 0] = (px - canvasSize / 2) * worldScale + (Math.random() - 0.5) * jitter;
    positions[i * 3 + 1] = -(py - canvasSize / 2) * worldScale + (Math.random() - 0.5) * jitter; // canvas Y 往下、3D Y 往上，取負號翻轉
    positions[i * 3 + 2] = (Math.random() - 0.5) * jitter; // 一點 z 方向厚度，不要整團完全扁平
  }

  return positions;
}

// 「模型序列播放」的載入中佔位樣式，回傳一張可以直接塞進 uTextureModelA/B 的
// DataTexture。實際畫面／取樣工作交給 computeSequenceLoadingPositions()，這裡
// 只負責快取結果（見 cachedSequenceLoadingPositions 宣告處的說明）——同一個
// session 只有第一次呼叫會真的跑 canvas／getImageData／掃像素那一整套，之後
// 每次觸發序列播放都是直接重用同一份位置資料，只需要 positionsToDataTexture()
// 這個很便宜的包裝，不會再卡。刻意保留這一層薄的包裝函式（不直接把快取邏輯
// 攤開在呼叫端）——之後想再換版面（跑馬燈顏色、進度百分比、逐字動畫、六角形
// 網格...），只要改 computeSequenceLoadingPositions() 裡面畫了什麼，呼叫端
// （window.setParticleSequencePlayback()）完全不用跟著改。
function buildSequenceLoadingTexture() {
  const width = FBO_SIZE;
  const height = FBO_SIZE;

  if (!cachedSequenceLoadingPositions) {
    cachedSequenceLoadingPositions = computeSequenceLoadingPositions(width * height);
  }
  if (!cachedSequenceLoadingPositions) {
    return createRandomDataTexture(width, height, SCATTER_SPREAD * 0.5); // canvas 渲染異常時的後備，見上面的說明
  }
  return positionsToDataTexture(cachedSequenceLoadingPositions, width, height);
}

// main.js 系統匣「光粒子特效」子選單的「模型序列播放」項目／全域快捷鍵呼叫。
// 不用 async／不 await 任何東西：
//   1. sequenceStages 已經有值（同一個 session 之前觸發過，快取還在）：直接
//      applyEnabled(true) 開始播放，畫面上是瞬間的，沒有卡頓。
//   2. sequenceStages 還是 null（這個 session 第一次觸發，或上次載入失敗）：
//      先顯示 buildSequenceLoadingTexture() 產生的「loading...」文字佔位樣式
//      頂著，同時呼叫 startSequencePreload() 開始真的去讀 sequenceModels
//      清單（懶載入，只有真的觸發才會讀，見 sequenceStages 宣告處的說明）。
//      advanceSequencePlayback() 每幀都會檢查 sequenceStages 存不存在，一旦
//      背景讀取完成、把 sequenceStages 填好，下一幀就自動接手開始真的播放，
//      不用另外喚醒。
// enabled:false 直接呼叫 stopSequenceMode()。回傳值代表「這次呼叫有沒有成功
// 生效」：還沒 ready、或正好有一般模型切換在進行中（modelSwapPending）都會
// 回傳 false（後者請稍等切換完再試一次，比硬插隊去搶 uniform 安全）。
window.setParticleSequencePlayback = function setParticleSequencePlayback(enabled) {
  if (!ready) return false;
  if (!enabled) {
    stopSequenceMode();
    return true;
  }
  if (sequenceModeActive) return true;
  if (modelSwapPending) return false;

  sequenceModeActive = true;
  sequencePhase = 0;
  // sequenceVoice 觸發狀態也要跟著歸零——不然上次播放 session 結束時 sequenceVoiceLastIndexA
  // 停在某個值，這次重新從 0 開始如果剛好又是同一個 indexA（例如序列只有 2 站，
  // 上次結束在 indexA=0），會被誤判成「已經是這一站，不用重新觸發」，這一輪第
  // 0 站就會漏播語音。見 sequenceVoiceLastIndexA/sequenceVoiceFired 宣告處的說明。
  sequenceVoiceLastIndexA = -1;
  sequenceVoiceFired = false;
  // sequenceBgm 不在這裡播——loading 佔位圖案掃描顯現期間還沒看到真的模型，這時候
  // 先出背景音樂會讓聽覺跟視覺對不起來，改成在 advanceSequencePlayback() 真的開始
  // 播放第一個模型的那一刻才觸發（見那邊的說明）。
  // uAnimBlendFX（見 shaders.js 的說明）不在這裡設——advanceSequencePlayback()
  // 每幀會依「停留段／轉換段」動態開關（停留段播 sequenceAction 時要關掉，
  // 不然動作本身的姿勢內插會被誤套用序列轉換專屬的 burst／脈衝特效），一旦
  // sequenceStages 就緒、真的開始播放，第一幀就會被設成正確的值，這裡不用
  // 先猜一個初始值。

  if (!sequenceStages) {
    sequenceLoadingTexture = buildSequenceLoadingTexture();
    fbo.simulationMaterial.uniforms.uTextureModelA.value = sequenceLoadingTexture;
    fbo.simulationMaterial.uniforms.uTextureModelB.value = sequenceLoadingTexture;
    fbo.simulationMaterial.uniforms.uAnimBlend.value = 0;
    fbo.renderMaterial.uniforms.uColor.value.copy(SEQUENCE_LOADING_COLOR);
    // 每次重新顯示 loading 佔位圖案都從頭開始掃（不延續上次殘留的相位），見
    // advanceSequenceLoadingSweep()。
    sequenceLoadingSweepPhase = 0;
    fbo.renderMaterial.uniforms.uLoadingActive.value = 1;
    fbo.renderMaterial.uniforms.uLoadingSweep.value = sequenceLoadingBoundsMinX;
    startSequencePreload(); // 懶載入：這裡才是真的第一次觸發讀取，不是 App 開機就讀
  }

  applyEnabled(true); // 序列播放隱含「聚合可見」，跟目前是否已經顯示某個模型無關
  return true;
};

// main.js 的 syncParticleSequenceEnabledFromRenderer() 在頁面 reload 完後呼叫，
// 讀回「畫面上模型序列是不是真的在播」，讓系統匣選單的勾選狀態對齊——跟
// getParticleEffectEnabled() 是同一種「main.js 問 renderer 拿真值」的寫法，
// reload 後這個模組是全新實例，sequenceModeActive 一定會回到 false。
window.getParticleSequencePlaying = function getParticleSequencePlaying() {
  return sequenceModeActive;
};

// main.js 的 setClickThrough() 每次切換穿透/互動模式都會呼叫，reload 後
// （did-finish-load）也會補呼叫一次——用途見檔案開頭「移到模型上游標變抓取」
// 那段說明。
window.setParticleEffectInteractiveMode = function setParticleEffectInteractiveMode(enabled) {
  interactiveMode = !!enabled;
  return true;
};

init().catch((err) => {
  console.error('[particle-effect] 初始化失敗：', err);
});
