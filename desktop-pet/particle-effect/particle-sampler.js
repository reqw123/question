// 從 C:\morph-particles\src\Experience\Utils\ParticleSampler.js 移植過來，
// 只留 desktop-pet 用得到的匯出（拿掉 buildParticleTexture 這個原本給
// 「一次 config 直接出貼圖」用的便利包裝，particle-effect.js 自己組 config
// 呼叫 sampleModelToParticles + positionsToDataTexture，跟 morph-particles
// 的 Page.js 用法一致）。
//
// 用 traverse() 走遍整個 GLB 節點樹，不假設固定的 scene.children[N] 結構，
// 所以不管使用者的 GLB 是單一 Mesh、多個 Group（頭髮/武器/配件是平行節點），
// 還是有骨架的 SkinnedMesh 都能吃。取樣失敗時一律回傳 null 並印出清楚的
// console.error/warn，呼叫端（particle-effect.js）負責接手退回隨機散點，
// 這是「使用者還沒放 GLB 進來」時的安全網。
import * as THREE from 'three';
import { MeshSurfaceSampler } from 'three/addons/math/MeshSurfaceSampler.js';

const _vertex = new THREE.Vector3();
const _basePosition = new THREE.Vector3();
const _morphPosition = new THREE.Vector3();

// 把控制權還給瀏覽器一次（等下一次畫面更新才 resolve），給 sampleModelAnimationFrames()
// 逐幀烘焙時用——bakeMeshPositions()／evaluateSurfaceSamples()／applyTransformInPlace()
// 這幾步都是同步、CPU 密集的重工作，一段動畫烘 8~64 張關鍵幀如果中途完全不讓出
// 主執行緒，會卡住整個 render loop 一大段（particle-effect.js 的「模型序列播放」
// 一次觸發要連續烘好幾個模型的動作關鍵幀，沒有逐幀讓出的話，光是幾個模型疊起來
// 就會感覺整個畫面卡死）。這裡不直接用 requestAnimationFrame（particle-sampler.js
// 理論上也可能被純 Node 環境的診斷工具 import，那裡沒有這個全域函式），退化路徑
// 用 setTimeout(resolve, 0)。
function yieldToFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(resolve);
    } else {
      setTimeout(resolve, 0);
    }
  });
}

// sources.js 沒填 scale/position 時的自動置中縮放目標——把模型最長邊縮放成這麼多
// 個單位，跟其他手動校正過的角色模型（aatrox/virgo/...）在畫面上的視覺大小同一個
// 量級（camera fov 45、距原點 4，這個大小站在預設鏡頭距離看起來高度差不多站滿畫面
// 但不會整個超出去）。每個模型也可以用 config.autoFitSize 個別覆寫這個數字。
const AUTO_FIT_TARGET_SIZE = 3;

// 三角形世界座標面積小於這個值視為「退化」，算自動置中縮放的包圍盒時忽略——
// 動機見 computeBounds() 的說明（volibearModel 那次的幽靈頂點問題）。
const DEGENERATE_TRIANGLE_AREA_EPSILON = 1e-5;

// sources.js 的 animationFrames / periodicAnimation.frameCount 沒填時，取代原本
// 寫死 24 張的自動計算目標密度（每秒幾張關鍵幀）——動機見
// sampleModelAnimationFrames() 裡 resolvedFrameCount 那段的說明。這個數字是從
// 幾個手動校正過的案例回推的經驗值：aatroxModel 的 Recall（8.67 秒、24 張≈每秒
// 2.8 張）被判定「夠平滑」，kaidoDragonModel 的 skill_e_1（25 秒、24 張≈每秒不到
// 1 張）被判定「會比較跳」、手動拉到 48 張（≈每秒 1.9 張）才解決——落在這兩個已知
// 案例中間，不是精確算出來的最佳值。
const ANIM_AUTO_FPS = 3;
// 動畫再短也至少烘這麼多張（例如零點幾秒的 cast 動畫，公式算出來可能不到 1 張），
// 避免定時觸發動作或循環動畫看起來像硬切一幀。
const MIN_ANIM_AUTO_FRAMES = 8;
// 動畫再長也最多烘這麼多張，避免公式算出幾百張把記憶體/載入時間炸掉——真的需要
// 更平滑，sources.js 可以用 animationFrames/frameCount 手動覆寫超過這個上限。
const MAX_ANIM_AUTO_FRAMES = 64;

// 算一批 xyz 三連數字（Float32Array）的座標範圍，回傳最小/最大/中心/尺寸，四樣都是
// [x,y,z] 陣列。single pass，n 十幾萬個頂點也不會是效能瓶頸。
//
// 傳了 index（三角形索引）的話，會先過濾掉面積 < DEGENERATE_TRIANGLE_AREA_EPSILON
// 的退化三角形，只用「真正有面積、看得見」的三角形頂點算包圍盒——這是為了修正
// volibearModel 當時發現的問題：有些 GLB（疑似綁在沒有實際網格覆蓋的尾部/物理
// 輔助骨骼上、匯出時沒清乾淨）的 vertex position buffer 裡混了一批不屬於任何
// 三角形、或只屬於退化三角形的「幽靈頂點」，如果直接掃全部頂點座標算包圍盒，
// 這批幽靈頂點會把自動置中縮放的「最長邊」基準灌水，導致真正看得到的網格反而
// 被縮小、粒子沒有確實呈現模型輪廓（見 sources.js volibearModel 註解裡的完整
// 診斷過程——這裡把當時手動跑診斷腳本做的事直接內建進自動置中縮放，不用每次
// 換模型都重新診斷一次）。沒傳 index 就退回掃全部頂點的舊行為（呼叫端沒有索引
// 資料可用時的後備路徑）。
function computeBounds(positions, index) {
  if (!index || index.length < 3) {
    return computeVertexBounds(positions);
  }

  const triCount = index.length / 3;
  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vC = new THREE.Vector3();
  const triangle = new THREE.Triangle();

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let sawValidTriangle = false;

  for (let t = 0; t < triCount; t++) {
    const ia = index[t * 3], ib = index[t * 3 + 1], ic = index[t * 3 + 2];
    vA.fromArray(positions, ia * 3);
    vB.fromArray(positions, ib * 3);
    vC.fromArray(positions, ic * 3);
    triangle.set(vA, vB, vC);
    if (triangle.getArea() < DEGENERATE_TRIANGLE_AREA_EPSILON) continue;
    sawValidTriangle = true;
    minX = Math.min(minX, vA.x, vB.x, vC.x);
    minY = Math.min(minY, vA.y, vB.y, vC.y);
    minZ = Math.min(minZ, vA.z, vB.z, vC.z);
    maxX = Math.max(maxX, vA.x, vB.x, vC.x);
    maxY = Math.max(maxY, vA.y, vB.y, vC.y);
    maxZ = Math.max(maxZ, vA.z, vB.z, vC.z);
  }

  if (!sawValidTriangle) {
    // 理論上不該發生（呼叫端在這之前已經篩掉 index.length<3 的 mesh），保險起見
    // 退回掃全部頂點，不要整個包圍盒變成 Infinity 導致後續縮放算出 NaN。
    return computeVertexBounds(positions);
  }

  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
    size: [maxX - minX, maxY - minY, maxZ - minZ],
  };
}

