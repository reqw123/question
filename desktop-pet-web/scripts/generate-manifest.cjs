// 掃 public/characters/models/、自動維護 public/characters/config/manifest.json 跟
// names.json——比照 C:\question\live2d_my_like\config\generate-manifest.js 的作法（同一套
// 「掃描角色資產、既有手動調過的值不洗掉、新角色補空白模板」邏輯），差別是這裡要同時認得
// Cubism（Live2D）跟 Spine 兩種格式，因為 desktop-pet-web 的卡片輪播兩種都在用（見
// src/pages/desktop-pet/components/HeroLive2DStage.tsx 的 ModelConfig 判別聯集）。
//
// 沒有搬過來的部分：live2d_my_like 那份還有 id（給桌寵 App 的角色切換選單用流水號，這裡
// 沒有那個選單，MODELS 陣列本身就是唯一清單，不需要另外編號）、cubism 版本號、chatSounds／
// partOverrides／paramOverrides（閒話音效、Cubism Part/Parameter 覆蓋——這幾個都是桌寵
// App 專屬功能，Hero 卡片輪播沒有這些東西）、names_history.json（給桌寵 App「模型命名管理」
// 視窗的歷史名字池用的，這裡沒有那個 UI，沒有消費者）。只搬了跟這個專案實際會用到的部分：
// manifest.json 的 path/layout、names.json 的路徑對顯示名稱。
//
// 用法：node scripts/generate-manifest.cjs（跟原本 node live2d_my_like/config/
// generate-manifest.js 同一種直接執行方式），或 npm run generate-manifest。
//
// 檔名是 .cjs 不是 .js：desktop-pet-web/package.json 有 "type": "module"，這個套件下的
// 純 .js 檔案預設會被當成 ESM 解析，require() 在 ESM 裡不存在會直接噴錯——用 .cjs 副檔名
// 強制這支腳本維持 CommonJS，不用把整支改寫成 import 語法，也不用去動 package.json 的
// "type" 設定（那會影響到專案其他所有 .js 檔案，改動範圍太大，不划算）。
'use strict';
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const SCAN_ROOT = path.join(PROJECT_ROOT, 'public', 'characters', 'models');
const CONFIG_DIR = path.join(PROJECT_ROOT, 'public', 'characters', 'config');
const HERO_STAGE_PATH = path.join(PROJECT_ROOT, 'src', 'pages', 'desktop-pet', 'components', 'HeroLive2DStage.tsx');

function isCubism4Manifest(name) {
  return /\.model3\.json$/i.test(name);
}
function isCubism2Manifest(name) {
  const n = name.toLowerCase();
  return n === 'model.json' || n.endsWith('.model.json');
}
// Spine 的骨架檔案名稱沒有固定規則（跟 Cubism 的 .model3.json 尾綴不一樣，雅絲娜是
// asuna.json、亞托克斯是 character-template-slim-v8.json），只能讀內容判斷——
// Spine skeleton JSON 固定會有 skeleton／bones／slots／animations 這幾個頂層欄位，
// 這是 Spine 官方 runtime 認的標準結構，讀不到／格式不對就不算。
function isSpineSkeleton(fullPath) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  } catch {
    return false;
  }
  return !!(
    data && typeof data === 'object' &&
    data.skeleton && typeof data.skeleton === 'object' &&
    Array.isArray(data.bones) &&
    Array.isArray(data.slots) &&
    data.animations && typeof data.animations === 'object'
  );
}

const found = []; // { relPath, kind }
function walk(dir) {
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const it of items) {
    const full = path.join(dir, it.name);
    if (it.isDirectory()) {
      walk(full);
      continue;
    }
    const relPath = path.relative(SCAN_ROOT, full).split(path.sep).join('/');
    if (isCubism4Manifest(it.name) || isCubism2Manifest(it.name)) {
      found.push({ relPath, kind: 'live2d' });
    } else if (/\.json$/i.test(it.name) && isSpineSkeleton(full)) {
      found.push({ relPath, kind: 'spine' });
    }
    // 其他 .json（.physics3.json／.pose3.json／.cdi3.json／貼圖 .atlas 等 sidecar 檔案、
    // 或內容不符合 Spine 結構的雜項 json）都不算，安靜跳過，不當成角色主檔。
  }
}
walk(SCAN_ROOT);
found.sort((a, b) => a.relPath.localeCompare(b.relPath));

