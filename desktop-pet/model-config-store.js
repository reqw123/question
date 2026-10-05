'use strict';
// 「模型設定」視窗（model-config.html）背後的讀寫邏輯：3D 模型（particle-effect/sources.json）
// 跟 2D 模型（live2d_my_like/config/manifest.json、names.json）。
//
// 放在獨立檔案、不直接寫在 main.js，是為了能單元測試（見 model-config-store.test.js）：
// 驗證規則、存檔前清掉空欄位、.gitignore 例外這些都是純函式，不用開 Electron 就測得到。
// 會碰檔案系統的函式都可以把路徑換掉，測試時指到暫存資料夾。
const fs = require('fs');
const path = require('path');

const PARTICLE_DIR = path.join(__dirname, 'particle-effect');
const SOURCES_JSON_PATH = path.join(PARTICLE_DIR, 'sources.json');
const MODELS_DIR = path.join(PARTICLE_DIR, 'models');
const VOICE_DIR = path.join(PARTICLE_DIR, 'audio', 'voice');
const BGM_DIR = path.join(PARTICLE_DIR, 'audio', 'bgm');
const REPO_ROOT = path.join(__dirname, '..');
const LIVE2D_ROOT = path.join(REPO_ROOT, 'live2d_my_like');
const LIVE2D_CONFIG_DIR = path.join(LIVE2D_ROOT, 'config');
const LIVE2D_MODELS_DIR = path.join(LIVE2D_ROOT, 'models');
const GITIGNORE_PATH = path.join(REPO_ROOT, '.gitignore');

const IDLE_MOTION_TYPES = ['spin', 'bob', 'swing'];
const AXES = ['x', 'y', 'z'];

// ── 共用 ────────────────────────────────────────────────────────────────

// 先寫暫存檔再改名：存到一半當掉（或磁碟滿了）不會留下只寫一半、整個 JSON 壞掉的設定檔。
// 檔尾換行沿用原檔案（generate-manifest.js 寫的 manifest.json/names.json 沒有檔尾換行），
// 不然兩邊輪流存檔，git diff 會一直冒出只差最後一行的修改。
function writeJsonAtomic(filePath, data) {
  let eol = '\n';
  try { eol = fs.readFileSync(filePath, 'utf8').endsWith('\n') ? '\n' : ''; } catch {}
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + eol);
  fs.renameSync(tmp, filePath);
}

function isBlank(v) {
  return v === '' || v === undefined || v === null;
}