function computeVertexBounds(positions) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
    center: [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2],
    size: [maxX - minX, maxY - minY, maxZ - minZ],
  };
}

function collectMeshes(root) {
  const meshes = [];
  root.traverse((child) => {
    if (child.isMesh) meshes.push(child);
  });
  return meshes;
}

function bakeMeshPositions(mesh) {
  const geometry = mesh.geometry;
  const posAttr = geometry && geometry.attributes && geometry.attributes.position;

  if (!posAttr || posAttr.count === 0) return null;

  const count = posAttr.count;
  const positions = new Float32Array(count * 3);

  const morphPositions = geometry.morphAttributes && geometry.morphAttributes.position;
  const hasActiveMorph =
    !mesh.isSkinnedMesh &&
    morphPositions &&
    morphPositions.length > 0 &&
    mesh.morphTargetInfluences &&
    mesh.morphTargetInfluences.some((w) => w !== 0);

  if (mesh.isSkinnedMesh) {
    for (let i = 0; i < count; i++) {
      _vertex.fromBufferAttribute(posAttr, i);
      mesh.applyBoneTransform(i, _vertex);
      positions[i * 3 + 0] = _vertex.x;
      positions[i * 3 + 1] = _vertex.y;
      positions[i * 3 + 2] = _vertex.z;
    }
  } else if (hasActiveMorph) {
    const relative = geometry.morphTargetsRelative;
    const influences = mesh.morphTargetInfluences;
    for (let i = 0; i < count; i++) {
      _basePosition.fromBufferAttribute(posAttr, i);
      for (let t = 0; t < morphPositions.length; t++) {
        const weight = influences[t];
        if (!weight) continue;
        _morphPosition.fromBufferAttribute(morphPositions[t], i);
        if (relative) {
          _basePosition.addScaledVector(_morphPosition, weight);
        } else {
          _basePosition.lerp(_morphPosition, weight);
        }
      }
      _vertex.copy(_basePosition).applyMatrix4(mesh.matrixWorld);
      positions[i * 3 + 0] = _vertex.x;
      positions[i * 3 + 1] = _vertex.y;
      positions[i * 3 + 2] = _vertex.z;
    }
  } else {
    for (let i = 0; i < count; i++) {
      _vertex.fromBufferAttribute(posAttr, i).applyMatrix4(mesh.matrixWorld);
      positions[i * 3 + 0] = _vertex.x;
      positions[i * 3 + 1] = _vertex.y;
      positions[i * 3 + 2] = _vertex.z;
    }
  }

  let index;
  if (geometry.index) {
    index = geometry.index.array;
  } else {
    const triCount = Math.floor(count / 3) * 3;
    if (triCount !== count) {
      console.warn(
        `[particle-sampler] mesh "${mesh.name || '(unnamed)'}" 是 non-indexed 但頂點數不是 3 的倍數（${count}），裁掉最後 ${count - triCount} 個。`
      );
    }
    index = new Uint32Array(triCount);
    for (let i = 0; i < triCount; i++) index[i] = i;
  }

  return { positions, index };
}

function applyAnimationPose(resource, config, modelLabel) {
  if (!config.animation) return;

  // animation 可以是陣列（給 animatedIdle/periodicAnimation 用的多段序列格式），但這
  // 條是單幀定格路徑，只認得到「一個」姿勢——陣列的話只取第一個字串。這裡刻意不用
  // THREE.AnimationClip.findByName() 直接吃 config.animation 本身：那個函式內部是拿
  // clip.name === 傳進去的值 做嚴格比對，如果 config.animation 是陣列（例如
  // ['Idle1']），永遠不會等於任何 clip.name 字串，會靜默找不到動畫、退回 bind pose，
  // 跟「陣列第一個字串當單幀定格用」這個文件承諾的行為不符。
  const animationName = Array.isArray(config.animation) ? config.animation[0] : config.animation;
  if (!animationName) return; // 陣列給空陣列這種邊界情況，等同沒填 animation

  const clip = THREE.AnimationClip.findByName(resource.animations || [], animationName);
  if (!clip) {
    const available = (resource.animations || []).map((a) => a.name).join(', ') || '(none)';
    console.warn(
      `[particle-sampler] "${modelLabel}"：找不到動畫 "${animationName}"，改用 bind/rest pose。可用動畫：${available}`
    );
    return;
  }

  const mixer = new THREE.AnimationMixer(resource.scene);
  mixer.clipAction(clip).play();
  mixer.setTime(config.animationTime || 0);
}

// ── 動畫粒子化（多關鍵幀）──────────────────────────────────────────────────
// sampleModelToParticles() 是「取一幀定格」：對整個表面重新隨機取樣一次，聚合出
// 一個固定形狀。這裡的 sampleModelAnimationFrames() 反過來——取樣點（哪個三角形、
// 哪個重心座標）先選好、之後每一幀都原封不動重用同一組，只是跟著骨架換姿勢去算
// 世界座標，這樣同一個粒子索引（同一個 UV）在不同幀永遠對應「模型表面同一個位置」，
// 才會有「同一顆粒子平滑移動」的動畫感——如果每一幀都像 sampleModelToParticles()
// 那樣重新隨機取樣，粒子會像雜訊一樣亂跳，不會看起來像在播動畫。
//
// scale/position/rotation 也只算一次（用 bind pose 的包圍盒或 sources.js 明確填的
// 值），每一幀套用同一組——不然模型會在動畫循環的過程中忽大忽小、跳來跳去。
//
// 目前只有 particle-effect.js 的 loadModelTexture() 在 sources.js 某個模型的
// particle.animatedIdle 開了 true 才會呼叫到這裡，沒開這個開關的模型完全不受
// 影響，繼續走 sampleModelToParticles() 那條單幀定格的路。