// manifest.json 壞掉（語法錯誤）要中止、不寫入——理由跟 live2d_my_like 那份一模一樣：
// 若把「讀壞了」跟「檔案不存在（第一次執行）」都當空白繼續跑，會把手動調過的 layout
// 全部當作「舊的沒有」，最後整份覆寫回去，等於永久洗掉。壞掉時逼你先手動修好語法。
const manifestPath = path.join(CONFIG_DIR, 'manifest.json');
let oldEntryByPath = {};
let rawOld = null;
try {
  rawOld = fs.readFileSync(manifestPath, 'utf8');
} catch {
  // 檔案不存在，第一次執行，維持空白正常繼續
}
if (rawOld !== null) {
  let old;
  try {
    old = JSON.parse(rawOld);
    if (!Array.isArray(old)) throw new Error('manifest.json 最外層必須是陣列');
  } catch (err) {
    console.error('[generate-manifest] manifest.json 目前壞掉了（' + err.message + '），' +
      '為了避免洗掉現有的 layout 手動校正值，已經中止、沒有寫入任何檔案。' +
      '請先手動修好 manifest.json 的語法，再重新執行這支腳本。');
    process.exit(1);
  }
  old.forEach((e) => { if (e && e.path) oldEntryByPath[e.path] = e; });
}

// 空字串＝「還沒填」，不是 0——0 對 offsetX/offsetY/scale 是合法的真實數值（例如
// 「不用調」），沒辦法拿來當佔位記號。HeroLive2DStage.tsx 的 mergeLayout() 合併時
// 也是用同一套「空字串跳過」規則，維持一致。
const EMPTY_LAYOUT = { offsetX: '', offsetY: '', scale: '' };

const entries = found.map(({ relPath, kind }) => {
  const old = oldEntryByPath[relPath];
  // 舊的有填過真的值（至少一個欄位不是空字串）就沿用，不然補空白模板。
  const oldHasRealValues = old && old.layout &&
    Object.values(old.layout).some((v) => v !== '' && v !== undefined && v !== null);
  return {
    path: relPath,
    kind,
    layout: oldHasRealValues ? old.layout : { ...EMPTY_LAYOUT },
  };
});
entries.sort((a, b) => a.path.localeCompare(b.path));

fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.writeFileSync(manifestPath, JSON.stringify(entries, null, 2) + '\n');

// names.json：key 是 path，value 是顯示名稱。只在「這個 path 之前沒出現過」時才補上
// 預設值（角色資料夾名），已經手動改過名字的一律不動。
const namesPath = path.join(CONFIG_DIR, 'names.json');
let names = {};
try {
  names = JSON.parse(fs.readFileSync(namesPath, 'utf8'));
} catch (err) {
  if (err.code !== 'ENOENT') {
    console.error('[generate-manifest] names.json 目前壞掉了（' + err.message + '），' +
      '為了避免洗掉已經手動改過的顯示名稱，已經中止、沒有寫入任何檔案。' +
      '請先手動修好 names.json 的語法，再重新執行這支腳本。');
    process.exit(1);
  }
  // ENOENT：檔案不存在，第一次執行，維持空白正常繼續
}
let namesChanged = false;
entries.forEach((e) => {
  if (!(e.path in names)) {
    const character = e.path.split('/')[0];
    names[e.path] = character;
    namesChanged = true;
  }
});
if (namesChanged) {
  fs.writeFileSync(namesPath, JSON.stringify(names, null, 2) + '\n');
}

// 診斷用：對照 HeroLive2DStage.tsx 的 MODELS 陣列，列出「掃到了、但還沒接進卡片輪播」
// 的角色——單純用正規表示式抓 url: '...' 字串，不是真的解析 TypeScript，抓不到就安靜
// 跳過，不影響上面 manifest.json/names.json 已經正確寫入的結果，這段純粹是給你看的
// 提示，不影響實際寫檔案的行為。
let wiredPaths = new Set();
try {
  const src = fs.readFileSync(HERO_STAGE_PATH, 'utf8');
  const re = /url:\s*'\/characters\/models\/([^']+)'/g;
  let m;
  while ((m = re.exec(src))) wiredPaths.add(m[1]);
} catch {
  // 讀不到 HeroLive2DStage.tsx 就跳過這段診斷，不影響主要功能
}

console.log(`[generate-manifest] 掃到 ${entries.length} 個角色（Live2D ${entries.filter((e) => e.kind === 'live2d').length} 個、Spine ${entries.filter((e) => e.kind === 'spine').length} 個）：`);
entries.forEach((e) => {
  const wired = wiredPaths.size === 0 || wiredPaths.has(e.path);
  const flag = wired ? '' : '　← 還沒接進 MODELS 陣列';
  console.log(`  [${e.kind}] ${names[e.path]}  (${e.path})${flag}`);
});
