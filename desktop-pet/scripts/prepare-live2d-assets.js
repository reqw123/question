'use strict';
// 打包成單獨 .exe 前的準備步驟：把 live2d_my_like/ 裡「日常實際會用」的角色資料夾
// （名單見下面 SELECTED_CHARACTERS）複製一份到 desktop-pet/pack-assets/live2d_my_like/，
// 讓 electron-builder 的 build.extraResources 有東西可以打包進去。
//
// 為什麼要這一步，而不是直接把整個 live2d_my_like/models/ 包進去：那個資料夾目前
// 314MB、約 50 個角色，其中不少是來源不明的遊戲角色截圖（授權不明），使用者只想讓
// 自己日常實際會用的這幾個角色進到可攜出去的 .exe 裡，其餘的維持原樣、不進打包產物。
//
// 這支腳本只複製檔案，不改動 live2d_my_like/ 本身任何東西（讀取為唯讀），輸出的
// pack-assets/ 資料夾整個被 .gitignore 排除、每次執行都會先清空重建，可以放心重跑。
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SRC_LIVE2D = path.join(REPO_ROOT, 'live2d_my_like');
const DEST_ROOT = path.join(__dirname, '..', 'pack-assets', 'live2d_my_like');

// 使用者指定「日常實際會用」的角色資料夾名稱（對應 live2d_my_like/models/<name>/）。
const SELECTED_CHARACTERS = [
  '076', '077', '1003104', '1009109', '1014107',
  '1024100', '1064100', '1074100', 'shizuku', 'abeikelongbi_3',
];

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function main() {
  if (!fs.existsSync(SRC_LIVE2D)) {
    console.error(`[prepare-live2d-assets] 找不到 ${SRC_LIVE2D}——Live2D 模型檔案本身沒有跟著專案發布，需要另外取得。`);
    process.exit(1);
  }

  rmrf(DEST_ROOT);
  fs.mkdirSync(path.join(DEST_ROOT, 'models'), { recursive: true });
  fs.mkdirSync(path.join(DEST_ROOT, 'config'), { recursive: true });

  const missing = [];
  let copiedCount = 0;
  for (const name of SELECTED_CHARACTERS) {
    const src = path.join(SRC_LIVE2D, 'models', name);
    if (!fs.existsSync(src)) {
      missing.push(name);
      continue;
    }
    copyDir(src, path.join(DEST_ROOT, 'models', name));
    copiedCount++;
  }
  if (missing.length) {
    console.warn(`[prepare-live2d-assets] 這些角色資料夾找不到，略過：${missing.join(', ')}`);
  }

  // manifest.json / names.json 只保留 SELECTED_CHARACTERS 涵蓋到的條目，其餘角色的
  // id/layout/chatSounds 等既有調校保留在原始檔案裡，不受這次篩選影響。
  const manifest = JSON.parse(fs.readFileSync(path.join(SRC_LIVE2D, 'config', 'manifest.json'), 'utf8'));
  const names = JSON.parse(fs.readFileSync(path.join(SRC_LIVE2D, 'config', 'names.json'), 'utf8'));

  const isSelected = (modelPath) => SELECTED_CHARACTERS.some(
    (name) => modelPath === `models/${name}` || modelPath.startsWith(`models/${name}/`),
  );

  const filteredManifest = manifest.filter((entry) => isSelected(entry.path));
  const filteredNames = {};
  for (const [modelPath, label] of Object.entries(names)) {
    if (isSelected(modelPath)) filteredNames[modelPath] = label;
  }

  fs.writeFileSync(path.join(DEST_ROOT, 'config', 'manifest.json'), JSON.stringify(filteredManifest, null, 2));
  fs.writeFileSync(path.join(DEST_ROOT, 'config', 'names.json'), JSON.stringify(filteredNames, null, 2));

  console.log(`[prepare-live2d-assets] 已備妥 ${copiedCount}/${SELECTED_CHARACTERS.length} 個角色到 ${DEST_ROOT}`);
  console.log(`[prepare-live2d-assets] manifest.json：${filteredManifest.length} 筆，names.json：${Object.keys(filteredNames).length} 筆`);
}

main();