// 面積加權的三角形分佈：cumulative[t] 是「前 t+1 個三角形面積總和 / 全部面積」，
// pickSurfaceSamples() 對這個陣列做二分搜尋，模擬跟 MeshSurfaceSampler 同一種
// 「面積越大越容易被選到」的取樣機率分佈。
function buildSurfaceDistribution(positions, index) {
  const triCount = index.length / 3;
  const cumulative = new Float32Array(triCount);
  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vC = new THREE.Vector3();
  const triangle = new THREE.Triangle();
  let total = 0;
  for (let t = 0; t < triCount; t++) {
    vA.fromArray(positions, index[t * 3] * 3);
    vB.fromArray(positions, index[t * 3 + 1] * 3);
    vC.fromArray(positions, index[t * 3 + 2] * 3);
    triangle.set(vA, vB, vC);
    total += triangle.getArea();
    cumulative[t] = total;
  }
  if (total > 0) {
    for (let t = 0; t < triCount; t++) cumulative[t] /= total;
  }
  return { triCount, cumulative, index };
}

// 從面積分佈裡挑 sampleCount 組 (三角形三個頂點索引, 重心座標 u/v/w)，之後每一幀
// 都重用這組結果（見檔案開頭大註解）。重心座標用「u/v 各自均勻亂數、u+v>1 就鏡射
// 回三角形內」這個標準做法，均勻分佈在三角形表面上。
function pickSurfaceSamples(distribution, sampleCount) {
  const { triCount, cumulative, index } = distribution;
  const picks = new Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const r = Math.random();
    let lo = 0;
    let hi = triCount - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    let u = Math.random();
    let v = Math.random();
    if (u + v > 1) {
      u = 1 - u;
      v = 1 - v;
    }
    picks[i] = {
      ia: index[lo * 3],
      ib: index[lo * 3 + 1],
      ic: index[lo * 3 + 2],
      u,
      v,
      w: 1 - u - v,
    };
  }
  return picks;
}

// 用固定的 picks 對「某一幀烘出來的頂點位置」算重心插值，寫進 out（Float32Array，
// 長度 picks.length * 3）。這步不管姿勢變不變，picks 本身都不會變，只有 positions
// （某一幀的頂點世界座標）每一幀不一樣。
function evaluateSurfaceSamples(positions, picks, out) {
  for (let i = 0; i < picks.length; i++) {
    const { ia, ib, ic, u, v, w } = picks[i];
    out[i * 3 + 0] = positions[ia * 3 + 0] * w + positions[ib * 3 + 0] * u + positions[ic * 3 + 0] * v;
    out[i * 3 + 1] = positions[ia * 3 + 1] * w + positions[ib * 3 + 1] * u + positions[ic * 3 + 1] * v;
    out[i * 3 + 2] = positions[ia * 3 + 2] * w + positions[ib * 3 + 2] * u + positions[ic * 3 + 2] * v;
  }
}

// 跟 sampleModelToParticles() 尾段「scale→rotate→translate」是同一套邏輯（沒填
// scale/position 一樣會自動置中縮放，見檔案開頭 AUTO_FIT_TARGET_SIZE 那段），但這裡
// 只算「變換參數」本身，不透過 BufferGeometry.scale()/rotateX/Y/Z()/translate()——
// 每幀都重建一個 BufferGeometry 太浪費，改成算好一組數字，讓 N 幀共用、用純數學
// 套用（applyTransformInPlace()）。referenceBounds 用 bind pose 算，理由見
// sampleModelAnimationFrames() 裡的說明。
function resolveFrameTransform(config, referenceBounds) {
  let sx, sy, sz;
  if (config.scale) {
    [sx, sy, sz] = config.scale;
  } else {
    const maxDimension = Math.max(referenceBounds.size[0], referenceBounds.size[1], referenceBounds.size[2], 1e-6);
    const s = (config.autoFitSize || AUTO_FIT_TARGET_SIZE) / maxDimension;
    sx = sy = sz = s;
  }

  const rotationX = config.rotationX || 0;
  const rotationY = config.rotationY || 0;
  const rotationZ = config.rotationZ || 0;

  let px, py, pz;
  if (config.position) {
    [px, py, pz] = config.position;
  } else {
    const rotatedCenter = new THREE.Vector3(referenceBounds.center[0] * sx, referenceBounds.center[1] * sy, referenceBounds.center[2] * sz);
    if (rotationX) rotatedCenter.applyAxisAngle(new THREE.Vector3(1, 0, 0), rotationX);
    if (rotationY) rotatedCenter.applyAxisAngle(new THREE.Vector3(0, 1, 0), rotationY);
    if (rotationZ) rotatedCenter.applyAxisAngle(new THREE.Vector3(0, 0, 1), rotationZ);
    px = -rotatedCenter.x;
    py = -rotatedCenter.y;
    pz = -rotatedCenter.z;
  }

  return { sx, sy, sz, rotationX, rotationY, rotationZ, px, py, pz };
}

// 直接對 Float32Array 原地套用 scale→rotateX→rotateY→rotateZ→translate（跟
// BufferGeometry 那幾個方法的矩陣運算等價，公式抄自 THREE.Matrix4.makeRotationX/Y/Z
// 展開成純量運算，不用每次都建 Matrix4/Euler 物件——這個函式對 sampleCount×frameCount
// 量級的資料跑，能省則省）。
function applyTransformInPlace(positions, transform) {
  const { sx, sy, sz, rotationX, rotationY, rotationZ, px, py, pz } = transform;
  for (let i = 0; i < positions.length; i += 3) {
    let x = positions[i] * sx;
    let y = positions[i + 1] * sy;
    let z = positions[i + 2] * sz;
    if (rotationX) {
      const c = Math.cos(rotationX);
      const s = Math.sin(rotationX);
      const ny = y * c - z * s;
      const nz = y * s + z * c;
      y = ny;
      z = nz;
    }
    if (rotationY) {
      const c = Math.cos(rotationY);
      const s = Math.sin(rotationY);
      const nx = x * c + z * s;
      const nz = -x * s + z * c;
      x = nx;
      z = nz;
    }
    if (rotationZ) {
      const c = Math.cos(rotationZ);
      const s = Math.sin(rotationZ);
      const nx = x * c - y * s;
      const ny = x * s + y * c;
      x = nx;
      y = ny;
    }
    positions[i] = x + px;
    positions[i + 1] = y + py;
    positions[i + 2] = z + pz;
  }
}

