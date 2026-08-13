// 掃描 public/characters/models/，自動維護同目錄下的 manifest.json／names.json，
// 用法照抄 C:\question\live2d_my_like\config\generate-manifest.js 那支的慣例
// （新增模型資料夾後跑一次這支腳本，manifest.json/names.json 就會自動補上新角色、
// 拿掉已經刪掉的角色，同時保留手動調過的 layout／顯示名稱不被洗掉）。
//
// **跟 live2d_my_like 那支的差異**：desktop-pet-web 的 manifest.json 條目只有
// path/kind/layout 三欄（沒有 id/character/cubism/chatSounds/partOverrides/
// paramOverrides——那些是 live2d_my_like 桌寵疊加層專屬的欄位，這裡用不到），而且要
// 同時認兩種引擎：Live2D 用 *.model3.json 判斷；Spine 沒有固定副檔名，用「同資料夾
// 裡有一個 .atlas、檔名主體(basename)跟某個 .json 一樣」這個慣例判斷（例如
// asuna/asuna.json + asuna/asuna.atlas），對照 HeroLive2DStage.tsx 目前兩個 Spine
// 角色（asuna、當初的亞托克斯）都是這個檔名慣例。
//
// **manifest.json／names.json 是真的自動維護**：新角色補上、刪掉的角色移除、手動調過
// 的 layout／顯示名稱不會被洗掉。
//
// **HeroLive2DStage.tsx 的 MODELS 陣列不會被自動改動**：直接用腳本 regex/字串操作去改
// 別人手寫、格式講究的 TSX 原始碼風險太高，這裡不做。改成掃描該角色的 model3.json／
// Spine skeleton json，用檔名/動作名關鍵字（"skill"、"idle"、"attack" 等）猜出一份可以
// 直接貼進 MODELS 陣列的草稿，印在 console 裡——猜法是照現有三個角色（077／1024100／
// asuna）的實際規律反推出來的，這幾包資源猜得很準，但終究是字串比對，不保證每包資源都
// 猜對。**貼進 MODELS 陣列之前一定要實際看過動作播出來對不對**，這一步是視覺判斷，沒辦法
// 交給腳本。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CONFIG_DIR = path.dirname(fileURLToPath(import.meta.url))
const MODELS_ROOT = path.join(CONFIG_DIR, '..', 'models')
const MANIFEST_PATH = path.join(CONFIG_DIR, 'manifest.json')
const NAMES_PATH = path.join(CONFIG_DIR, 'names.json')
const HERO_STAGE_PATH = path.join(CONFIG_DIR, '..', '..', '..', 'src', 'pages', 'desktop-pet', 'components', 'HeroLive2DStage.tsx')

function walk(dir, fileList = []) {
  let items
  try {
    items = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return fileList
  }
  for (const it of items) {
    const full = path.join(dir, it.name)
    if (it.isDirectory()) walk(full, fileList)
    else fileList.push(full)
  }
  return fileList
}

const allFiles = walk(MODELS_ROOT)

const live2dPaths = allFiles
  .filter((f) => /\.model3\.json$/i.test(f))
  .map((f) => path.relative(MODELS_ROOT, f).split(path.sep).join('/'))

const jsonFiles = allFiles.filter((f) => /\.json$/i.test(f) && !/\.model3\.json$/i.test(f))
const atlasKeys = new Set(
  allFiles
    .filter((f) => /\.atlas$/i.test(f))
    .map((f) => `${path.dirname(f)}::${path.basename(f, path.extname(f))}`),
)
const spinePaths = jsonFiles
  .filter((f) => atlasKeys.has(`${path.dirname(f)}::${path.basename(f, '.json')}`))
  .map((f) => path.relative(MODELS_ROOT, f).split(path.sep).join('/'))

const found = [
  ...live2dPaths.map((p) => ({ path: p, kind: 'live2d' })),
  ...spinePaths.map((p) => ({ path: p, kind: 'spine' })),
].sort((a, b) => a.path.localeCompare(b.path))

