// 命令列診斷工具：量測一顆 GLB 的真實包圍盒（過濾退化三角形）、動畫 clip 清單、
// 疑似重複部位，印出可以直接參考來填 sources.js 新 entry 的數字。取代之前每次
// 換模型都要臨時寫一次性 Node 腳本診斷的做法（見 sources.js volibearModel 註解
// 裡記錄的那次手動診斷過程）——這裡呼叫的 particle-sampler.js 的 inspectModel()
// 跟實際跑特效時用的是同一套 computeBounds()（含退化三角形過濾），量出來的數字
// 保證跟真正套用到 sources.js 之後、particle-effect.js 實際渲染出來的大小一致。
//
// 用法：
//   node particle-effect/tools/inspect-model.mjs <檔名或路徑>
//   檔名不含路徑分隔符號時，預設去 particle-effect/models/ 底下找（跟 sources.js
//   的 file 欄位同一個資料夾）；也可以直接給完整/相對路徑。
//
// 只做唯讀的量測跟印報告，不會寫入 sources.js——把印出來的數字自己貼進去，或把
// 整段報告丟給 Claude 讀，讓它幫忙把新 entry 填好（跟這次幫 volibearModel 填
// 參數是同一套流程，只是量測這一步不用再臨時寫腳本）。
//
// Node 沒有 document/canvas，貼圖平均色（sampleAverageMaterialColor() 的貼圖
// 路徑）在這裡測不出來，只能列 baseColorFactor；真正的自動取色要在 Electron/
// 瀏覽器裡實際跑特效才會生效，見下面「取色」那段的說明。
globalThis.self = globalThis; // GLTFLoader 在 Node 沒有 self，先墊一個讓它不要一開始就炸
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectModel } from '../particle-sampler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = path.join(__dirname, '..', 'models');

const arg = process.argv[2];
if (!arg) {
  console.error('用法：node particle-effect/tools/inspect-model.mjs <models/ 底下的檔名，或完整/相對路徑>');
  process.exit(1);
}

const filePath = arg.includes('/') || arg.includes('\\') || path.isAbsolute(arg) ? arg : path.join(MODELS_DIR, arg);

if (!fs.existsSync(filePath)) {
  console.error(`找不到檔案：${filePath}`);
  process.exit(1);
}

const buf = fs.readFileSync(filePath);
const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const label = path.basename(filePath);

const loader = new GLTFLoader();
loader.parse(
  arrayBuffer,
  '',
  (gltf) => {
    const report = inspectModel(gltf, label);
    if (!report) {
      console.error('診斷失敗（見上面錯誤訊息）。');
      process.exit(1);
    }

    console.log(`\n=== ${label} ===`);
    console.log(`mesh 數：${report.meshes.length}（skinned：${report.meshes.filter((m) => m.isSkinned).length}）`);
    console.log(`三角形總數：${report.totalTriangles}`);

    console.log('\n-- mesh 清單 --');
    for (const m of report.meshes) {
      console.log(`  ${m.name}${m.isSkinned ? ' [skinned]' : ''}：${m.vertexCount} 頂點 / ${m.triangleCount} 三角形`);
    }

    if (report.duplicateGroups.length > 0) {
      console.log(
        '\n⚠️ 疑似重複部位（vertexCount + 原始包圍盒幾乎一樣，可能是同一部位的替代狀態如換臉/' +
          '換手，或單純是同一份幾何體重複匯出——只是啟發式偵測，實際性質要自己判斷，可以參考' +
          ' sources.js 裡 kaidoModel/volibearModel 的註解）：'
      );
      for (const group of report.duplicateGroups) {
        console.log(`  [${group.join(', ')}]`);
      }
    }

    console.log('\n-- 真實包圍盒（bind/rest pose，已過濾退化三角形）--');
    console.log(`  min:    [${report.realBounds.min.map((n) => n.toFixed(3)).join(', ')}]`);
    console.log(`  max:    [${report.realBounds.max.map((n) => n.toFixed(3)).join(', ')}]`);
    console.log(`  center: [${report.realBounds.center.map((n) => n.toFixed(3)).join(', ')}]`);
    console.log(`  size:   [${report.realBounds.size.map((n) => n.toFixed(3)).join(', ')}]`);

    console.log('\n-- 自動置中縮放會算出的結果（沒套 rotationY）--');
    console.log(`  scale: [${report.autoFit.scale.map((n) => n.toFixed(4)).join(', ')}]`);
    console.log(`  position: [${report.autoFit.position.map((n) => n.toFixed(3)).join(', ')}]`);
    console.log('  ⚠️ 這組數字就是「sources.js 完全不填 scale/position」時 particle-sampler.js 執行期');
    console.log('     會自動算出來的結果（同一套 computeBounds()）——多數情況下可以直接不填這兩欄讓它');
    console.log('     自動算，不用真的貼進 sources.js。只有想避免 animatedIdle 不同姿勢重算 auto-fit');
    console.log('     可能不一樣導致觸發時跳一下、或想手動再微調，才需要真的填死這兩個數字。如果模型');
    console.log('     背對鏡頭要轉向（填 rotationY），position 要照「先縮放、再旋轉」重算——參考');
    console.log('     sources.js volibearModel 註解裡的算法，不能直接沿用這裡印的 position。');

    if (report.animations.length > 0) {
      console.log(`\n-- 動畫清單（共 ${report.animations.length} 段，可參考挑選 animation/periodicAnimation.name）--`);
      report.animations.forEach((a, i) => {
        console.log(`  '${a.name}', // ${i + 1}　（${a.duration.toFixed(2)}s）`);
      });
    } else {
      console.log('\n-- 沒有動畫（沒有骨架，或這顆 GLB 本身是靜態掃描/場景模型）--');
    }

    console.log('\n-- 取色（baseColorFactor，僅供參考）--');
    console.log('  Node 沒有 canvas/document，貼圖平均色只有在 Electron/瀏覽器實際跑特效時才會生效');
    console.log('  （sampleAverageMaterialColor() 的貼圖路徑），這裡只能列材質的 baseColorFactor：');
    const materials = new Set();
    gltf.scene.traverse((child) => {
      if (child.isMesh && child.material) {
        const mats = Array.isArray(child.material) ? child.material : [child.material];
        for (const m of mats) materials.add(m);
      }
    });
    for (const mat of materials) {
      const c = mat.color ? [mat.color.r, mat.color.g, mat.color.b] : null;
      const colorText = c ? `[${c.map((n) => n.toFixed(2)).join(', ')}]` : '(無)';
      const mapText = mat.map ? '，有 baseColor 貼圖（實際跑特效時會優先用貼圖平均色，這裡的 baseColorFactor 不代表最終顏色）' : '，沒有貼圖';
      console.log(`  material "${mat.name || '(unnamed)'}"：baseColorFactor ${colorText}${mapText}`);
    }
  },
  (err) => {
    console.error('GLB 解析失敗：', err);
    process.exit(1);
  }
);