/**
 * 跟 sampleModelToParticles() 是同一套 GLB 表面取樣機制，差在這個會烘出多張
 * 「同一批取樣點、不同動畫時間點姿勢」的位置陣列，讓 particle-effect.js 拿去在
 * GPU 上兩兩內插播放，做出「粒子形狀本身跟著動畫動」的效果（不是 idleMotion 那種
 * 整團平移/旋轉）。
 *
 * config.animation 可以是單一字串，也可以是陣列——陣列時會依序把每段動畫接成一條
 * 連續播放的序列（第一段播完接第二段…最後一段播完，particle-effect.js 的
 * advanceAnimationPlayback() 本來就是拿「總長度」對 animPhase 取模在循環，接好的
 * 序列自然會從最後一段跳回第一段，不用另外改播放端邏輯）。陣列裡每個元素在
 * log/錯誤訊息裡用「第 N 段」稱呼（N 從 1 開始，對應 sources.js 裡寫的順序），
 * 不是從 0 開始的陣列索引，方便回頭對照設定檔。
 *
 * frameCount 是「整條序列的關鍵幀總數預算」，依每段動畫自己的長度佔全部總長度的
 * 比例分配（見下面 clipFrameCounts），不是每段都分到一樣多——不然短動畫的畫面密度
 * 會憑空變高、播起來像被放慢，長動畫則相反像被加速，跟原始動畫記錄的節奏對不上。
 * 陣列只有一個元素（原本單一動畫的用法）時，這個公式算出來就是 frameCount 張
 * 全部給這一段，跟加陣列支援之前的行為完全相容。frameCount 傳 null/undefined
 * （sources.js 的 animationFrames/frameCount 沒填）就依總秒數自動算，見下面
 * resolvedFrameCount 那段的說明，不再是寫死的常數。
 *
 * 找不到任一段動畫、或模型取樣不到表面資料，都會印 console.error 並回傳 null，
 * 呼叫端（particle-effect.js 的 loadModelTexture()）會接手退回單幀定格。
 *
 * 這是 async function：每烘完一張關鍵幀（bakeMeshPositions()／
 * evaluateSurfaceSamples()／applyTransformInPlace() 這幾步都是同步重工作）就
 * await 一次 yieldToFrame()，把控制權還給瀏覽器一次，不會因為一段動畫要烘
 * 8~64 張而整個卡住主執行緒一大段——尤其「模型序列播放」一次觸發要連續烘
 * 好幾個模型的動作關鍵幀，沒有逐幀讓出的話疊起來會很明顯。呼叫端要記得
 * await 這個函式（原本是同步函式，改成 async 之後直接呼叫拿到的是 Promise
 * 不是結果）。
 *
 * 回傳 { frames: Float32Array[], clipDuration }（clipDuration 是全部段落加總的
 * 總長度）或 null。
 */