// 「檔案不存在」（第一次執行）跟「檔案存在但壞掉」要分開處理：前者是正常情況，視為
// 空白繼續往下跑；後者如果也悄悄當成空白繼續跑，會把手動調過的 layout 全部當「舊的
// 沒有」，最後把空白結果直接覆寫回 manifest.json，等於永久洗掉——所以壞掉時直接中止、
// 不寫入任何檔案，逼你先手動修好語法。
let oldEntryByPath = {}
let rawOld = null
try {
  rawOld = fs.readFileSync(MANIFEST_PATH, 'utf8')
} catch {
  // 檔案不存在，第一次執行，維持空白正常繼續
}
if (rawOld !== null) {
  let old
  try {
    old = JSON.parse(rawOld)
    if (!Array.isArray(old)) throw new Error('manifest.json 最外層必須是陣列')
  } catch (err) {
    console.error(
      `[generate-manifest] manifest.json 目前壞掉了（${err.message}），為了避免洗掉現有的 layout 校正值，已經中止、沒有寫入任何檔案。請先手動修好 manifest.json 的語法，再重新執行這支腳本。`,
    )
    process.exit(1)
  }
  old.forEach((e) => {
    oldEntryByPath[e.path] = e
  })
}

const EMPTY_LAYOUT = { offsetX: '', offsetY: '', scale: '' }
const entries = found.map(({ path: p, kind }) => {
  const old = oldEntryByPath[p]
  const oldHasRealValues =
    old && old.layout && Object.values(old.layout).some((v) => v !== '' && v !== undefined && v !== null)
  return {
    path: p,
    kind,
    layout: oldHasRealValues ? old.layout : { ...EMPTY_LAYOUT },
  }
})

const oldPaths = Object.keys(oldEntryByPath)
const foundPathSet = new Set(found.map((e) => e.path))
const added = entries.filter((e) => !(e.path in oldEntryByPath)).map((e) => e.path)
const removed = oldPaths.filter((p) => !foundPathSet.has(p))

fs.writeFileSync(MANIFEST_PATH, JSON.stringify(entries, null, 2) + '\n')

// names.json：只在新路徑還沒有對應名稱時補上預設值（角色資料夾名），已經手動編輯過的
// 名稱不會被動到；模型被刪除時，對應的名稱項目留著當孤兒紀錄，不主動清掉（跟
// live2d_my_like 那支同樣的保守做法，避免誤刪使用者手動取的名字）。
let names = {}
try {
  names = JSON.parse(fs.readFileSync(NAMES_PATH, 'utf8'))
} catch (err) {
  if (err.code !== 'ENOENT') {
    console.warn('[generate-manifest] 讀取 names.json 失敗，將視為空清單重建（既有名字可能被蓋掉）：', err.message)
  }
}
let namesChanged = false
for (const { path: p } of entries) {
  if (!(p in names)) {
    names[p] = p.split('/')[0]
    namesChanged = true
  }
}
if (namesChanged || !fs.existsSync(NAMES_PATH)) {
  fs.writeFileSync(NAMES_PATH, JSON.stringify(names, null, 2) + '\n')
}

// 提醒：這裡只能靠字串比對粗略檢查 HeroLive2DStage.tsx 的 MODELS 陣列裡有沒有提到
// 這個角色資料夾名（url 裡含有 "/角色資料夾名/"），抓不到「有提到但其實填錯」這種
// 情況，只能當作「完全沒提到、你大概忘了加」的提示，不是嚴謹的驗證。
let heroStageSrc = ''
try {
  heroStageSrc = fs.readFileSync(HERO_STAGE_PATH, 'utf8')
} catch {
  // 讀不到就跳過這個提醒，manifest/names 該寫的還是寫了
}
const missingInHeroStage = heroStageSrc
  ? [...new Set(entries.map((e) => e.path.split('/')[0]))].filter(
      (folder) => !heroStageSrc.includes(`/characters/models/${folder}/`),
    )
  : []

console.log(`[generate-manifest] 掃到 ${entries.length} 個模型：`)
entries.forEach((e) => console.log(`  [${e.kind}] ${e.path}  (${names[e.path]})`))
if (added.length) console.log(`[generate-manifest] 新增：${added.join(', ')}`)
if (removed.length) console.log(`[generate-manifest] 已從 manifest.json 移除（檔案不在了）：${removed.join(', ')}`)
if (missingInHeroStage.length) {
  console.log(
    `[generate-manifest] 提醒：以下角色資料夾在 manifest.json 裡了，但 HeroLive2DStage.tsx 的 MODELS 陣列裡沒找到對應 url，Hero 輪播不會顯示——底下會印出「猜的」MODELS 條目草稿，貼進去之前務必先實際看過動作對不對：`,
  )
  for (const folder of missingInHeroStage) {
    console.log(suggestModelsEntry(folder))
  }
}

