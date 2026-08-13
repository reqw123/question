const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const SCAN_ROOT = path.join(PROJECT_ROOT, 'models');

function isCubism2Manifest(name) {
  const n = name.toLowerCase();
  return n === 'model.json' || n.endsWith('.model.json');
}
function isCubism4Manifest(name) {
  return /\.model3\.json$/i.test(name);
}

const foundPaths = [];
function walk(dir) {
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const it of items) {
    const full = path.join(dir, it.name);
    if (it.isDirectory()) {
      walk(full);
    } else if (isCubism4Manifest(it.name) || isCubism2Manifest(it.name)) {
      foundPaths.push(path.relative(PROJECT_ROOT, full).split(path.sep).join('/'));
    }
  }
}
walk(SCAN_ROOT);
foundPaths.sort();

// 讀取舊 manifest.json，既有路徑沿用原本的流水號，只有新增的模型才會拿到新號碼，
// 避免每次重新掃描時既有角色的編號被打亂（host.html 下拉選單存的是編號，不是路徑）。
// 同時保留每個路徑原本的 layout/chatSounds（見 lib/live2d.js 開頭說明）——這兩個欄位是
// 手動調過的模型專屬設定，重新掃描時只更新 id/path/character/cubism，不能被洗掉。
//
// 「檔案不存在」（第一次執行）跟「檔案存在但壞掉」要分開處理：前者是正常情況，視為空白
// 繼續往下跑；後者如果也悄悄當成空白繼續跑，會把裡面手動調過的 id/layout/chatSounds
// 全部當「舊的沒有」，最後把這個空白結果直接覆寫回 manifest.json，等於永久洗掉——
// 所以壞掉時直接中止、不寫入任何檔案，逼你先手動修好語法。
const manifestPath = path.join(__dirname, 'manifest.json');
let oldEntryByPath = {};
let maxOldId = 0;
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
      '為了避免洗掉現有的 id/layout/chatSounds/partOverrides/paramOverrides，已經中止、沒有寫入任何檔案。' +
      '請先手動修好 manifest.json 的語法，再重新執行這支腳本。');
    process.exit(1);
  }
  old.forEach(e => { oldEntryByPath[e.path] = e; maxOldId = Math.max(maxOldId, e.id); });
}

// layout 佔位模板：欄位名稱都列出來，值先填空字串（不是 0 或 null）——
// 0 對 offsetX/offsetY/scale 來說是合法的真實數值（例如「不用調」），沒辦法拿來
// 當「還沒填」的記號，只有空字串不會跟任何合法數值撞在一起。
// lib/live2d.js 合併 layout 到 cfg 時（見該檔 _mergeLayout()）會把空字串欄位當
// 「還沒填」跳過，不會真的把 cfg.scale 蓋成空字串。
// bubbleGrow：文字泡泡尾巴朝哪邊（'left'/'right'，見 lib/live2d.js 開頭說明），
// 桌寵角色可以被拖到畫面任何位置，固定的預設值不一定每次都對，情境編輯器的
// 「泡泡校正」分頁可以直接調、存回這裡。
const EMPTY_LAYOUT = { offsetX: '', offsetY: '', scale: '', headRatio: '', headXRatio: '', bubbleGrow: '' };

