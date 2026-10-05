'use strict';
// 模型資產檢查：3D 模型（GLB）＋ 2D 模型（Live2D）。
//
// 兩種模型都有「不一定跟著 git 版本走」的問題，以前缺檔只會在 DevTools 印一行
// 錯誤，畫面上 3D 變成一團看不出是什麼的隨機散點、2D 角色直接默默不見，使用者完全
// 不知道問題在哪：
//   - 3D：particle-effect/models/ 底下的 GLB 整個不進版本控制（根目錄 .gitignore：私人
//     收集的遊戲資源、檔案大、授權來源不明），從 git 拿到專案的人預設一個都沒有。
//   - 2D：live2d_my_like/models/ 在 .gitignore 預設整個排除，只有逐一列了例外（或被
//     強制 git add）的模型才會進版本控制；manifest.json 新增角色時忘了處理，別人 clone
//     下來就缺那整隻。model3.json 引用的貼圖/動作檔漏傳也是同一類問題。
// 這支負責「比對設定檔列的檔案跟磁碟上實際有的」：
//   - main.js 啟動時呼叫，缺檔就在系統匣跳提示、選單標示並停用（缺模型檔）
//   - `npm run check-assets` 單獨跑，印出缺哪些檔、該放到哪裡；另外檢查「本機有、
//     但沒進版本控制」的 Live2D 檔案，提醒維護者推上去之前補 git add
//   - `npm run dist` 打包前先跑一次（--warn：只警告不擋），不然打出來的 .exe 會少模型
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MODELS_DIR = path.join(__dirname, 'particle-effect', 'models');
const SOURCES_PATH = path.join(__dirname, 'particle-effect', 'sources.json');
const README_HINT = 'particle-effect/models/README.md';
const LIVE2D_ROOT = path.join(__dirname, '..', 'live2d_my_like');

// ── 3D（GLB）────────────────────────────────────────────────────────────

// sources: sources.json 的 models（{ key: { file, ... } }）。
// 回傳缺檔的項目 [{ key, file }]，順序跟 sources.json 一樣。exists 可以換掉方便測試。
function findMissingModelFiles(sources, modelsDir = MODELS_DIR, exists = fs.existsSync) {
  return Object.entries(sources || {})
    .filter(([, source]) => source && source.file && !exists(path.join(modelsDir, source.file)))
    .map(([key, source]) => ({ key, file: source.file }));
}

// 給終端機看的多行說明；沒缺檔回傳空字串
function formatMissingReport(missing, total, modelsDir = MODELS_DIR) {
  if (!missing.length) return '';
  const allMissing = missing.length === total;
  return [
    allMissing
      ? `[asset-check] 3D 模型檔一個都找不到（sources.json 列了 ${total} 個）——GLB 不跟著 git 版本走，要另外取得。`
      : `[asset-check] 缺少 ${missing.length}/${total} 個 3D 模型檔（GLB 不跟著 git 版本走，要另外取得）：`,
    ...missing.map(({ key, file }) => `[asset-check]   - ${file}（sources.json 的 ${key}）`),
    `[asset-check] 請把檔案放到：${modelsDir}`,
    `[asset-check] 詳細說明見 ${README_HINT}；缺檔的模型在系統匣選單會顯示「缺模型檔」且無法選取。`,
  ].join('\n');
}

// 讀 sources.json 的模型清單（{ key: { file, ... } }）。每次都重新讀檔，改了 sources.json
// 再呼叫一次就會讀到新內容（main.js 監看檔案變動用）。維持 async 介面，呼叫端不用改。
async function loadSources(sourcesPath = SOURCES_PATH) {
  const data = JSON.parse(fs.readFileSync(sourcesPath, 'utf8'));
  return (data && data.models) || {};
}

// ── 2D（Live2D）─────────────────────────────────────────────────────────