// **草稿產生器，不是最終答案**：只用檔名/動作名關鍵字猜「哪些是技能動作、哪個是待機」，
// 猜法照抄現有三個角色的實際規律反推（見下面兩個函式各自的說明），對這幾包資源猜得很準，
// 但終究是字串比對，猜錯了也不會有任何錯誤訊息——貼進 MODELS 陣列前一定要實際點開角色
// 看動作播出來對不對，跟 Aatrox 當初「skins 清單挑了 MechaSwordsman，如果畫面上看起來
// 不對再換」是同一個道理，這一步沒辦法透過腳本代勞。
function suggestModelsEntry(folder) {
  const live2d = entries.find((e) => e.kind === 'live2d' && e.path.startsWith(`${folder}/`))
  const spine = entries.find((e) => e.kind === 'spine' && e.path.startsWith(`${folder}/`))
  if (live2d) return suggestLive2DEntry(folder, live2d.path)
  if (spine) return suggestSpineEntry(folder, spine.path)
  return `  // "${folder}"：掃到的檔案裡沒有找到 kind，略過草稿產生`
}

// Live2D 猜法：讀 model3.json 的 FileReferences.Motions，逐個 group 找檔名含
// "skill"（不分大小寫）的項目——077（motionIndices:[1,2,3]，對應 skill_02~04）跟
// 1024100（motionIndices:[0,16]，對應 00_Skill_02/00_Skill_01）這兩個既有角色的
// motionIndices，都能被這個關鍵字規則精確反推出來，才拿來當猜測依據，不是憑空亂猜。
// 猜不到（沒有任何檔名含 "skill"）就把所有 group／index 都列出來，讓你自己挑。
function suggestLive2DEntry(folder, relPath) {
  const absPath = path.join(MODELS_ROOT, relPath)
  let data
  try {
    data = JSON.parse(fs.readFileSync(absPath, 'utf8'))
  } catch (err) {
    return `  // "${folder}"：讀取或解析 ${relPath} 失敗（${err.message}），無法產生草稿`
  }
  const motions = data?.FileReferences?.Motions
  if (!motions || typeof motions !== 'object') {
    return `  // "${folder}"：${relPath} 裡沒有 FileReferences.Motions，無法產生草稿`
  }

  const groupSummaries = []
  let bestGroup = null
  let idleGuess = null // { groupKey, index, reason }
  for (const [groupKey, files] of Object.entries(motions)) {
    const indices = (files || []).map((_, i) => i)
    const skillIndices = indices.filter((i) => /skill/i.test(files[i]?.File ?? ''))
    groupSummaries.push(`  //   group ${JSON.stringify(groupKey)}：共 ${files.length} 個，index ${indices.join(',')}`)
    if (skillIndices.length && (!bestGroup || skillIndices.length > bestGroup.indices.length)) {
      bestGroup = { groupKey, indices: skillIndices }
    }
    // idleMotionIndex 猜法：檔名含 "idle"/"wait"（不分大小寫）的優先；077（index 0，
    // 檔名跟 moc3 同名 c_7002）、1024100（index 17，00_Wait_01）這兩個既有角色都能被
    // 「idle/wait 關鍵字，抓不到就退回跟 moc3 同名的那個檔案」這個規則命中。
    const idleIdx = indices.find((i) => /idle|wait/i.test(files[i]?.File ?? ''))
    if (idleIdx !== undefined && !idleGuess) idleGuess = { groupKey, index: idleIdx, reason: '檔名含 "idle"/"wait"' }
  }
  if (!idleGuess) {
    const moc = data?.FileReferences?.Moc ?? ''
    const mocBase = moc.replace(/\.moc3$/i, '')
    for (const [groupKey, files] of Object.entries(motions)) {
      const idx = (files || []).findIndex((f) => (f?.File ?? '').includes(mocBase) && mocBase)
      if (idx >= 0) {
        idleGuess = { groupKey, index: idx, reason: `檔名跟 moc3（${mocBase}）同名` }
        break
      }
    }
  }

  const idleLine = idleGuess
    ? `    idleMotionIndex: ${idleGuess.index}, // 猜的：${idleGuess.reason}${idleGuess.groupKey !== (bestGroup?.groupKey ?? '') ? `（group ${JSON.stringify(idleGuess.groupKey)}，注意跟上面 motionGroup 是不是同一個）` : ''}`
    : `    idleMotionIndex: 0, // 沒猜到，自己從上面清單挑一個「站好、沒在出招」的當待機`

  const guessed = bestGroup
    ? `  {\n    kind: 'live2d',\n    id: '${folder}',\n    url: '/characters/models/${relPath}',\n    label: '模型 ${folder}',\n    motionGroup: ${JSON.stringify(bestGroup.groupKey)},\n    motionIndices: [${bestGroup.indices.join(', ')}], // 猜的：檔名含 "skill"\n${idleLine}\n  },`
    : `  {\n    kind: 'live2d',\n    id: '${folder}',\n    url: '/characters/models/${relPath}',\n    label: '模型 ${folder}',\n    motionGroup: '', // 沒猜到，檔名沒有 "skill" 關鍵字，自己從下面清單挑\n    motionIndices: [], // TODO\n${idleLine}\n  },`

  return [`  // "${folder}"（${relPath}）可用的 group/index：`, ...groupSummaries, guessed].join('\n')
}

