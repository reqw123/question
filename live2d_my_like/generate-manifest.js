const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

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
      foundPaths.push(path.relative(ROOT, full).split(path.sep).join('/'));
    }
  }
}
walk(ROOT);
foundPaths.sort();

// 讀取舊 manifest.json，既有路徑沿用原本的流水號，只有新增的模型才會拿到新號碼，
// 避免每次重新掃描時既有角色的編號被打亂（host.html 下拉選單存的是編號，不是路徑）。
const manifestPath = path.join(ROOT, 'manifest.json');
let oldIdByPath = {};
let maxOldId = 0;
try {
  const old = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  old.forEach(e => { oldIdByPath[e.path] = e.id; maxOldId = Math.max(maxOldId, e.id); });
} catch {}

let nextId = maxOldId + 1;
const entries = foundPaths.map(rel => {
  const parts = rel.split('/');
  const character = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
  const id = oldIdByPath[rel] || nextId++;
  return {
    id,
    path: rel,
    character,
    cubism: isCubism4Manifest(rel) ? 4 : 2,
  };
});
entries.sort((a, b) => a.id - b.id);

fs.writeFileSync(manifestPath, JSON.stringify(entries, null, 2));

// names.json 是給你手動編輯顯示名稱用的，key 是 path、value 是你想要的名字。
// 只在檔案不存在時建立，已經存在就不動，不會洗掉你編輯過的名字；
// 新模型會用 character（資料夾名）當預設值，方便你知道要編輯哪一筆。
const namesPath = path.join(ROOT, 'names.json');
let names = {};
try { names = JSON.parse(fs.readFileSync(namesPath, 'utf8')); } catch {}
let namesChanged = false;
entries.forEach(e => {
  if (!(e.path in names)) { names[e.path] = e.character; namesChanged = true; }
});
if (namesChanged || !fs.existsSync(namesPath)) {
  fs.writeFileSync(namesPath, JSON.stringify(names, null, 2));
}

console.log('total models:', entries.length);
entries.forEach(e => console.log(`  #${e.id}  ${names[e.path]}  (${e.path})`));