// 把物件裡「沒填」的欄位拿掉：空字串、null、undefined、空陣列、空物件（遞迴）。
// GUI 的表單每個欄位都會送值上來，沒填的就是空字串；存進 sources.json 時不留這些，
// 讓 particle-effect.js 走「欄位不存在＝用預設值」那條路（見動畫參數說明.md）。
function pruneEmpty(value) {
  if (Array.isArray(value)) {
    const arr = value.map(pruneEmpty).filter((v) => v !== undefined);
    return arr.length ? arr : undefined;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const pruned = pruneEmpty(v);
      if (pruned !== undefined) out[k] = pruned;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return isBlank(value) ? undefined : value;
}

function listFiles(dir, exts) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && exts.some((ext) => d.name.toLowerCase().endsWith(ext)))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b, 'zh-Hant'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// 把使用者選的檔案複製到固定資料夾（GLB → models/、語音 → audio/voice/ …），回傳檔名。
// 已經在那個資料夾裡就不複製；同名但不是同一個檔案就拒絕，不默默蓋掉別的模型在用的檔。
function importFile(srcPath, destDir) {
  const name = path.basename(srcPath);
  const dest = path.join(destDir, name);
  if (path.resolve(srcPath).toLowerCase() === path.resolve(dest).toLowerCase()) return name;
  if (fs.existsSync(dest)) {
    throw new Error(`${path.basename(destDir)}/ 底下已經有同名檔案「${name}」，請先改檔名再選一次`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(srcPath, dest);
  return name;
}

// ── 3D（particle-effect/sources.json）─────────────────────────────────────

function normalizeParticleConfig(data) {
  const d = data && typeof data === 'object' ? data : {};
  return {
    models: d.models && typeof d.models === 'object' ? d.models : {},
    sequenceModels: Array.isArray(d.sequenceModels) ? d.sequenceModels : [],
    sequenceHoldSeconds: d.sequenceHoldSeconds ?? 3,
    sequenceTransitionSeconds: d.sequenceTransitionSeconds ?? 1.5,
    sequenceBgm: d.sequenceBgm ?? '',
  };
}

function readParticleConfig(filePath = SOURCES_JSON_PATH) {
  return normalizeParticleConfig(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}
function isVec3(v) {
  return Array.isArray(v) && v.length === 3 && v.every(isNum);
}
function isNameList(v) {
  return typeof v === 'string' ? v.length > 0 : Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && s);
}

// 單一模型的檢查。errors 會擋存檔；warnings 只提醒（例如 animatedIdle 跟
// periodicAnimation 照理互斥，但既有的 kaidoModel 兩個都有填，不能因此存不了檔）。
function validateParticleEntry(key, entry) {
  const errors = [];
  const warnings = [];
  const e = entry || {};
  const p = e.particle || {};
  if (!key || !/^[A-Za-z_$][\w$]*$/.test(key)) {
    errors.push(`代號「${key || ''}」只能用英文字母、數字、底線，而且不能數字開頭`);
  }
  if (!e.file || typeof e.file !== 'string') errors.push('沒有選模型檔（GLB）');
  for (const f of ['scale', 'position']) {
    if (p[f] !== undefined && !isVec3(p[f])) errors.push(`${f} 要填 X、Y、Z 三個數字，或三格都留空`);
  }
  for (const f of ['rotationX', 'rotationY', 'rotationZ', 'animationTime', 'animationFrames', 'animationSpeed']) {
    if (p[f] !== undefined && !isNum(p[f])) errors.push(`${f} 要填數字`);
  }
  if (p.animation !== undefined && !isNameList(p.animation)) errors.push('animation 格式不對');
  if (p.periodicAnimation !== undefined) {
    const pa = p.periodicAnimation;
    if (!isNameList(pa.name)) errors.push('定時動作有填其他欄位，但沒選要播哪一段動畫');
    for (const f of ['intervalSeconds', 'frameCount', 'speed']) {
      if (pa[f] !== undefined && !isNum(pa[f])) errors.push(`定時動作的 ${f} 要填數字`);
    }
    if (pa.speed === 0) warnings.push('定時動作的播放速度填 0 會讓動作卡在播放中、退不回定格姿勢');
    if (p.animatedIdle) warnings.push('「動畫循環播放」跟「定時動作」互斥，一個模型通常只開一種');
  }
  if (p.sequenceAction !== undefined) {
    if (!isNameList(p.sequenceAction.name)) errors.push('序列播放動作有填其他欄位，但沒選要播哪一段動畫');
    if (p.sequenceAction.frameCount !== undefined && !isNum(p.sequenceAction.frameCount)) {
      errors.push('序列播放動作的 frameCount 要填數字');
    }
  }
  if (p.animatedIdle && p.animation === undefined) warnings.push('開了「動畫循環播放」但沒選要循環哪幾段動畫');
  if (e.color !== undefined && !(isVec3(e.color) && e.color.every((c) => c >= 0 && c <= 1))) {
    errors.push('顏色格式不對（要是 0~1 的 R、G、B 三個數字）');
  }
  if (e.idleMotion !== undefined) {
    const m = e.idleMotion;
    if (m.type !== undefined && !IDLE_MOTION_TYPES.includes(m.type)) errors.push('閒置動畫類型只能是 spin/bob/swing');
    if (m.axis !== undefined && !AXES.includes(m.axis)) errors.push('閒置動畫軸向只能是 x/y/z');
    for (const f of ['amplitude', 'speed']) {
      if (m[f] !== undefined && !isNum(m[f])) errors.push(`閒置動畫的 ${f} 要填數字`);
    }
  }
  return { errors, warnings };
}

// 整份設定的檢查，回傳 { errors, warnings }，每一條訊息前面標模型代號。
function validateParticleConfig(config) {
  const errors = [];
  const warnings = [];
  const c = normalizeParticleConfig(config);
  for (const [key, entry] of Object.entries(c.models)) {
    const r = validateParticleEntry(key, entry);
    errors.push(...r.errors.map((m) => `${key}：${m}`));
    warnings.push(...r.warnings.map((m) => `${key}：${m}`));
  }
  for (const key of c.sequenceModels) {
    if (!c.models[key]) errors.push(`模型序列播放清單裡的「${key}」已經不存在`);
  }
  for (const f of ['sequenceHoldSeconds', 'sequenceTransitionSeconds']) {
    if (!isNum(c[f]) || c[f] < 0) errors.push(`${f} 要填 0 以上的數字`);
  }
  if (!Object.keys(c.models).length) errors.push('至少要留一個 3D 模型');
  return { errors, warnings };
}

// 存檔：每個模型先清掉空欄位，檢查沒問題才寫入。回傳 { ok, errors, warnings }。
function saveParticleConfig(config, filePath = SOURCES_JSON_PATH) {
  const c = normalizeParticleConfig(config);
  const models = {};
  for (const [key, entry] of Object.entries(c.models)) models[key] = pruneEmpty(entry) || {};
  const cleaned = { ...c, models, sequenceBgm: c.sequenceBgm || '' };
  const { errors, warnings } = validateParticleConfig(cleaned);
  if (errors.length) return { ok: false, errors, warnings };
  writeJsonAtomic(filePath, cleaned);
  return { ok: true, errors, warnings, config: cleaned };
}

// 從檔名產生一個可用的模型代號（英數字 camelCase + Model 結尾，跟既有的 aatroxModel
// 同一種命名），中文檔名之類轉不出英數字的就用 model1、model2…。不跟既有的撞名。
function suggestModelKey(fileName, existingKeys = []) {
  const base = path.basename(String(fileName || ''), path.extname(String(fileName || '')));
  const words = base.match(/[A-Za-z0-9]+/g) || [];
  let stem = words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join('');
  if (stem && /^\d/.test(stem)) stem = 'm' + stem;
  const taken = new Set(existingKeys);
  if (stem) {
    const key = stem.endsWith('Model') ? stem : stem + 'Model';
    if (!taken.has(key)) return key;
    for (let i = 2; ; i++) if (!taken.has(key + i)) return key + i;
  }
  for (let i = 1; ; i++) if (!taken.has('model' + i)) return 'model' + i;
}

// GLB 的動畫名稱清單：GLB 檔頭後面第一個 chunk 就是 glTF JSON，animations[].name
// 直接讀得到，不用把整顆模型（可能上百 MB）載入 three.js。也支援純 .gltf（整個檔案就是 JSON）。
function readGltfJson(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(20);
    fs.readSync(fd, head, 0, 20, 0);
    if (head.toString('latin1', 0, 4) !== 'glTF') {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
    const chunkLength = head.readUInt32LE(12);
    const chunkType = head.toString('latin1', 16, 20);
    if (chunkType !== 'JSON') throw new Error('GLB 第一個 chunk 不是 JSON');
    const json = Buffer.alloc(chunkLength);
    fs.readSync(fd, json, 0, chunkLength, 20);
    return JSON.parse(json.toString('utf8'));
  } finally {
    fs.closeSync(fd);
  }
}

function listGlbAnimations(filePath) {
  const gltf = readGltfJson(filePath);
  return (gltf.animations || []).map((a, i) => a.name || `animation_${i}`);
}

// ── 2D（live2d_my_like）────────────────────────────────────────────────

function isLive2DModelJson(name) {
  const n = name.toLowerCase();
  return n.endsWith('.model3.json') || n === 'model.json' || n.endsWith('.model.json');
}

function findLive2DModelJsons(dir) {
  const found = [];
  (function walk(d) {
    let items;
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const full = path.join(d, it.name);
      if (it.isDirectory()) walk(full);
      else if (isLive2DModelJson(it.name)) found.push(full);
    }
  })(dir);
  return found;
}

function readLive2DConfig(configDir = LIVE2D_CONFIG_DIR) {
  const read = (name, fallback) => {
    try { return JSON.parse(fs.readFileSync(path.join(configDir, name), 'utf8')); }
    catch (err) { if (err.code === 'ENOENT') return fallback; throw err; }
  };
  return { manifest: read('manifest.json', []), names: read('names.json', {}) };
}

// 資料夾名稱檢查：會直接當成 live2d_my_like/models/ 底下的資料夾名，也會寫進 .gitignore
function validateFolderName(name) {
  if (!name || !String(name).trim()) return '資料夾名稱不能空白';
  if (/[\\/:*?"<>|]/.test(name)) return '資料夾名稱不能有 \\ / : * ? " < > | 這些字元';
  if (name === '.' || name === '..') return '資料夾名稱不合法';
  return null;
}

// 把整個模型資料夾複製進 live2d_my_like/models/<folderName>/。回傳複製過去之後找到的
// model json 路徑（相對 live2d_my_like/，跟 manifest.json 的 path 欄位同格式）。
function importLive2DFolder(srcDir, folderName, modelsDir = LIVE2D_MODELS_DIR) {
  const bad = validateFolderName(folderName);
  if (bad) throw new Error(bad);
  const jsons = findLive2DModelJsons(srcDir);
  if (!jsons.length) {
    throw new Error('這個資料夾裡找不到 Live2D 模型設定檔（*.model3.json 或 model.json），確認選的是模型資料夾');
  }
  const dest = path.join(modelsDir, folderName);
  if (fs.existsSync(dest)) throw new Error(`models/ 底下已經有「${folderName}」資料夾，換一個名稱`);
  fs.cpSync(srcDir, dest, { recursive: true });
  return findLive2DModelJsons(dest).map((f) =>
    path.relative(path.dirname(modelsDir), f).split(path.sep).join('/')
  );
}

function numOrBlank(v) {
  if (isBlank(v)) return '';
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

// GUI 送上來的單一 2D 模型修改 → 檢查並整理成 manifest 的欄位格式。
// layout 沿用 manifest 的慣例：沒填＝空字串（不是拿掉欄位），見 generate-manifest.js。
// partOverrides/paramOverrides 是 [{ id, value }] 列表，轉成物件。
function normalizeLive2DPatch(patch) {
  const errors = [];
  const p = patch || {};
  const layout = {};
  for (const f of ['offsetX', 'offsetY', 'scale', 'headRatio', 'headXRatio']) {
    const v = numOrBlank(p.layout && p.layout[f]);
    if (Number.isNaN(v)) errors.push(`${f} 要填數字或留空`);
    layout[f] = Number.isNaN(v) ? '' : v;
  }
  const grow = p.layout && p.layout.bubbleGrow;
  layout.bubbleGrow = grow === 'left' || grow === 'right' ? grow : '';

  const chatSounds = (Array.isArray(p.chatSounds) ? p.chatSounds : [])
    .map((s) => String(s || '').trim())
    .filter(Boolean);

  const toMap = (rows, label, range) => {
    const out = {};
    for (const row of Array.isArray(rows) ? rows : []) {
      const id = String((row && row.id) || '').trim();
      if (!id) continue;
      const v = numOrBlank(row.value);
      if (v === '' || Number.isNaN(v)) { errors.push(`${label}「${id}」的數值要填數字`); continue; }
      if (range && (v < range[0] || v > range[1])) { errors.push(`${label}「${id}」要在 ${range[0]}~${range[1]} 之間`); continue; }
      if (id in out) { errors.push(`${label}「${id}」重複了`); continue; }
      out[id] = v;
    }
    return out;
  };
  const partOverrides = toMap(p.partOverrides, 'Part 透明度', [0, 1]);
  const paramOverrides = toMap(p.paramOverrides, '參數', null);
  return { errors, value: { layout, chatSounds, partOverrides, paramOverrides } };
}

// 存一個 2D 模型的設定：改 manifest.json 那一筆的 layout/chatSounds/partOverrides/
// paramOverrides，跟 names.json 的顯示名稱。其他欄位（id/path/character/cubism）不動。
function saveLive2DEntry(modelPath, patch, configDir = LIVE2D_CONFIG_DIR) {
  const { errors, value } = normalizeLive2DPatch(patch);
  if (errors.length) return { ok: false, errors };
  const { manifest, names } = readLive2DConfig(configDir);
  const entry = manifest.find((e) => e.path === modelPath);
  if (!entry) return { ok: false, errors: [`manifest.json 裡找不到 ${modelPath}`] };
  Object.assign(entry, value);
  writeJsonAtomic(path.join(configDir, 'manifest.json'), manifest);
  const name = String((patch && patch.name) || '').trim();
  if (name && names[modelPath] !== name) {
    names[modelPath] = name;
    writeJsonAtomic(path.join(configDir, 'names.json'), names);
  }
  return { ok: true, errors: [], entry, name: names[modelPath] };
}

// .gitignore 的 Live2D 段落是「models/ 底下預設全部排除，逐一列例外」，例外的寫法是：
//   !/live2d_my_like/models/<資料夾>/
//   !/live2d_my_like/models/<資料夾>/**
function gitignoreHasLive2DException(text, folderName) {
  return String(text).split(/\r?\n/).some((l) => l.trim() === `!/live2d_my_like/models/${folderName}/`);
}

function addLive2DGitignoreException(text, folderName) {
  if (gitignoreHasLive2DException(text, folderName)) return text;
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const block = [
    '# ==================================================',
    `# 例外允許：${folderName}`,
    '# ==================================================',
    `!/live2d_my_like/models/${folderName}/`,
    `!/live2d_my_like/models/${folderName}/**`,
  ].join(eol);
  const lines = text.split(/\r?\n/);
  // 接在最後一條 Live2D 例外後面，跟其他例外放在一起；找不到就附加在檔尾。
  // 前後各空一行跟其他段落隔開，原本接在後面的空行保留給下一段。
  let last = -1;
  lines.forEach((l, i) => { if (l.startsWith('!/live2d_my_like/models/')) last = i; });
  if (last === -1) return text.replace(/\s*$/, '') + eol + eol + block + eol;
  const before = lines.slice(0, last + 1).join(eol);
  const rest = lines.slice(last + 1);
  while (rest.length && rest[0].trim() === '') rest.shift();
  return before + eol + eol + block + eol + (rest.length ? eol + rest.join(eol) : '');
}

// moc3 裡內嵌的 Parameter／Part ID（跟 live2d_my_like/config/scan-params.js 同一招：
// 直接在二進位檔裡找可列印字串），給 GUI 的覆蓋值欄位當下拉建議，不用自己去查。
function scanMocIds(mocPath) {
  const strings = fs.readFileSync(mocPath).toString('latin1').match(/[ -~]{4,}/g) || [];
  const params = new Set();
  const parts = new Set();
  for (const s of strings) {
    if (/^(PARAM_|Param)[\w]*$/.test(s)) params.add(s);
    else if (/^(PARTS?_|Part)[\w]*$/.test(s)) parts.add(s);
  }
  return { params: [...params].sort(), parts: [...parts].sort() };
}

module.exports = {
  SOURCES_JSON_PATH,
  MODELS_DIR,
  VOICE_DIR,
  BGM_DIR,
  REPO_ROOT,
  LIVE2D_ROOT,
  LIVE2D_CONFIG_DIR,
  LIVE2D_MODELS_DIR,
  GITIGNORE_PATH,
  pruneEmpty,
  listFiles,
  importFile,
  readParticleConfig,
  validateParticleEntry,
  validateParticleConfig,
  saveParticleConfig,
  suggestModelKey,
  listGlbAnimations,
  findLive2DModelJsons,
  readLive2DConfig,
  validateFolderName,
  importLive2DFolder,
  normalizeLive2DPatch,
  saveLive2DEntry,
  gitignoreHasLive2DException,
  addLive2DGitignoreException,
  scanMocIds,
};