// Spine 猜法：讀 skeleton json 的 .animations 鍵名——含 "idle" 的當 idleAnimation，
// 含 attack/skill/punch/sword/magic/combo 的當 clickAnimations 候選。Asuna 既有的
// clickAnimations（08_SwordAttack/05_MagicAttack/06_PunchAttack）用這個規則能完整
// 反推出來，才拿來當猜測依據。skinName 只有在 .skins 清單裡有一個「非 default」的
// skin、且名字看起來跟資料夾名相關時才猜，其餘一律列出候選、不猜。
function suggestSpineEntry(folder, relPath) {
  const absPath = path.join(MODELS_ROOT, relPath)
  let data
  try {
    data = JSON.parse(fs.readFileSync(absPath, 'utf8'))
  } catch (err) {
    return `  // "${folder}"：讀取或解析 ${relPath} 失敗（${err.message}），無法產生草稿`
  }
  const animNames = Object.keys(data?.animations ?? {})
  const idle = animNames.find((n) => /idle/i.test(n)) ?? animNames[0]
  const clicks = animNames.filter((n) => n !== idle && /attack|skill|punch|sword|magic|combo/i.test(n))
  const skinNames = (data?.skins ?? []).map((s) => s.name).filter(Boolean)
  const skinCandidate = skinNames.find(
    (n) => n.toLowerCase() !== 'default' && (n.toLowerCase().includes(folder.toLowerCase()) || folder.toLowerCase().includes(n.toLowerCase())),
  )

  const lines = [`  // "${folder}"（${relPath}）animations：${animNames.join(', ') || '（無）'}`]
  if (skinNames.length > 1) lines.push(`  // skins：${skinNames.join(', ')}${skinCandidate ? `（猜：${skinCandidate}）` : '（沒猜到對應的，自己挑）'}`)
  lines.push(
    `  {`,
    `    kind: 'spine',`,
    `    id: '${folder}',`,
    `    url: '/characters/models/${relPath}',`,
    `    label: '模型 ${folder}',`,
    `    idleAnimation: ${JSON.stringify(idle ?? '')}, ${idle ? '' : '// 沒猜到，animations 是空的'}`,
    `    clickAnimations: [${clicks.map((n) => JSON.stringify(n)).join(', ')}], ${clicks.length ? '// 猜的：動作名含 attack/skill/punch/sword/magic/combo' : '// 沒猜到，自己從上面 animations 清單挑'}`,
    ...(skinCandidate ? [`    skinName: ${JSON.stringify(skinCandidate)}, // 猜的，畫面不對就換成 skins 清單裡別的`] : []),
    `  },`,
  )
  return lines.join('\n')
}