export async function sampleModelAnimationFrames(resource, config = {}, sampleCount, frameCount, modelLabel = 'model') {
  if (!resource || !resource.scene) {
    console.error(`[particle-sampler] "${modelLabel}"：沒有可用的 glTF scene 可以取樣。`);
    return null;
  }
  if (!config.animation || (Array.isArray(config.animation) && config.animation.length === 0)) {
    console.error(`[particle-sampler] "${modelLabel}"：animatedIdle 開了但沒填 animation，不知道要播哪一段。`);
    return null;
  }

  const animationNames = Array.isArray(config.animation) ? config.animation : [config.animation];
  const clips = [];
  for (let i = 0; i < animationNames.length; i++) {
    const name = animationNames[i];
    const clip = THREE.AnimationClip.findByName(resource.animations || [], name);
    if (!clip) {
      const available = (resource.animations || []).map((a) => a.name).join(', ') || '(none)';
      console.error(
        `[particle-sampler] "${modelLabel}"：找不到動畫 "${name}"（animation 陣列第 ${i + 1} 段），animatedIdle 沒辦法生效。可用動畫：${available}`
      );
      return null;
    }
    clips.push(clip);
  }

  const scene = resource.scene;
  scene.updateMatrixWorld(true); // 這裡還沒碰 mixer，就是 bind/rest pose

  const meshes = collectMeshes(scene);
  if (meshes.length === 0) {
    console.error(`[particle-sampler] "${modelLabel}"：GLB 節點樹裡沒有 Mesh/SkinnedMesh，沒東西可以變粒子。`);
    return null;
  }

  // bind pose 先烘一次，只為了兩件事：1) 決定取樣點（面積加權挑三角形+重心座標，
  // 拓樸不會因為動畫改變，選一次就夠）；2) 沒填 scale/position 時，算自動置中縮放
  // 用的參考包圍盒——用「站定的 bind pose」當參考，跟這幾個模型原本沒開動畫粒子化
  // 時單幀定格所用的框架大小一致，不會因為開了動畫粒子化而尺寸感覺忽然變了。
  const bindMeshes = [];
  let totalVerts = 0;
  let totalTriIndices = 0;
  for (const mesh of meshes) {
    const baked = bakeMeshPositions(mesh);
    if (!baked) {
      console.warn(`[particle-sampler] "${modelLabel}"：mesh "${mesh.name || '(unnamed)'}" 沒有 position attribute，略過。`);
      continue;
    }
    if (baked.index.length < 3) {
      console.warn(`[particle-sampler] "${modelLabel}"：mesh "${mesh.name || '(unnamed)'}" 沒有三角形，略過。`);
      continue;
    }
    bindMeshes.push(mesh);
    totalVerts += baked.positions.length / 3;
    totalTriIndices += baked.index.length;
  }
  if (bindMeshes.length === 0) {
    console.error(`[particle-sampler] "${modelLabel}"：找到 ${meshes.length} 個 mesh，但沒有一個有可用的三角形資料。`);
    return null;
  }

  // 重新烘一次（上面那輪只是為了篩掉沒用的 mesh、算 totalVerts/totalTriIndices），
  // 這次真的組成 mergedPositions/mergedIndex——多烘一次 bind pose 的成本可忽略，
  // 換來程式碼不用另外存一份「篩選後的中間結果」。
  const bindPositions = new Float32Array(totalVerts * 3);
  const mergedIndex = new Uint32Array(totalTriIndices);
  let vertexOffset = 0;
  let indexOffset = 0;
  for (const mesh of bindMeshes) {
    const baked = bakeMeshPositions(mesh);
    bindPositions.set(baked.positions, vertexOffset * 3);
    for (let i = 0; i < baked.index.length; i++) mergedIndex[indexOffset + i] = baked.index[i] + vertexOffset;
    vertexOffset += baked.positions.length / 3;
    indexOffset += baked.index.length;
  }

  const distribution = buildSurfaceDistribution(bindPositions, mergedIndex);
  const picks = pickSurfaceSamples(distribution, sampleCount);

  const needsAutoFit = !config.scale || !config.position;
  const referenceBounds = needsAutoFit ? computeBounds(bindPositions, mergedIndex) : { size: [0, 0, 0], center: [0, 0, 0] };
  if (needsAutoFit) {
    console.log(
      `[particle-sampler] "${modelLabel}"：animatedIdle 自動置中縮放（bind pose 包圍盒尺寸 [${referenceBounds.size
        .map((n) => n.toFixed(2))
        .join(', ')}]，中心 [${referenceBounds.center.map((n) => n.toFixed(2)).join(', ')}]）。`
    );
  }
  const transform = resolveFrameTransform(config, referenceBounds);

  // 每段動畫依自己長度佔全部總長度的比例分配關鍵幀數量（見函式開頭大註解）。最後
  // 一段吃掉「frameCount 減掉前面已分配的張數」，不是自己再算一次比例——避免四捨
  // 五入誤差累積下來，讓實際烘出的總張數跟 frameCount 兜不起來。每段至少 1 張
  // （Math.max(1, ...)），如果段數很多、frameCount 又設得很小，實際烘出的總張數
  // 可能會超過 frameCount——寧可每段都至少留一張代表畫面，也不要有段落被無條件
  // 捨去到 0 張、直接從序列裡消失。
  const totalDuration = clips.reduce((sum, c) => sum + (c.duration || 0), 0) || 1;

  // frameCount 沒填就依總秒數自動算，取代原本寫死的 24——固定值在很短的動畫上
  // 密度過剩（例如 yasuoModel 的 Spell4 只有 1.97 秒，24 張等於每秒 12 張，明顯
  // 浪費），在很長的動畫上又密度不足（kaidoDragonModel 的 skill_e_1 長達 25 秒，
  // 24 張等於每秒不到 1 張，播起來會跳，當時是手動加到 48 張才解決）。公式跟
  // MIN/MAX 兩個常數的說明見檔案開頭 ANIM_AUTO_FPS 那段。這條公式量不出「動作
  // 快不快、動幅大不大」，這種細節還是得開特效實際看一次，覺得不夠平滑再用
  // animationFrames/frameCount 手動覆寫，見 sources.js 開頭說明。
  const resolvedFrameCount =
    frameCount != null
      ? frameCount
      : Math.min(MAX_ANIM_AUTO_FRAMES, Math.max(MIN_ANIM_AUTO_FRAMES, Math.round(totalDuration * ANIM_AUTO_FPS)));
  if (frameCount == null) {
    console.log(
      `[particle-sampler] "${modelLabel}"：animationFrames/frameCount 沒填，依總秒數（${totalDuration.toFixed(2)}s）自動算出 ${resolvedFrameCount} 張關鍵幀。`
    );
  }

  let allocated = 0;
  const clipFrameCounts = clips.map((clip, i) => {
    const dur = clip.duration || 0;
    const count =
      i === clips.length - 1
        ? Math.max(1, resolvedFrameCount - allocated)
        : Math.max(1, Math.round(resolvedFrameCount * (dur / totalDuration)));
    allocated += count;
    return count;
  });

  const mixer = new THREE.AnimationMixer(scene);
  const frames = [];
  const frameBuffer = new Float32Array(totalVerts * 3);
  let previousAction = null;

  for (let c = 0; c < clips.length; c++) {
    const clip = clips[c];
    const clipFrameCount = clipFrameCounts[c];
    const clipDuration = clip.duration || 0;

    // 換下一段前先停掉上一段的 AnimationAction——AnimationMixer 允許多個 action
    // 同時作用、依權重疊加，不停掉的話下一段動畫的骨架姿勢會跟上一段殘留的權重
    // 混在一起算，不是乾淨切換。
    if (previousAction) previousAction.stop();
    const action = mixer.clipAction(clip);
    action.reset();
    action.play();
    previousAction = action;

    for (let f = 0; f < clipFrameCount; f++) {
      // 均勻分佈在這一段動畫裡（不包含 clipDuration 那個端點本身）——這樣這一段
      // 的最後一幀跟下一段的第一幀之間的間隔，跟段落內部相鄰幀間隔一致，銜接處
      // 播放速度才不會忽快忽慢。
      const time = (f / clipFrameCount) * clipDuration;
      mixer.setTime(time);
      scene.updateMatrixWorld(true);

      const tFrameStart = typeof performance !== 'undefined' ? performance.now() : 0;
      let offset = 0;
      for (const mesh of bindMeshes) {
        const baked = bakeMeshPositions(mesh);
        frameBuffer.set(baked.positions, offset * 3);
        offset += baked.positions.length / 3;
      }
      const tBaked = typeof performance !== 'undefined' ? performance.now() : 0;

      const framePositions = new Float32Array(sampleCount * 3);
      evaluateSurfaceSamples(frameBuffer, picks, framePositions);
      applyTransformInPlace(framePositions, transform);
      frames.push(framePositions);

      if (typeof performance !== 'undefined') {
        const tDone = performance.now();
        console.log(
          `[particle-sampler][序列計時] ${modelLabel} 第 ${f + 1}/${clipFrameCount} 幀：bakeMeshPositions ${(tBaked - tFrameStart).toFixed(1)}ms + evaluateSurfaceSamples/transform ${(tDone - tBaked).toFixed(1)}ms`
        );
      }

      await yieldToFrame(); // 見函式開頭的說明——每張關鍵幀之間都讓出主執行緒一次
    }
  }
  if (previousAction) previousAction.stop();

  return { frames, clipDuration: totalDuration };
}