// model3.json（Cubism 3/4）或 model.json（Cubism 2）引用的檔案，路徑相對於模型 json
// 所在資料夾。required 缺了角色根本顯示不出來（核心 moc、貼圖）；optional 缺了角色
// 還看得到，只是某些動作/表情/物理效果不會動。
function live2dReferencedFiles(modelJson) {
  const required = [];
  const optional = [];
  const fr = modelJson && modelJson.FileReferences;
  if (fr) {
    if (fr.Moc) required.push(fr.Moc);
    required.push(...(fr.Textures || []));
    for (const f of [fr.Physics, fr.Pose, fr.DisplayInfo, fr.UserData]) if (f) optional.push(f);
    for (const list of Object.values(fr.Motions || {})) {
      for (const m of list || []) {
        if (m && m.File) optional.push(m.File);
        if (m && m.Sound) optional.push(m.Sound);
      }
    }
    for (const e of fr.Expressions || []) if (e && e.File) optional.push(e.File);
  } else if (modelJson) {
    if (modelJson.model) required.push(modelJson.model);
    required.push(...(modelJson.textures || []));
    for (const f of [modelJson.physics, modelJson.pose]) if (f) optional.push(f);
    for (const list of Object.values(modelJson.motions || {})) {
      for (const m of list || []) {
        if (m && m.file) optional.push(m.file);
        if (m && m.sound) optional.push(m.sound);
      }
    }
    for (const e of modelJson.expressions || []) if (e && e.file) optional.push(e.file);
  }
  return { required, optional };
}

const defaultFs = {
  exists: fs.existsSync,
  readJson: (p) => JSON.parse(fs.readFileSync(p, 'utf8')),
};

// 檢查 manifest.json 的一筆角色。回傳：
//   { id, path, character, fatal, missingRequired, missingOptional, files }
//   fatal：null＝顯示得出來；'model-json'＝模型 json 不存在；'bad-json'＝模型 json
//          讀不懂；'required'＝moc/貼圖缺檔
//   files：模型 json 跟它引用到、而且本機真的有的檔案（絕對路徑），給
//          findUntrackedFiles() 檢查有沒有進版本控制
function checkLive2DEntry(entry, rootDir = LIVE2D_ROOT, fsApi = defaultFs) {
  const result = {
    id: entry.id,
    path: entry.path,
    character: entry.character,
    fatal: null,
    missingRequired: [],
    missingOptional: [],
    files: [],
  };
  const jsonPath = path.join(rootDir, entry.path);
  if (!fsApi.exists(jsonPath)) {
    result.fatal = 'model-json';
    return result;
  }
  result.files.push(jsonPath);
  let modelJson;
  try {
    modelJson = fsApi.readJson(jsonPath);
  } catch {
    result.fatal = 'bad-json';
    return result;
  }
  const dir = path.dirname(jsonPath);
  const { required, optional } = live2dReferencedFiles(modelJson);
  for (const f of required) {
    const p = path.join(dir, f);
    if (fsApi.exists(p)) result.files.push(p);
    else result.missingRequired.push(f);
  }
  for (const f of optional) {
    const p = path.join(dir, f);
    if (fsApi.exists(p)) result.files.push(p);
    else result.missingOptional.push(f);
  }
  if (result.missingRequired.length) result.fatal = 'required';
  return result;
}

// 整份 manifest 檢查一遍，回傳每一筆的結果（順序同 manifest）
function checkLive2DManifest(manifest, rootDir = LIVE2D_ROOT, fsApi = defaultFs) {
  return (manifest || []).map((entry) => checkLive2DEntry(entry, rootDir, fsApi));
}

function hasLive2DProblem(r) {
  return !!(r.fatal || r.missingOptional.length);
}

const FATAL_LABEL = {
  'model-json': '整個模型不見了（模型 json 不存在）',
  'bad-json': '模型 json 損毀、讀不懂',
  required: '核心檔或貼圖缺少，無法顯示',
};

function summarizeFiles(files, limit = 5) {
  return files.length > limit ? `${files.slice(0, limit).join('、')} 等 ${files.length} 個` : files.join('、');
}

// 給終端機看的多行說明；沒問題回傳空字串。names：names.json（顯示用的角色名字）
function formatLive2DReport(results, names = {}, rootDir = LIVE2D_ROOT) {
  const problems = results.filter(hasLive2DProblem);
  if (!problems.length) return '';
  const fatalCount = problems.filter((r) => r.fatal).length;
  const lines = [
    `[asset-check] Live2D 角色有 ${problems.length}/${results.length} 個缺檔` +
      (fatalCount ? `（其中 ${fatalCount} 個無法顯示）` : '（都還能顯示，只是部分動作/效果會失效）') +
      '：',
  ];
  for (const r of problems) {
    const label = `#${r.id} ${names[r.path] || r.character}（${r.path}）`;
    if (r.fatal) {
      const detail = r.missingRequired.length ? `：${summarizeFiles(r.missingRequired)}` : '';
      lines.push(`[asset-check]   ✖ ${label} ${FATAL_LABEL[r.fatal]}${detail}`);
    } else {
      lines.push(`[asset-check]   △ ${label} 缺少 ${summarizeFiles(r.missingOptional)}（動作/表情/物理效果會失效）`);
    }
  }
  lines.push(`[asset-check] 模型放在：${path.join(rootDir, 'models')}`);
  if (fatalCount) {
    lines.push('[asset-check] 無法顯示的角色在系統匣選單會標示「缺模型檔」且無法選取；目前選到它的話會暫時改用其他角色。');
  }
  return lines.join('\n');
}