let nextId = maxOldId + 1;
const entries = foundPaths.map(rel => {
  const parts = rel.split('/');
  const character = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  const old = oldEntryByPath[rel];
  const id = old ? old.id : nextId++;
  const entry = {
    id,
    path: rel,
    character,
    cubism: isCubism4Manifest(rel) ? 4 : 2,
  };
  // 舊的有填過真的值（至少一個欄位不是空字串）就沿用；沒有的話（新模型，或還沒調過的
  // 舊模型）補上五個欄位名稱都列出來的佔位模板，提醒之後要用 L2D.printPos() 調。
  const oldHasRealValues = old && old.layout &&
    Object.values(old.layout).some(v => v !== '' && v !== undefined && v !== null);
  entry.layout = oldHasRealValues ? old.layout : { ...EMPTY_LAYOUT };
  // chatSounds：這個模型專屬的閒話音效池（字串陣列，路徑跟 chatSounds 全域預設池格式一樣），
  // 空陣列代表沒設定，lib/live2d.js 那邊沒填的角色會退回 L2D_CFG.chatSounds 全域池，
  // 舊的有填過真的路徑（至少一個不是空字串）才沿用，不然一律重置成空陣列。
  const oldHasRealSounds = old && Array.isArray(old.chatSounds) &&
    old.chatSounds.some(s => s !== '' && s !== undefined && s !== null);
  entry.chatSounds = oldHasRealSounds ? old.chatSounds : [];
  // partOverrides：這個模型專屬「載入時套用」的 Part 透明度覆蓋值（key＝Part ID、
  // value＝0~1 的透明度，例如貼圖修正不掉、只能靠調整 Part 透明度處理的殘留物，或多套
  // 材質各自需要不同的 Part 顯隱組合）。空物件代表沒設定，不影響任何角色；value 是空
  // 字串 "" 的 key 視同沒設定——跟 layout/chatSounds 同一套慣例，只作用在「這個模型」
  // 身上，不會影響到剛好用同樣 Part 命名習慣的其他模型（見 lib/live2d.js 開頭說明）。
  const oldHasRealPartOverrides = old && old.partOverrides && typeof old.partOverrides === 'object' &&
    Object.values(old.partOverrides).some(v => v !== '' && v !== undefined && v !== null);
  entry.partOverrides = oldHasRealPartOverrides ? old.partOverrides : {};
  // paramOverrides：跟 partOverrides 同一套慣例，只是作用對象是 Parameter（key＝Parameter
  // ID、value＝要設定的數值），不是 Part 透明度——兩者是 Cubism 裡獨立的資料結構，見
  // lib/live2d.js 開頭說明。
  const oldHasRealParamOverrides = old && old.paramOverrides && typeof old.paramOverrides === 'object' &&
    Object.values(old.paramOverrides).some(v => v !== '' && v !== undefined && v !== null);
  entry.paramOverrides = oldHasRealParamOverrides ? old.paramOverrides : {};
  return entry;
});
entries.sort((a, b) => a.id - b.id);

fs.writeFileSync(manifestPath, JSON.stringify(entries, null, 2));

// names.json 是給你手動編輯顯示名稱用的，key 是 path、value 是你想要的名字。
// 只在檔案不存在時建立，已經存在就不動，不會洗掉你編輯過的名字；
// 新模型會用 character（資料夾名）當預設值，方便你知道要編輯哪一筆。
const namesPath = path.join(__dirname, 'names.json');
let names = {};
try { names = JSON.parse(fs.readFileSync(namesPath, 'utf8')); }
catch (err) {
  if (err.code !== 'ENOENT') console.warn('[generate-manifest] 讀取 names.json 失敗，將視為空清單重建（既有名字可能被蓋掉）：', err.message);
}
let namesChanged = false;
entries.forEach(e => {
  if (!(e.path in names)) { names[e.path] = e.character; namesChanged = true; }
});
if (namesChanged || !fs.existsSync(namesPath)) {
  fs.writeFileSync(namesPath, JSON.stringify(names, null, 2));
}

// names_history.json：所有「曾經在 names.json 裡出現過」的名字，只增不減——
// names.json 本身只反映「現在」的對應關係（模型被刪除/改路徑，舊名字就變孤兒或消失），
// 不適合當「這個名字是不是用過」的長期紀錄。這裡把這次新增的預設名字（character）
// 也一併記進歷史清單，桌寵的「模型命名管理」視窗用這份清單當名字池的候選來源，
// 不會因為你後來把某個模型改名、或模型被刪除，舊名字就從池子裡消失。
const historyPath = path.join(__dirname, 'names_history.json');
let history = [];
try { history = JSON.parse(fs.readFileSync(historyPath, 'utf8')); }
catch (err) {
  if (err.code !== 'ENOENT') console.warn('[generate-manifest] 讀取 names_history.json 失敗，將視為空清單重建：', err.message);
}
const historySet = new Set(history);
let historyChanged = false;
Object.values(names).forEach(n => {
  if (n && !historySet.has(n)) { historySet.add(n); historyChanged = true; }
});
if (historyChanged || !fs.existsSync(historyPath)) {
  fs.writeFileSync(historyPath, JSON.stringify([...historySet].sort((a, b) => a.localeCompare(b, 'zh-Hant')), null, 2));
}

console.log('total models:', entries.length);
entries.forEach(e => console.log(`  #${e.id}  ${names[e.path]}  (${e.path})`));