/**
 * 把一個 GLTF resource（{ scene, animations }）的整個表面（依三角形面積加權）
 * 取樣成 sampleCount 個粒子位置，套用 config 的 scale/position/rotation。
 * 回傳 Float32Array（長度 sampleCount * 3）或 null（取樣不到東西時）。
 */
export function sampleModelToParticles(resource, config = {}, sampleCount, modelLabel = 'model') {
  if (!resource || !resource.scene) {
    console.error(`[particle-sampler] "${modelLabel}"：沒有可用的 glTF scene 可以取樣。`);
    return null;
  }

  const scene = resource.scene;

  applyAnimationPose(resource, config, modelLabel);
  scene.updateMatrixWorld(true);

  const meshes = collectMeshes(scene);
  if (meshes.length === 0) {
    console.error(`[particle-sampler] "${modelLabel}"：GLB 節點樹裡沒有 Mesh/SkinnedMesh，沒東西可以變粒子。`);
    return null;
  }

  const baked = [];
  let totalVerts = 0;
  let totalTriIndices = 0;

  for (const mesh of meshes) {
    const result = bakeMeshPositions(mesh);
    if (!result) {
      console.warn(`[particle-sampler] "${modelLabel}"：mesh "${mesh.name || '(unnamed)'}" 沒有 position attribute，略過。`);
      continue;
    }
    if (result.index.length < 3) {
      console.warn(`[particle-sampler] "${modelLabel}"：mesh "${mesh.name || '(unnamed)'}" 沒有三角形，略過。`);
      continue;
    }
    baked.push(result);
    totalVerts += result.positions.length / 3;
    totalTriIndices += result.index.length;
  }

  if (baked.length === 0) {
    console.error(`[particle-sampler] "${modelLabel}"：找到 ${meshes.length} 個 mesh，但沒有一個有可用的三角形資料。`);
    return null;
  }

  const mergedPositions = new Float32Array(totalVerts * 3);
  const mergedIndex = new Uint32Array(totalTriIndices);
  let vertexOffset = 0;
  let indexOffset = 0;
  for (const { positions, index } of baked) {
    mergedPositions.set(positions, vertexOffset * 3);
    for (let i = 0; i < index.length; i++) {
      mergedIndex[indexOffset + i] = index[i] + vertexOffset;
    }
    vertexOffset += positions.length / 3;
    indexOffset += index.length;
  }

  const mergedGeometry = new THREE.BufferGeometry();
  mergedGeometry.setAttribute('position', new THREE.BufferAttribute(mergedPositions, 3));
  mergedGeometry.setIndex(new THREE.BufferAttribute(mergedIndex, 1));

  const sampler = new MeshSurfaceSampler(new THREE.Mesh(mergedGeometry)).build();

  const sampled = new Float32Array(sampleCount * 3);
  const samplePoint = new THREE.Vector3();
  for (let i = 0; i < sampleCount; i++) {
    sampler.sample(samplePoint);
    sampled[i * 3 + 0] = samplePoint.x;
    sampled[i * 3 + 1] = samplePoint.y;
    sampled[i * 3 + 2] = samplePoint.z;
  }

  const placed = new THREE.BufferGeometry();
  placed.setAttribute('position', new THREE.BufferAttribute(sampled, 3));

  // sources.js 沒填 scale/position 就自動置中縮放，不用像 mordekaiserModel（file:
  // 1.glb）那次一樣手動拿 Box3 量出包圍盒才知道怎麼校正——用 mergedPositions
  // （縮放/旋轉/平移前、取樣前的原始表面頂點，跟包圍盒無關的取樣誤差影響）算出這顆
  // GLB 實際的世界座標尺寸，換算成「最長邊縮放成 AUTO_FIT_TARGET_SIZE 個單位、中心
  // 搬回原點」的 scale/position，效果跟手動校正的算法一模一樣。只要 sources.js 明確
  // 填了 scale 或 position 中任何一個，就完全照填的值走，不會被這裡蓋掉。
  //
  // 包圍盒算法會過濾掉退化三角形（見 computeBounds() 說明）——volibearModel 那次
  // 手動診斷出來的「幽靈頂點灌水自動置中縮放基準」問題，已經內建進這裡，不用每次
  // 換模型遇到縮小/位置跑掉都重新診斷一次。
  const needsAutoScale = !config.scale;
  const needsAutoPosition = !config.position;
  let autoScale = null;
  let autoBounds = null; // 分開存，不能掛在 autoScale（number 是 primitive，strict mode 底下掛屬性會直接噴 TypeError）
  if (needsAutoScale || needsAutoPosition) {
    autoBounds = computeBounds(mergedPositions, mergedIndex);
    const maxDimension = Math.max(autoBounds.size[0], autoBounds.size[1], autoBounds.size[2], 1e-6);
    const targetSize = config.autoFitSize || AUTO_FIT_TARGET_SIZE;
    autoScale = targetSize / maxDimension;
    console.log(
      `[particle-sampler] "${modelLabel}"：sources.js 沒填 ${needsAutoScale ? 'scale' : ''}${needsAutoScale && needsAutoPosition ? '/' : ''}${needsAutoPosition ? 'position' : ''}，自動置中縮放（原始包圍盒尺寸 [${autoBounds.size.map((n) => n.toFixed(2)).join(', ')}]，中心 [${autoBounds.center.map((n) => n.toFixed(2)).join(', ')}]，目標最長邊 ${targetSize} 個單位）。`
    );
  }

  const [sx, sy, sz] = config.scale || [autoScale, autoScale, autoScale];
  placed.scale(sx, sy, sz);
  if (config.rotationX) placed.rotateX(config.rotationX);
  if (config.rotationY) placed.rotateY(config.rotationY);
  if (config.rotationZ) placed.rotateZ(config.rotationZ);

  let px, py, pz;
  if (config.position) {
    [px, py, pz] = config.position;
  } else {
    // 自動置中：把「套用同一組 scale + rotation 之後」的包圍盒中心搬回原點——跟
    // BufferGeometry.scale()/rotateX/Y/Z() 對 placed 做的是同一套變換，用 Vector3
    // 在旁邊重算一次中心點該落在哪，而不是直接對 placed 整個做 Box3（省一次全量掃描）。
    const bounds = autoBounds;
    const rotatedCenter = new THREE.Vector3(bounds.center[0] * sx, bounds.center[1] * sy, bounds.center[2] * sz);
    if (config.rotationX) rotatedCenter.applyAxisAngle(new THREE.Vector3(1, 0, 0), config.rotationX);
    if (config.rotationY) rotatedCenter.applyAxisAngle(new THREE.Vector3(0, 1, 0), config.rotationY);
    if (config.rotationZ) rotatedCenter.applyAxisAngle(new THREE.Vector3(0, 0, 1), config.rotationZ);
    px = -rotatedCenter.x;
    py = -rotatedCenter.y;
    pz = -rotatedCenter.z;
  }
  placed.translate(px, py, pz);

  return sampled;
}