// files（絕對路徑）裡「本機有、但沒進 git 版本控制」的檔案。不在 git repo 裡、
// 或環境沒有 git（例如打包後的 .exe）回傳 null，呼叫端直接略過這項檢查。
function findUntrackedFiles(files, cwd = LIVE2D_ROOT) {
  if (!files.length) return [];
  try {
    const top = execFileSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const tracked = new Set(
      execFileSync('git', ['-C', top, 'ls-files', '-z', '--', path.relative(top, cwd)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 64 * 1024 * 1024,
      })
        .split('\0')
        .filter(Boolean)
        .map((p) => path.normalize(path.join(top, p)).toLowerCase())
    );
    return files.filter((f) => !tracked.has(path.normalize(f).toLowerCase()));
  } catch {
    return null;
  }
}

function formatUntrackedReport(untracked, rootDir = LIVE2D_ROOT) {
  if (!untracked || !untracked.length) return '';
  const rel = untracked.map((f) => path.relative(rootDir, f).split(path.sep).join('/'));
  return [
    `[asset-check] 有 ${untracked.length} 個 Live2D 檔案在本機，但沒進 git 版本控制——推上去之後別人 clone 會缺：`,
    ...rel.slice(0, 20).map((f) => `[asset-check]   - live2d_my_like/${f}`),
    ...(rel.length > 20 ? [`[asset-check]   …另外 ${rel.length - 20} 個`] : []),
    '[asset-check] live2d_my_like/models/ 在根目錄 .gitignore 預設排除，新增角色要在那裡加例外（或 git add -f）。',
  ].join('\n');
}

function loadLive2DManifest(rootDir = LIVE2D_ROOT) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, 'config', 'manifest.json'), 'utf8'));
}

function loadLive2DNames(rootDir = LIVE2D_ROOT) {
  try {
    return JSON.parse(fs.readFileSync(path.join(rootDir, 'config', 'names.json'), 'utf8'));
  } catch {
    return {};
  }
}

module.exports = {
  findMissingModelFiles,
  formatMissingReport,
  loadSources,
  MODELS_DIR,
  README_HINT,
  live2dReferencedFiles,
  checkLive2DEntry,
  checkLive2DManifest,
  hasLive2DProblem,
  formatLive2DReport,
  findUntrackedFiles,
  formatUntrackedReport,
  loadLive2DManifest,
  loadLive2DNames,
  LIVE2D_ROOT,
};

// 命令列：node asset-check.js [--warn]
// 3D 缺檔或有 Live2D 角色無法顯示時預設 exit code 1；--warn 只印警告、exit code 0
// （給 npm run dist 用，不擋打包）。Live2D 只缺動作/表情檔、或檔案沒進版本控制只警告。
if (require.main === module) {
  (async () => {
    let failed = false;

    try {
      const sources = await loadSources();
      const total = Object.keys(sources).length;
      const missing = findMissingModelFiles(sources);
      if (missing.length) {
        console.warn(formatMissingReport(missing, total));
        failed = true;
      } else {
        console.log(`[asset-check] 3D 模型檔齊全（${total} 個）。`);
      }
    } catch (err) {
      console.error('[asset-check] 讀取 particle-effect/sources.json 失敗：', err.message);
      failed = true;
    }

    try {
      const results = checkLive2DManifest(loadLive2DManifest());
      const report = formatLive2DReport(results, loadLive2DNames());
      if (report) console.warn(report);
      else console.log(`[asset-check] Live2D 角色檔案齊全（${results.length} 個）。`);
      if (results.some((r) => r.fatal)) failed = true;
      const untracked = findUntrackedFiles(results.flatMap((r) => r.files));
      const untrackedReport = formatUntrackedReport(untracked);
      if (untrackedReport) console.warn(untrackedReport);
    } catch (err) {
      console.error('[asset-check] 讀取 live2d_my_like/config/manifest.json 失敗：', err.message);
      failed = true;
    }

    if (failed && !process.argv.includes('--warn')) process.exitCode = 1;
  })();
}