// ── 診斷 ────────────────────────────────────────────────────────────────
// 給 tools/inspect-model.mjs 這支命令列工具用：量出一顆 GLB 的真實包圍盒、
// 動畫清單、疑似重複部位，取代之前每次換模型（例如 volibearModel 那次）都要
// 臨時寫一次性 Node 腳本診斷的做法。內部直接呼叫跟 sampleModelToParticles()
// 同一套 collectMeshes()/bakeMeshPositions()/computeBounds()（含退化三角形
// 過濾），量出來的包圍盒保證跟實際套用到 sources.js 之後、particle-effect.js
// 真正渲染出來的自動置中縮放結果一致，不會有「診斷工具算一套、實際套用又是
// 另一套」的落差。
//
// 回傳 null 並印 console.error 的情況跟其他 sample* 函式一致：沒有 scene、或
// 完全沒有可用的三角形資料。
//
// 回傳 { meshes, totalTriangles, realBounds, autoFit, animations, duplicateGroups }：
//   meshes:          每個 mesh 的 { name, isSkinned, vertexCount, triangleCount, bounds }，
//                     bounds 是這個 mesh 自己的原始頂點包圍盒（未過濾退化三角形——
//                     這裡只是拿來當「疑似重複部位」的比對指紋，不是拿來算縮放）。
//   totalTriangles:  全部 mesh 的三角形數總和。
//   realBounds:      bind/rest pose 下，過濾退化三角形後的真實包圍盒，格式跟
//                     computeBounds() 一樣（{min,max,center,size}）。
//   autoFit:          { scale, position }——照 realBounds 換算出來的建議值，公式
//                     跟 sampleModelToParticles() 尾段自動置中縮放完全一樣，但
//                     沒有套 rotationY。等同「完全不填 scale/position」時執行期
//                     會自動算出的結果，多數情況下印出來只是給你確認數字合理，
//                     不一定要真的貼進 sources.js（見 tools/inspect-model.mjs
//                     印出來的提醒）。
//   animations:      [{ name, duration }]，照 gltf.animations 原始順序。
//   duplicateGroups: 疑似重複部位的 mesh 分組（vertexCount 跟原始包圍盒都幾乎
//                     一樣，四捨五入到小數點後兩位比對），每組是 mesh 名稱陣列；
//                     沒有疑似重複就是空陣列。純啟發式，可能誤報形狀剛好對稱的
//                     正常網格，也可能漏掉真正的重複（比如頂點數不完全一樣的
//                     LOD 變體），僅供參考，不是權威判斷——真的要確認還是得看
//                     實際渲染效果或另外開模型檢視軟體比對。
export function inspectModel(resource, modelLabel = 'model') {
  if (!resource || !resource.scene) {
    console.error(`[particle-sampler] "${modelLabel}"：沒有可用的 glTF scene 可以診斷。`);
    return null;
  }

  const scene = resource.scene;
  scene.updateMatrixWorld(true);

  const meshes = collectMeshes(scene);
  const meshReports = [];
  const bakedList = [];
  for (const mesh of meshes) {
    const baked = bakeMeshPositions(mesh);
    if (!baked || baked.index.length < 3) continue;
    meshReports.push({
      name: mesh.name || '(unnamed)',
      isSkinned: !!mesh.isSkinnedMesh,
      vertexCount: baked.positions.length / 3,
      triangleCount: baked.index.length / 3,
      bounds: computeVertexBounds(baked.positions), // 只當比對指紋用，不是縮放依據
    });
    bakedList.push(baked);
  }

  if (bakedList.length === 0) {
    console.error(`[particle-sampler] "${modelLabel}"：找到 ${meshes.length} 個 mesh，但沒有一個有可用的三角形資料。`);
    return null;
  }

  let totalVerts = 0;
  let totalTriIndices = 0;
  for (const baked of bakedList) {
    totalVerts += baked.positions.length / 3;
    totalTriIndices += baked.index.length;
  }
  const mergedPositions = new Float32Array(totalVerts * 3);
  const mergedIndex = new Uint32Array(totalTriIndices);
  let vertexOffset = 0;
  let indexOffset = 0;
  for (const baked of bakedList) {
    mergedPositions.set(baked.positions, vertexOffset * 3);
    for (let i = 0; i < baked.index.length; i++) mergedIndex[indexOffset + i] = baked.index[i] + vertexOffset;
    vertexOffset += baked.positions.length / 3;
    indexOffset += baked.index.length;
  }

  const realBounds = computeBounds(mergedPositions, mergedIndex);
  const maxDimension = Math.max(realBounds.size[0], realBounds.size[1], realBounds.size[2], 1e-6);
  const autoScale = AUTO_FIT_TARGET_SIZE / maxDimension;
  const autoFit = {
    scale: [autoScale, autoScale, autoScale],
    position: [
      -realBounds.center[0] * autoScale,
      -realBounds.center[1] * autoScale,
      -realBounds.center[2] * autoScale,
    ],
  };

  const animations = (resource.animations || []).map((a) => ({ name: a.name, duration: a.duration || 0 }));

  const signatureGroups = new Map();
  for (const m of meshReports) {
    const sig = `${m.vertexCount}|${m.bounds.min.map((n) => n.toFixed(2)).join(',')}|${m.bounds.max.map((n) => n.toFixed(2)).join(',')}`;
    if (!signatureGroups.has(sig)) signatureGroups.set(sig, []);
    signatureGroups.get(sig).push(m.name);
  }
  const duplicateGroups = [...signatureGroups.values()].filter((names) => names.length > 1);

  const totalTriangles = meshReports.reduce((sum, m) => sum + m.triangleCount, 0);

  return { meshes: meshReports, totalTriangles, realBounds, autoFit, animations, duplicateGroups };
}

// ── 自動取色 ────────────────────────────────────────────────────────────
// sources.js 沒填 color 時的自動取色：直接讀 GLB 材質的平均色，讓粒子顏色貼近
// 角色原本的配色，不用每顆新模型都手動挑一個顏色。
const COLOR_SAMPLE_SIZE = 8; // 縮到 8x8 再平均，不需要精確，夠代表整張貼圖的主色調

let sharedColorSampleCtx = null;
function getColorSampleCtx() {
  // particle-sampler.js 只在瀏覽器/Electron renderer 端跑（見檔案開頭說明），
  // 但這個 guard 讓純 Node 環境（例如診斷用腳本）import 這支檔案時不會直接炸掉，
  // 會自然退回下面 sampleMaterialColor() 的 baseColorFactor 分支。
  if (typeof document === 'undefined') return null;
  if (!sharedColorSampleCtx) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = COLOR_SAMPLE_SIZE;
    sharedColorSampleCtx = canvas.getContext('2d', { willReadFrequently: true });
  }
  return sharedColorSampleCtx;
}

// 單一材質的代表色：優先讀 baseColor 貼圖（大多數角色模型的顏色資訊都畫在貼圖
// 裡，baseColorFactor 常常只是 glTF 預設的全白 [1,1,1,1]，沒有代表性）——把貼圖
// 縮小畫到一張共用的 8x8 canvas 上再平均取色，比逐像素掃原始解析度貼圖快很多，
// 對「大致貼近角色配色」這個粗略用途也已經夠準。貼圖不存在、或畫布不可用（Node
// 環境）時退回 material.color（baseColorFactor）本身。回傳 [r,g,b]（0-1）或 null。
function sampleMaterialColor(material) {
  const map = material.map;
  const ctx = map && map.image ? getColorSampleCtx() : null;
  if (ctx) {
    try {
      ctx.clearRect(0, 0, COLOR_SAMPLE_SIZE, COLOR_SAMPLE_SIZE);
      ctx.drawImage(map.image, 0, 0, COLOR_SAMPLE_SIZE, COLOR_SAMPLE_SIZE);
      const { data } = ctx.getImageData(0, 0, COLOR_SAMPLE_SIZE, COLOR_SAMPLE_SIZE);
      let r = 0, g = 0, b = 0, weight = 0;
      for (let i = 0; i < data.length; i += 4) {
        const alpha = data[i + 3] / 255;
        if (alpha <= 0) continue; // 全透明像素（貼圖邊緣留白之類）不計入平均
        r += data[i] * alpha;
        g += data[i + 1] * alpha;
        b += data[i + 2] * alpha;
        weight += alpha;
      }
      if (weight > 0) return [r / weight / 255, g / weight / 255, b / weight / 255];
    } catch (err) {
      // Canvas 讀貼圖失敗（例如 CORS、圖片格式 three.js 不支援 drawImage）不是
      // 致命錯誤，往下退回 baseColorFactor 即可，印個 warning 方便之後排查。
      console.warn(
        `[particle-sampler] 貼圖取色失敗，改用 baseColorFactor：${err && err.message ? err.message : err}`
      );
    }
  }
  if (material.color) return [material.color.r, material.color.g, material.color.b];
  return null;
}

/**
 * 從整個 GLB 的所有材質取平均色，當作 sources.js 沒填 color 時的自動預設值。
 * 多個材質時不分權重直接平均（不特別按網格表面積加權）——這個功能本來就只是
 * 「大致貼近角色配色」，不是要精確重現原始渲染結果，加權會讓函式複雜很多、
 * 換不到明顯更好的結果。取不到任何材質顏色（例如全部材質都叫 "None" 又沒有
 * 貼圖，像 superheroSculptModel 那顆雕塑）就印一句 warning 並回傳 null，呼叫端
 * （particle-effect.js 的 loadModelTexture()）接手退回 DEFAULT_COLOR。
 */
export function sampleAverageMaterialColor(resource, modelLabel = 'model') {
  if (!resource || !resource.scene) return null;

  const materials = new Set();
  resource.scene.traverse((child) => {
    if (!child.isMesh || !child.material) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const m of mats) materials.add(m);
  });
  if (materials.size === 0) return null;

  let r = 0, g = 0, b = 0, count = 0;
  for (const material of materials) {
    const sampled = sampleMaterialColor(material);
    if (!sampled) continue;
    r += sampled[0];
    g += sampled[1];
    b += sampled[2];
    count++;
  }

  if (count === 0) {
    console.warn(`[particle-sampler] "${modelLabel}"：自動取色找不到可用的材質顏色，改用預設色。`);
    return null;
  }
  return [r / count, g / count, b / count];
}

/** 把 xyz 位置陣列打包成 FBO shader 用的 RGBA float DataTexture。 */
export function positionsToDataTexture(positions, width, height) {
  const data = new Float32Array(width * height * 4);
  const count = Math.min(positions.length / 3, width * height);

  for (let i = 0; i < count; i++) {
    data[i * 4 + 0] = positions[i * 3 + 0];
    data[i * 4 + 1] = positions[i * 3 + 1];
    data[i * 4 + 2] = positions[i * 3 + 2];
    data[i * 4 + 3] = 0;
  }

  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
  texture.needsUpdate = true;
  return texture;
}

/** 模型取樣失敗時的備援：隨機散點貼圖，讓整條 FBO pipeline 照樣能跑。 */
export function createRandomDataTexture(width, height, size) {
  const data = new Float32Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4 + 0] = (Math.random() - 0.5) * size;
    data[i * 4 + 1] = (Math.random() - 0.5) * size;
    data[i * 4 + 2] = (Math.random() - 0.5) * size;
    data[i * 4 + 3] = 0;
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
  texture.needsUpdate = true;
  return texture;
}
