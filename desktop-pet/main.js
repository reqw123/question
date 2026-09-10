'use strict';
const { app, BrowserWindow, globalShortcut, screen, Tray, Menu, nativeImage, ipcMain, session, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const settingsStore = require('./settings-store.js');
const { synthesizeSpeech } = require('./tts.js');
const { sendChatMessage } = require('./chat.js');
const { sendOllamaChatMessage, listOllamaModels } = require('./ollama.js');
const { ClaudeCliSession, interpretYesNo } = require('./claude-cli.js');
const { fetchPageText } = require('./page-digest.js');
const chatMemoryStore = require('./chat-memory-store.js');
const { transcribeAudio } = require('./stt.js');
const { startControlServer } = require('./control-server.js');

// 未預期的錯誤一律印到終端機，不讓主行程默默中止（方便排查）
process.on('uncaughtException', (err) => {
  console.error('[desktop-pet] 未預期錯誤，程式可能已停止運作：', err);
});

// Windows 的原生視窗遮擋偵測（CalculateNativeWinOcclusion）會在桌寵這個全螢幕透明視窗
// 被別的全螢幕視窗（例如「桌面便利貼牆」Shift+X 展開時）整片蓋住時，把桌寵 renderer
// 判定為「完全被遮住」→ 合成器停止產生畫格、requestAnimationFrame / PIXI Ticker 幾乎
// 停擺，Live2D 模型就凍住不動；把蓋在上面的視窗收掉才恢復。這個偵測不看上層視窗是不是
// 透明的，所以透明的牆一樣會觸發。關掉它，桌寵被任何視窗蓋住時都繼續算圖。
// 必須在 app ready 之前呼叫才有效。
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

// 16x16 純色圖示（跟專案 --cyan 配色一致），內嵌成 data URL，不依賴外部圖片檔案，避免格式問題導致系統匣建立失敗
const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFUlEQVR4nGNguPKfNDSqYVTD8NUAAEXm0xCHDYjgAAAAAElFTkSuQmCC';

let win;
let tray;
let clickThrough = true;

// ── live2d_my_like 角色選擇：改在系統匣右鍵選單配置（不用 index.html 上的按鈕/下拉選單，
// 原生選單樣式跟著系統走，不會有 HTML <select> 選項清單在深色主題下變白底看不清楚的問題）──
// manifest/names 是主行程直接用 fs 讀（跟 renderer 端 fetch 的是同一份檔案，內容一樣）；
// 實際選到的模型資源，還是只由 index.html 載入時套用的那一個路徑去請求，跟這裡列出幾個選項無關。
let myLikeManifest = [];
let myLikeNames    = {};
// current = 目前已套用（reload 後生效）的選擇；pending = 選單裡目前勾選、還沒按「套用」的選擇
let currentChar1 = '', currentChar2 = '';
let pendingChar1 = '', pendingChar2 = '';

// 角色一/二「顯示中/已隱藏」——即時生效，不用像上面 pending/套用那組要整頁 reload
// （見 index.html 的 window.setCharVisible()）。純粹是這次開機期間的狀態，不寫進
// settings.json：跟 clickThrough、particleEffectOn 開機後的即時切換一樣，只管「現在
// 這一次執行期間」，不是「開機預設值」那種要跨重啟記住的設定。
let charVisible = { c1: true, c2: true };
const CHAR_MENU_KEY_TO_STATE_KEY = { char1: 'c1', char2: 'c2' };

// 額外寵物（自由遊走，見 desktop-pet/index.html 的 loadExtraPet）：跟 char1/char2 那組
// 「單選＋pending/套用」是同一種模式——勾選只是暫存，按「確定套用」才會真的新增/銷毀，
// 差別只在套用方式：char1/char2 用整頁 reload，額外寵物用即時新增/銷毀（不用 reload，
// 避免打斷桌寵原本已經在跑的其他動畫）。extraPetIds 是目前「已套用」的清單，
// pendingExtraPetIds 是選單上「目前勾選、還沒按套用」的清單。
let extraPetIds = [];
let pendingExtraPetIds = [];

// 額外寵物隨機遊走總開關（全體共用一個，不分寵物）。刻意不存 localStorage——
// 跟 clickThrough 一樣，每次重開桌寵預設「開」，不用像位置/縮放那樣記住上次設定。
let extraPetWander = true;

// 光粒子裝飾（particle-effect/particle-effect.js）開關：獨立於 Live2D 角色之外，
// 初始值來自使用者在設定畫面存的「開機預設顯示」（settingsStore.getShowParticleModelOnStartup()，
// 沒設定過就是 false，跟原本寫死的預設一致）。這裡的初始值只在「桌寵這次真的剛啟動」
// 時有意義——之後任何 reload（F8、套用角色選擇...）particleEffectOn 都是靠
// syncParticleEffectEnabledFromRenderer() 讀 renderer 的真實狀態校正（見那個函式的
// 說明：reload 後 renderer 一律回到關閉，這是刻意修好的行為），不會再套用這個開機
// 預設值，兩者互不衝突（見 did-finish-load 那段 hasAppliedParticleEffectStartupDefault
// 的說明）。
let particleEffectOn = settingsStore.getShowParticleModelOnStartup();
// 上面 particleEffectOn 的開機預設值只應該在「桌寵這次真的剛啟動」套用一次
// （執行 window.setParticleEffect(true)），不能每次 reload 都套用，否則會把 F8
// 「reload 一律回到關閉」的既有修正蓋掉，變成每次 F8 都自動重新打開特效。
let hasAppliedParticleEffectStartupDefault = false;

// 「模型序列播放」（一鍵觸發、在 sources.js 設定的多個模型之間連續變形、無限
// 循環播放，直到手動停止，見 particle-effect.js 的 window.setParticleSequencePlayback()）
// 開關。刻意不像 particleEffectOn 那樣有「開機預設顯示」選項——這是一次性觸發的
// 展示效果，不是常駐狀態，每次開機/reload 都預設關閉即可。
let particleSequenceOn = false;

function loadMyLikeManifest() {
  try {
    const dir = path.join(__dirname, '..', 'live2d_my_like', 'config');
    myLikeManifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    myLikeNames    = JSON.parse(fs.readFileSync(path.join(dir, 'names.json'), 'utf8'));
  } catch (err) {
    console.warn('[desktop-pet] 讀取 live2d_my_like 清單失敗，角色選單將只有「預設」選項：', err.message);
    myLikeManifest = [];
    myLikeNames    = {};
  }
}

// 視窗載入/重新整理完成後，跟 renderer 的 localStorage 對一次目前實際套用的選擇，
// 避免主行程這邊的 current/pending 狀態跟畫面上實際生效的模型不同步
function syncMyLikeSelectionFromRenderer() {
  // 這裡掛在 did-finish-load，任何讓頁面重新整理的操作（F8 還原位置、套用角色選擇）都會觸發，
  // 舊頁面裡飛行動畫用的 JS 執行環境會直接被砍掉重來，角色瞬間回到 L2D_CFG 預設位置，
  // 但 isFlying 是 main.js 自己記的狀態，不會知道頁面重新整理過，這裡順便同步歸零，
  // 選單 label 才不會卡在「⏹ 停止飛行」。
  isFlying = false;
  return win.webContents
    .executeJavaScript(
      `({
        c1: localStorage.getItem('l2d_mylike_d_char1') || '',
        c2: localStorage.getItem('l2d_mylike_d_char2') || '',
        extra: localStorage.getItem('l2d_extra_pets_d') || '[]',
      })`
    )
    .then(({ c1, c2, extra }) => {
      currentChar1 = pendingChar1 = c1;
      currentChar2 = pendingChar2 = c2;
      // id 1/2（納茲/露西）保留給角色一/角色二，額外寵物候選清單本來就不會列出這兩個 id
      // （見 getExtraPetCandidates 的排除規則），這裡防禦性地一併過濾，避免萬一
      // localStorage 殘留舊資料時，選單狀態跟 index.html 的自我修復邏輯之間短暫不一致。
      try { extraPetIds = JSON.parse(extra).filter((id) => id !== 1 && id !== 2); } catch { extraPetIds = []; }
      pendingExtraPetIds = extraPetIds.slice();
      // extraPetWander 不像 c1/c2/extraPetIds 存在 localStorage 裡（本來就不打算存檔），
      // 這裡反過來是主行程「推」目前的開關狀態給剛重整完的頁面，不是讀頁面的值——
      // 頁面重新整理後 window._extraPetWanderEnabled 會回到腳本裡寫死的預設 true，
      // 要蓋回 main.js 記的狀態，選單開關才不會跟畫面實際行為不同步。
      win.webContents
        .executeJavaScript(`window.setExtraPetWander && window.setExtraPetWander(${extraPetWander});`)
        .catch(() => {});
      if (tray) tray.setContextMenu(buildTrayMenu());
    })
    .catch((err) => console.warn('[desktop-pet] 讀取目前角色選擇失敗：', err.message));
}

// 切換「額外寵物隨機遊走」總開關：全體共用，不分寵物，即時生效（不用整頁 reload）
function toggleExtraPetWander() {
  extraPetWander = !extraPetWander;
  win.webContents
    .executeJavaScript(
      `(function() {
        if (window.setExtraPetWander) { window.setExtraPetWander(${extraPetWander}); return true; }
        return false;
      })();`
    )
    .then((ok) => {
      if (!ok) console.warn('[desktop-pet] 額外寵物遊走開關尚未就緒（L2D 可能還在載入中），下次重新整理後會生效');
    })
    .catch((err) => console.error('[desktop-pet] 切換額外寵物遊走開關失敗：', err))
    .finally(() => { if (tray) tray.setContextMenu(buildTrayMenu()); });
}

// 切換「光粒子特效」開關：跟 toggleExtraPetWander() 同一種寫法，呼叫
// particle-effect/particle-effect.js 掛在 window 上的 setParticleEffect()。
// 該模組要先讀完 GLB 才算「就緒」，開關可能在還沒就緒時就被按下——setParticleEffect()
// 自己會記住目標狀態、等就緒後補套用，這裡收到 ok:false 只是印個提示，不是錯誤。
function toggleParticleEffect() {
  particleEffectOn = !particleEffectOn;
  win.webContents
    .executeJavaScript(
      `(function() {
        if (window.setParticleEffect) { return window.setParticleEffect(${particleEffectOn}); }
        return false;
      })();`
    )
    .then((ok) => {
      if (!ok) console.warn('[desktop-pet] 光粒子特效尚未就緒（模型可能還在載入中），就緒後會自動套用目前的開關狀態');
    })
    .catch((err) => console.error('[desktop-pet] 切換光粒子特效失敗：', err))
    .finally(() => { if (tray) tray.setContextMenu(buildTrayMenu()); });
}

// 切換「模型序列播放」開關：跟 toggleParticleEffect() 同一種寫法，呼叫
// particle-effect.js 掛在 window 上的 setParticleSequencePlayback()。那個函式是
// async（開啟時要先載入 sequenceModels 清單裡的每個模型才算真的播放起來），
// Electron 的 executeJavaScript 會等 IIFE 回傳的 Promise resolve 才進到
// .then()，所以這裡不用另外處理「非同步中」的中間狀態——收到 ok:false 代表
// 還沒就緒/正忙/取樣站數不足，印個提示，不是致命錯誤。
function toggleParticleSequence() {
  particleSequenceOn = !particleSequenceOn;
  win.webContents
    .executeJavaScript(
      `(function() {
        if (window.setParticleSequencePlayback) { return window.setParticleSequencePlayback(${particleSequenceOn}); }
        return false;
      })();`
    )
    .then((ok) => {
      if (!ok) {
        particleSequenceOn = false; // 沒有真的生效就把選單勾選狀態改回去，不要跟畫面實際狀態脫勾
        console.warn('[desktop-pet] 模型序列播放沒有生效（可能還沒就緒、正忙、或取樣站數不足），已還原開關狀態');
      }
    })
    .catch((err) => {
      particleSequenceOn = false;
      console.error('[desktop-pet] 切換模型序列播放失敗：', err);
    })
    .finally(() => { if (tray) tray.setContextMenu(buildTrayMenu()); });
}

// 「光粒子特效」子選單裡列出的模型清單，讀自 particle-effect/sources.js。
// sources.js 是 particle-effect.js（renderer 端）用 <script type="module"> 直接
// import 的 ES module，跟 main.js 這支 CommonJS 檔案是不同的模組系統，不能直接
// require()——particle-effect/package.json 的 {"type":"module"} 讓 Node 也能把
// 它當 ES module 動態 import()。URL 加時間戳查詢字串是為了繞過 Node 的 ES module
// cache，確保每次都讀到磁碟上最新內容（跟「情境演出」子選單每次開都重讀
// scenes.json 是同一種「改完設定不用重開桌寵」體驗）；讀取失敗（例如 sources.js
// 語法錯了）就維持舊清單，不讓桌寵其他功能被拖垮。
let particleModelKeys = [];
// 目前作用中的模型 key。null 代表還沒跟 renderer 同步過——這裡不寫死預設值去對齊
// particle-effect.js 的 DEFAULT_MODEL，改成用 syncParticleModelFromRenderer()
// （did-finish-load 時）跟 renderer 問真正的值，兩邊只要維護一份就好。
let activeParticleModel = null;

async function refreshParticleModelKeys() {
  try {
    const url = pathToFileURL(path.join(__dirname, 'particle-effect', 'sources.js')).href + `?t=${Date.now()}`;
    const mod = await import(url);
    particleModelKeys = Object.keys(mod.default || {});
  } catch (err) {
    console.warn('[desktop-pet] 讀取光粒子模型清單失敗（particle-effect/sources.js 可能有語法錯誤）：', err.message);
  }
}

// sources.js 改了（例如加一個新模型）就自動重讀清單、重畫選單，不用重開桌寵。
// Windows 上同一次存檔常常連續觸發兩次 change 事件，debounce 一下避免重複刷新。
let particleSourcesWatchTimer = null;
function watchParticleModelSources() {
  const sourcesPath = path.join(__dirname, 'particle-effect', 'sources.js');
  try {
    fs.watch(sourcesPath, () => {
      clearTimeout(particleSourcesWatchTimer);
      particleSourcesWatchTimer = setTimeout(() => {
        refreshParticleModelKeys().then(() => { if (tray) tray.setContextMenu(buildTrayMenu()); });
      }, 300);
    });
  } catch (err) {
    console.warn('[desktop-pet] 監看 particle-effect/sources.js 失敗（模型清單只能靠重開桌寵刷新）：', err.message);
  }
}

// 系統匣選單點模型清單裡的某一個：跟 toggleParticleEffect() 同一種
// executeJavaScript 寫法，呼叫 particle-effect.js 掛的 setParticleActiveModel()。
// 該函式自己會處理「目前正顯示中就先消散、換完模型再重新聚合」的動畫轉場，
// 這裡不用管顯示狀態，也不用等它真的換完才更新選單勾選。
function selectParticleModel(key) {
  activeParticleModel = key;
  win.webContents
    .executeJavaScript(
      `(function() {
        if (window.setParticleActiveModel) { return window.setParticleActiveModel(${JSON.stringify(key)}); }
        return false;
      })();`
    )
    .then((ok) => {
      if (!ok) console.warn(`[desktop-pet] 光粒子模型切換尚未就緒或找不到 "${key}"`);
    })
    .catch((err) => console.error('[desktop-pet] 切換光粒子模型失敗：', err))
    .finally(() => { if (tray) tray.setContextMenu(buildTrayMenu()); });
}

// 跟 syncMyLikeSelectionFromRenderer() 同一種「reload 後跟畫面實際狀態對一次」
// 的必要性：particle-effect.js 每次重新初始化都會用它自己的 DEFAULT_MODEL，
// 這裡讀回來才知道選單該勾哪一個，不用在 main.js 這邊重複寫死同一個預設值。
function syncParticleModelFromRenderer() {
  win.webContents
    .executeJavaScript(`window.getParticleActiveModel ? window.getParticleActiveModel() : null`)
    .then((key) => {
      if (key && key !== activeParticleModel) {
        activeParticleModel = key;
        if (tray) tray.setContextMenu(buildTrayMenu());
      }
    })
    .catch(() => {});
}

// 把目前真正的互動/穿透狀態推給 particle-effect.js，讓它知道現在滑鼠移到粒子
// 模型上該不該顯示「抓取」游標——mousemove 因為 win.setIgnoreMouseEvents 的
// forward:true 選項，穿透模式下還是會送到 renderer（這是既有 F9 機制的既定
// 行為），但穿透模式下實際上完全點不到、拖不動任何東西，游標卻顯示可抓取會
// 誤導使用者，所以 renderer 端無法只靠「有沒有收到 mousemove」自己判斷，
// 需要 main.js 主動把 clickThrough 的反相值推過去。setClickThrough() 每次
// 切換都會呼叫；reload 後（F8、套用角色選擇...）particle-effect.js 重新初始化
// 預設值又會歸零，所以 did-finish-load 也要補呼叫一次。
function syncParticleEffectStateFromMain() {
  win.webContents
    .executeJavaScript(
      `(function() {
        if (window.setParticleEffectInteractiveMode) { window.setParticleEffectInteractiveMode(${!clickThrough}); }
        return true;
      })();`
    )
    .catch(() => {});
}

// 跟 syncParticleModelFromRenderer() 同一種「reload 後跟畫面實際狀態對一次」的
// 必要性，但方向反過來：particleEffectOn 是 main.js 自己記的一份狀態（系統匣
// 「光粒子特效」開關的勾選/標籤用這個），particle-effect.js 每次 reload 都是全新
// 模組實例、一定會回到關閉狀態（見 window.getParticleEffectEnabled() 開頭的說明），
// 但 reload 不會自動幫忙把 particleEffectOn 這個 main.js 這邊的變數改回 false——
// 沒有這個同步的話，F8 之後畫面上的特效確實變回關閉了，系統匣選單卻還停在
// reload 前的勾選狀態，兩邊對不上（使用者會看到選單寫「關閉」這個下一步動作，
// 以為現在是開著的，但畫面早就是關的）。
function syncParticleEffectEnabledFromRenderer() {
  win.webContents
    .executeJavaScript(`window.getParticleEffectEnabled ? window.getParticleEffectEnabled() : false`)
    .then((enabled) => {
      if (enabled !== particleEffectOn) {
        particleEffectOn = enabled;
        if (tray) tray.setContextMenu(buildTrayMenu());
      }
    })
    .catch(() => {});
}

// 跟 syncParticleEffectEnabledFromRenderer() 完全同一種必要性、同一種寫法，只是
// 問的是「模型序列播放」——reload 後 particle-effect.js 是全新模組實例，
// sequenceModeActive 一定會回到 false，這裡讀回來才能讓系統匣選單勾選狀態對齊。
function syncParticleSequenceEnabledFromRenderer() {
  win.webContents
    .executeJavaScript(`window.getParticleSequencePlaying ? window.getParticleSequencePlaying() : false`)
    .then((playing) => {
      if (playing !== particleSequenceOn) {
        particleSequenceOn = playing;
        if (tray) tray.setContextMenu(buildTrayMenu());
      }
    })
    .catch(() => {});
}

// 按「確定套用（額外寵物）」時，才把 pendingExtraPetIds 跟目前已套用的 extraPetIds 做差集，
// 一次把新增的通知 renderer 新增、拿掉的通知 renderer 銷毀——不用像 char1/char2 那樣整頁
// reload（reload 會把桌寵原本已經在跑的其他動畫都打斷重來），改用即時新增/銷毀達到同樣的
// 「一次套用多個變更」效果。
function applyExtraPetSelection() {
  const toAdd = pendingExtraPetIds.filter((id) => !extraPetIds.includes(id));
  const toRemove = extraPetIds.filter((id) => !pendingExtraPetIds.includes(id));
  const nextIds = pendingExtraPetIds.slice();
  const idsJson = JSON.stringify(nextIds);
  win.webContents
    .executeJavaScript(
      `(function() {
        localStorage.setItem('l2d_extra_pets_d', ${JSON.stringify(idsJson)});
        if (!window.updateExtraPet) return false;
        ${toAdd.map((id) => `window.updateExtraPet(${id}, true);`).join('\n        ')}
        ${toRemove.map((id) => `window.updateExtraPet(${id}, false);`).join('\n        ')}
        return true;
      })();`
    )
    .then((ok) => {
      if (!ok) console.warn('[desktop-pet] 額外寵物尚未就緒（L2D 可能還在載入中），已存檔但畫面未即時更新，重新整理後會生效');
    })
    .catch((err) => console.error('[desktop-pet] 套用額外寵物選擇失敗：', err))
    .finally(() => {
      extraPetIds = nextIds;
      if (tray) tray.setContextMenu(buildTrayMenu());
    });
}

function setPendingChar(key, val) {
  if (key === 'char1') pendingChar1 = val; else pendingChar2 = val;
  if (tray) tray.setContextMenu(buildTrayMenu());
}

// 角色一/二個別顯示切換：即時生效（不用像 pending/套用那組要整頁 reload），呼叫
// index.html 的 window.setCharVisible()——那邊會直接卸載/重新載入該角色的 Live2D
// 模型並連帶擋掉它的閒話泡泡，不影響另一個角色。
function setCharVisible(menuKey, visible) {
  const stateKey = CHAR_MENU_KEY_TO_STATE_KEY[menuKey];
  charVisible[stateKey] = visible;
  win.webContents
    .executeJavaScript(`window.setCharVisible(${JSON.stringify(stateKey)}, ${visible})`)
    .catch((err) => console.error(`[desktop-pet] 切換${CHAR_LABEL[stateKey]}顯示狀態失敗：`, err));
  if (tray) tray.setContextMenu(buildTrayMenu());
}

// 按「確定套用」時才真的寫回 localStorage + 重新整理，選單上點選只是暫存
function applyMyLikeSelection() {
  const c1 = pendingChar1, c2 = pendingChar2;
  win.webContents
    .executeJavaScript(
      `(function() {
        ${c1 ? `localStorage.setItem('l2d_mylike_d_char1', ${JSON.stringify(c1)});`
             : `localStorage.removeItem('l2d_mylike_d_char1');`}
        ${c2 ? `localStorage.setItem('l2d_mylike_d_char2', ${JSON.stringify(c2)});`
             : `localStorage.removeItem('l2d_mylike_d_char2');`}
        true;
      })();`
    )
    .then(() => {
      currentChar1 = c1;
      currentChar2 = c2;
      console.log('[desktop-pet] 已套用角色選擇，重新整理...');
      win.reload();
    })
    .catch((err) => console.error('[desktop-pet] 套用角色選擇失敗：', err));
}

function buildCharSubmenu(key) {
  const pending = key === 'char1' ? pendingChar1 : pendingChar2;
  const stateKey = CHAR_MENU_KEY_TO_STATE_KEY[key];
  return [
    {
      label: charVisible[stateKey] ? '顯示中（點擊隱藏）' : '已隱藏（點擊顯示）',
      type: 'checkbox',
      checked: charVisible[stateKey],
      click: () => setCharVisible(key, !charVisible[stateKey]),
    },
    { type: 'separator' },
    {
      label: '（預設，不覆蓋）',
      type: 'radio',
      checked: pending === '',
      click: () => setPendingChar(key, ''),
    },
    ...myLikeManifest.map((e) => ({
      label: `#${e.id} ${myLikeNames[e.path] || e.character}`,
      type: 'radio',
      checked: pending === e.path,
      click: () => setPendingChar(key, e.path),
    })),
  ];
}

// 額外寵物候選清單：manifest 裡除了 char1/char2 固定錨用的 id:1/2（納茲/露西）之外的角色。
// 不預設全部打勾——「不限制」指的是引擎層沒有數量上限，實際載入幾隻要由使用者主動勾選決定。
function getExtraPetCandidates() {
  return myLikeManifest
    .filter((e) => e.id !== 1 && e.id !== 2)
    .map((e) => ({ id: e.id, label: `#${e.id} ${myLikeNames[e.path] || e.character}` }));
}

// 額外寵物勾選視窗：原本用系統匣原生 Menu 的 checkbox 子選單，但原生選單點一下
// 整個選單就會收起來，勾好幾隻要一直重新打開很麻煩——原生 Menu 沒有「點了不關閉」
// 這個選項（Windows/Mac 的原生右鍵選單本來就是這樣設計的），所以改用一個獨立的
// 小視窗取代，可以一直開著、勾好幾隻再一次按「確定套用」。
let extraPetsPickerWin = null;

// 桌寵主視窗（含所有額外寵物本體）也是 alwaysOnTop:true、蓋滿整個螢幕，如果這個小視窗
// 只用預設的 alwaysOnTop 等級，Windows/Mac 不保證兩個「置頂視窗」誰疊在誰上面——實測會被
// 桌寵蓋住。'screen-saver' 是 Electron setAlwaysOnTop 支援的最高置頂等級，用這個 + 每次
// 開窗/切回來都 moveTop()，確保這個小視窗一定疊在桌寵（含所有已存在的額外寵物）上面。
function raiseAboveDesktopPets(win) {
  win.setAlwaysOnTop(true, 'screen-saver');
  win.moveTop();
  win.focus();
}

function openExtraPetsPicker() {
  if (extraPetsPickerWin) {
    raiseAboveDesktopPets(extraPetsPickerWin);
    extraPetsPickerWin.webContents.send('init', {
      candidates: getExtraPetCandidates(),
      checked: pendingExtraPetIds,
    });
    return;
  }
  extraPetsPickerWin = new BrowserWindow({
    width: 340,
    height: 480,
    title: '額外寵物',
    resizable: true,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'extra-pets-preload.js'),
    },
  });
  extraPetsPickerWin.setMenuBarVisibility(false);
  raiseAboveDesktopPets(extraPetsPickerWin);
  extraPetsPickerWin.loadFile(path.join(__dirname, 'extra-pets-picker.html'));
  extraPetsPickerWin.webContents.on('did-finish-load', () => {
    extraPetsPickerWin.webContents.send('init', {
      candidates: getExtraPetCandidates(),
      checked: pendingExtraPetIds,
    });
    // loadFile 完成後 renderer 才真正畫出內容，此時桌寵可能又把自己搶回最上層，再頂一次。
    raiseAboveDesktopPets(extraPetsPickerWin);
  });
  extraPetsPickerWin.on('closed', () => { extraPetsPickerWin = null; });
}

ipcMain.on('extra-pets-apply', (_event, ids) => {
  pendingExtraPetIds = Array.isArray(ids) ? ids.filter((id) => Number.isInteger(id)) : [];
  applyExtraPetSelection();
  if (extraPetsPickerWin) extraPetsPickerWin.close();
});

ipcMain.on('extra-pets-close', () => {
  if (extraPetsPickerWin) extraPetsPickerWin.close();
});

// ── 模型命名管理視窗 ─────────────────────────────────────────────────────
// manifest.json 每次都是重新掃描 models/ 資料夾產生的（見 generate-manifest.js），
// 新增/刪除模型後，names.json 裡對應的顯示名稱要嘛要手動補、要嘛就對不上號——
// 這個視窗一次列出所有模型，最上面顯示「manifest 有幾筆、names.json 有幾筆」當提示，
// 每一列可以直接打字改名字，也可以從「歷史名字池」（見 names_history.json，只增不減，
// 不會因為模型改名/刪除就消失）的下拉選單挑一個套用，不用每次都重新手打；儲存時整批
// 寫回 names.json，不靠自動比對路徑字串去猜哪個舊名字該套用到哪個新模型——猜錯比沒猜
// 還糟，交給使用者自己判斷。
let nameManagerWin = null;

function readModelConfig() {
  const dir = path.join(__dirname, '..', 'live2d_my_like', 'config');
  let manifest = [];
  let names = {};
  let history = [];
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); }
  catch (err) { if (err.code !== 'ENOENT') console.warn('[desktop-pet] 讀取 manifest.json 失敗，退回空清單：', err.message); }
  try { names = JSON.parse(fs.readFileSync(path.join(dir, 'names.json'), 'utf8')); }
  catch (err) { if (err.code !== 'ENOENT') console.warn('[desktop-pet] 讀取 names.json 失敗，退回空清單：', err.message); }
  try { history = JSON.parse(fs.readFileSync(path.join(dir, 'names_history.json'), 'utf8')); }
  catch (err) { if (err.code !== 'ENOENT') console.warn('[desktop-pet] 讀取 names_history.json 失敗，退回空清單：', err.message); }
  return { manifest, names, history };
}

// names.json 存檔完之後，把這次出現過的名字一併併入 names_history.json（只增不減），
// 回傳更新後的歷史清單，讓視窗不用關掉重開就能立刻在名字池選單看到剛剛新打的名字。
function appendNameHistory(names) {
  const dir = path.join(__dirname, '..', 'live2d_my_like', 'config');
  const historyPath = path.join(dir, 'names_history.json');
  let history = [];
  try { history = JSON.parse(fs.readFileSync(historyPath, 'utf8')); }
  catch (err) { if (err.code !== 'ENOENT') console.warn('[desktop-pet] 讀取 names_history.json 失敗，退回空清單：', err.message); }
  const set = new Set(history);
  let changed = false;
  Object.values(names).forEach((n) => {
    if (n && !set.has(n)) { set.add(n); changed = true; }
  });
  const sorted = [...set].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
  if (changed) fs.writeFileSync(historyPath, JSON.stringify(sorted, null, 2));
  return sorted;
}

function openNameManager() {
  if (nameManagerWin) {
    raiseAboveDesktopPets(nameManagerWin);
    nameManagerWin.webContents.send('init', readModelConfig());
    return;
  }
  nameManagerWin = new BrowserWindow({
    width: 680,
    height: 560,
    title: '模型命名管理',
    resizable: true,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'name-manager-preload.js'),
    },
  });
  nameManagerWin.setMenuBarVisibility(false);
  raiseAboveDesktopPets(nameManagerWin);
  nameManagerWin.loadFile(path.join(__dirname, 'name-manager.html'));
  nameManagerWin.webContents.on('did-finish-load', () => {
    nameManagerWin.webContents.send('init', readModelConfig());
    raiseAboveDesktopPets(nameManagerWin);
  });
  nameManagerWin.on('closed', () => { nameManagerWin = null; });
}

ipcMain.on('name-manager-save', (_event, names) => {
  const dir = path.join(__dirname, '..', 'live2d_my_like', 'config');
  try {
    fs.writeFileSync(path.join(dir, 'names.json'), JSON.stringify(names, null, 2));
    const history = appendNameHistory(names);
    if (nameManagerWin) nameManagerWin.webContents.send('saved', { ok: true, history });
    // names.json 存檔之後，桌寵自己選單上顯示的名字（角色一/二、額外寵物候選清單）
    // 也要跟著更新，不用整個重啟桌寵，重新指到這份最新的 names 物件、重建選單即可。
    myLikeNames = names;
    if (tray) tray.setContextMenu(buildTrayMenu());
  } catch (err) {
    if (nameManagerWin) nameManagerWin.webContents.send('saved', { ok: false, error: err.message });
  }
});

ipcMain.on('name-manager-close', () => {
  if (nameManagerWin) nameManagerWin.close();
});

// ── 設定視窗（OpenAI API key）────────────────────────────────────────────
// ADR-0006：不用 .env，改成應用程式內建設定畫面。key 只存在 main process 的
// settings-store.js（寫到 app.getPath('userData') 底下的 JSON），這個視窗透過
// settings-preload.js 只拿得到「有沒有設定過」的布林值，看不到 key 本身。
let settingsWin = null;

function openSettings() {
  if (settingsWin) {
    raiseAboveDesktopPets(settingsWin);
    settingsWin.webContents.send('init', {
      hasKey: !!settingsStore.getApiKey(),
      micSettings: settingsStore.getMicSettings(),
      chatProviderSettings: settingsStore.getChatProviderSettings(),
      cliFreePermissionMode: settingsStore.getCliFreePermissionMode(),
      showLive2DOnStartup: settingsStore.getShowLive2DOnStartup(),
      showParticleModelOnStartup: settingsStore.getShowParticleModelOnStartup(),
      memoryFilePath: chatMemoryStore.memoryPath(),
    });
    return;
  }
  settingsWin = new BrowserWindow({
    width: 420,
    height: 860, // 加了 CLI 模式免確認區塊後原本 780 會擠出捲軸，加高一點讓大部分內容不用捲
    title: '設定',
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'settings-preload.js'),
    },
  });
  settingsWin.setMenuBarVisibility(false);
  raiseAboveDesktopPets(settingsWin);
  settingsWin.loadFile(path.join(__dirname, 'settings.html'));
  settingsWin.webContents.on('did-finish-load', () => {
    settingsWin.webContents.send('init', {
      hasKey: !!settingsStore.getApiKey(),
      micSettings: settingsStore.getMicSettings(),
      chatProviderSettings: settingsStore.getChatProviderSettings(),
      cliFreePermissionMode: settingsStore.getCliFreePermissionMode(),
      showLive2DOnStartup: settingsStore.getShowLive2DOnStartup(),
      showParticleModelOnStartup: settingsStore.getShowParticleModelOnStartup(),
      memoryFilePath: chatMemoryStore.memoryPath(),
    });
    raiseAboveDesktopPets(settingsWin);
  });
  settingsWin.on('closed', () => { settingsWin = null; });
}

ipcMain.handle('settings-save-api-key', (_event, apiKey) => settingsStore.saveApiKey(apiKey));

// 跟「清除本機快取並重開」同一套二次確認手法（dialog.showMessageBox），避免手滑清掉
// 已經設定好的 key——這個操作沒有復原按鈕，清掉之後要重新輸入。
ipcMain.handle('settings-clear-api-key', async () => {
  const { response } = await dialog.showMessageBox(settingsWin, {
    type: 'warning',
    buttons: ['取消', '清除'],
    defaultId: 0,
    cancelId: 0,
    title: '清除 API Key',
    message: '確定要清除已儲存的 OpenAI API key 嗎？',
    detail: '清除後「語音測試」「即時對話」都會回到「尚未設定」的狀態，要重新輸入才能繼續使用。',
  });
  if (response !== 1) return { ok: false, cancelled: true };
  return settingsStore.clearApiKey();
});

const CHAR_LABEL = { c1: '角色一', c2: '角色二' };

ipcMain.handle('settings-clear-memory', async (_event, charKey) => {
  if (charKey !== 'c1' && charKey !== 'c2') return { ok: false, error: '不明的角色' };
  const label = CHAR_LABEL[charKey];
  const { response } = await dialog.showMessageBox(settingsWin, {
    type: 'warning',
    buttons: ['取消', '清空'],
    defaultId: 0,
    cancelId: 0,
    title: `清空${label}的對話記憶`,
    message: `確定要清空${label}的對話記憶嗎？`,
    detail: `會忘記跟${label}聊過的所有內容（最近 ${chatMemoryStore.MAX_TURNS} 輪），不影響另一個角色、也不影響 API key／人設設定。`,
  });
  if (response !== 1) return { ok: false, cancelled: true };
  return chatMemoryStore.clearHistory(charKey);
});

ipcMain.on('settings-close', () => {
  if (settingsWin) settingsWin.close();
});

// CLI 模式免確認模式（見 docs/adr/0010-desktop-pet-cli-free-permission-mode.md）——開啟時
// 拿掉 ADR-0008 原本「風險操作一律先問過使用者」這道防線，所以跟清除 API key／清空記憶
// 同一套二次確認手法（dialog.showMessageBox），警告內容要講清楚拿掉的是哪道防線、不是
// 隨口帶過。關閉不需要確認——退回安全預設值不是需要攔阻的操作。
ipcMain.handle('settings-set-cli-free-mode', async (_event, enabled) => {
  if (!enabled) return settingsStore.setCliFreePermissionMode(false);
  const { response } = await dialog.showMessageBox(settingsWin, {
    type: 'warning',
    buttons: ['取消', '我了解風險，啟用'],
    defaultId: 0,
    cancelId: 0,
    title: '啟用 CLI 模式免確認模式',
    message: '確定要開啟「免確認模式」嗎？',
    detail: 'CLI 模式（跟角色說「進入 CLI 模式」觸發）目前每個寫檔、執行指令等有風險操作都會先問你同意才做。開啟這個選項後會跳過逐步確認，Claude 會直接自動執行，只在文字泡泡告訴你它做了什麼，不會再暫停等你回覆。\n\n這等於拿掉原本用來防止「觸發短語被誤判、風險操作在你沒真的同意的情況下被執行」的最後一道防線。建議只在會全程盯著螢幕、且信任目前交代的任務時才開啟，用完記得回這裡關閉。',
  });
  if (response !== 1) return { ok: false, cancelled: true };
  return settingsStore.setCliFreePermissionMode(true);
});

// 語音輸入的靜音/幻覺防呆兩個門檻（見 docs/specs/0004-desktop-pet-voice-input.md）。
// 'get-mic-settings' 給桌寵主視窗（preload.js 的 petBridge）在每次開始錄音前問目前值，
// 跟設定視窗開啟時塞進 'init' payload 的 micSettings 是同一份資料、同一個來源
// （settingsStore.getMicSettings()），不會兩邊算出不一樣的值。
ipcMain.handle('get-mic-settings', () => settingsStore.getMicSettings());

ipcMain.handle('settings-save-mic-settings', (_event, payload) => settingsStore.saveMicSettings(payload));

ipcMain.handle('settings-reset-mic-settings', () => settingsStore.resetMicSettings());

// 即時對話 provider（OpenAI／Ollama 本機）——見 docs/specs/0005-desktop-pet-ollama-provider.md。
ipcMain.handle('settings-save-chat-provider', (_event, payload) => settingsStore.saveChatProviderSettings(payload));

// 桌寵啟動時預設顯示 Live2D 模型／光粒子 3D 模型——不是不可逆操作，也不影響安全性，
// 不用像 CLI 免確認模式那樣跳原生對話框二次確認，跟語音輸入靈敏度／即時對話 provider
// 同一種「存了下次生效」等級。這裡刻意只存值，不順便呼叫 executeJavaScript 立刻套用
// 到目前正在跑的桌寵——「開機預設值」跟「這個 session 目前的狀態」是兩件事，硬要
// 兩者同步反而會製造新的狀態對不齊問題（尤其光粒子特效已經有系統匣選單管「現在」
// 開不開，這裡改的是「下次開機」該是什麼狀態，兩條路徑分開才不會互相打架）。
ipcMain.handle('settings-set-show-live2d', (_event, enabled) => settingsStore.setShowLive2DOnStartup(enabled));
ipcMain.handle('settings-set-show-particle-model', (_event, enabled) => settingsStore.setShowParticleModelOnStartup(enabled));

// 設定畫面「測試連線」：main process 直接呼叫 Ollama（Node fetch 不受瀏覽器同源政策
// 限制，不會撞到 ai-quiz-generator 那邊要另外設定 OLLAMA_ORIGINS 的 CORS 問題），
// 成功的話順便把這台 Ollama 已經下載好的模型清單帶回去，讓設定畫面可以做成下拉選單。
ipcMain.handle('settings-test-ollama', async (_event, { baseUrl }) => {
  try {
    const { models } = await listOllamaModels({ baseUrl });
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── 情境編輯器視窗 ───────────────────────────────────────────────────────
// 使用者要求「背景開著桌寵，即時記錄桌寵目前的參數」：不是另外做一套獨立座標系統的
// 示意色塊編輯器，而是讓使用者直接用桌寵本來就有的 ⠿ 拖曳鈕把角色一/二拖到想要的位置，
// 這個視窗按「記錄目前位置」時透過 executeJavaScript 呼叫 index.html 的
// window.getCharPositions()，抓的是真的在跑的畫面座標——所見即所得，不用調參數猜數值。
// 存檔直接覆寫 desktop-pet/scenes.json，再叫桌寵那個視窗呼叫 window.reloadScenes()
// 重新讀取，不用重開桌寵；系統匣「情境演出」子選單也是直接讀這份 scenes.json（見
// buildSceneSubmenu()），兩邊資料來源一致，不會對不上。
let sceneEditorWin = null;
const SCENES_PATH = path.join(__dirname, 'scenes.json');

function openSceneEditor() {
  if (sceneEditorWin) {
    raiseAboveDesktopPets(sceneEditorWin);
    return;
  }
  sceneEditorWin = new BrowserWindow({
    // 原本 760×680 太擠——情境資訊／步驟清單／新增步驟表單／存檔按鈕列四段同時要看得到，
    // 步驟清單分到的高度常常連一步都看不全。920 高度大概夠同時露出 3 張收合的步驟卡片
    // （修改既有步驟）+ 下面完整的新增步驟表單（同時新增），不用一直切「全螢幕總覽」。
    // 也開放 maximizable，螢幕大的話還能再拉更大。
    width: 860,
    height: 920,
    minWidth: 720,
    minHeight: 640,
    title: '情境編輯器',
    resizable: true,
    minimizable: false,
    maximizable: true,
    alwaysOnTop: true,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'scene-editor-preload.js'),
    },
  });
  sceneEditorWin.setMenuBarVisibility(false);
  raiseAboveDesktopPets(sceneEditorWin);
  sceneEditorWin.loadFile(path.join(__dirname, 'scene-editor.html'));
  sceneEditorWin.webContents.on('did-finish-load', () => raiseAboveDesktopPets(sceneEditorWin));
  sceneEditorWin.on('closed', () => { sceneEditorWin = null; });
}

// 桌寵那個視窗（win）是不是還活著、L2D 是不是已經就緒，跟 triggerMotion() 判斷方式一致。
function _petWindowReady() {
  return win && !win.isDestroyed();
}

ipcMain.handle('scene-editor-get-scenes', () => {
  try {
    return { ok: true, scenes: readScenes() };
  } catch (err) {
    return { ok: false, error: err.message, scenes: {} };
  }
});

ipcMain.handle('scene-editor-get-live', async () => {
  if (!_petWindowReady()) return { ok: false, reason: '桌寵視窗還沒開啟' };
  try {
    const result = await win.webContents.executeJavaScript(
      `(window._l2dReady && window.getCharPositions) ? window.getCharPositions() : null;`
    );
    if (!result) return { ok: false, reason: '桌寵角色還沒載入完成' };
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
});

ipcMain.handle('scene-editor-get-gestures', async () => {
  if (!_petWindowReady()) return [];
  try {
    return await win.webContents.executeJavaScript(
      `(window._l2dReady && window.getGestureList) ? window.getGestureList() : [];`
    );
  } catch {
    return [];
  }
});

ipcMain.handle('scene-editor-save', async (_event, scenes) => {
  try {
    if (!scenes || typeof scenes !== 'object' || Array.isArray(scenes)) {
      throw new Error('情境資料格式不對');
    }
    fs.writeFileSync(SCENES_PATH, JSON.stringify(scenes, null, 2));
    // 存檔後叫桌寵重新讀取最新的 scenes.json，不用整個重開桌寵；桌寵沒開著就安靜跳過，
    // 存檔本身還是成功的，下次開桌寵時本來就會讀到最新檔案。
    // 一定要「等」桌寵真的讀完最新內容，這個 IPC 回應才能算完成——window.reloadScenes()
    // 內部是 fetch('scenes.json') 這種非同步流程，先前這裡沒加 await，就會出現「儲存並
    // 試播」緊接著送出的播放指令，在桌寵那邊 fetch 還沒跑完之前就先執行、播到「存檔前」
    // 的舊資料的競爭條件——使用者改了走位時間去測試，看起來卻像完全沒生效，就是這裡。
    if (_petWindowReady()) {
      try {
        await win.webContents.executeJavaScript(
          `(async function() {
            if (window.reloadScenes) { await window.reloadScenes(); return true; }
            return false;
          })();`
        );
      } catch (err) {
        console.error('[desktop-pet] 情境存檔後重新整理失敗：', err);
      }
    }
    if (tray) tray.setContextMenu(buildTrayMenu());
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 測試手勢/台詞、整段預覽播放：都是「單純觸發、不是改存檔狀態」，沿用 triggerMotion()
// 那套 L2D 未就緒就安靜跳過的邏輯，不用另外處理。
// 注意：L2D 是 lib/live2d.js 頂層用 const 宣告的變數，classic <script> 的頂層 let/const
// 不會變成 window 的屬性，這裡（executeJavaScript 注入的程式碼）一定要用裸的 L2D，
// 不能寫成 window.L2D——寫成 window.L2D 的話 if 判斷式恆假，按鈕看起來完全沒反應
// （這正是「測試按鈕失效」的原因）。window.ScenePlayer 沒有這個問題，因為 index.html
// 是明確寫 window.ScenePlayer = ScenePlayer 掛上去的，不是單純的頂層 const。
ipcMain.on('scene-editor-test-gesture', (_event, { charKey, name }) => {
  triggerMotion(`typeof L2D !== 'undefined' && L2D.trigger && L2D.trigger(${JSON.stringify(name)}, ${JSON.stringify(charKey)})`);
});

// 獨立測試單一步驟的走位（不用整段情境播放）：window.testMoveTo 是 window.xxx 明確
// 掛上去的（見 index.html），不是頂層 const，用 window.testMoveTo 沒問題。
ipcMain.on('scene-editor-test-move', (_event, { charKey, x, y, durationMs }) => {
  triggerMotion(`window.testMoveTo && window.testMoveTo(${JSON.stringify(charKey)}, ${JSON.stringify(x)}, ${JSON.stringify(y)}, ${JSON.stringify(durationMs)})`);
});

// 不經過 tween，直接把角色瞬間放到指定座標——用來快速確認座標實際位置，或排查走位
// 動畫是不是真的有作用（瞬間跳過去角色都不動，代表問題出在渲染那一段）。
ipcMain.on('scene-editor-snap-position', (_event, { charKey, x, y }) => {
  triggerMotion(`window.snapToPosition && window.snapToPosition(${JSON.stringify(charKey)}, ${JSON.stringify(x)}, ${JSON.stringify(y)})`);
});

ipcMain.on('scene-editor-test-speak', (_event, { charKey, text }) => {
  const fn = charKey === 'c2' ? 'speak2' : 'speak';
  triggerMotion(`typeof L2D !== 'undefined' && L2D.${fn} && L2D.${fn}(${JSON.stringify(text)}, { type: 'info' })`);
});

ipcMain.on('scene-editor-play', (_event, key) => {
  triggerMotion(`window.ScenePlayer && window.ScenePlayer.trigger(${JSON.stringify(key)})`);
});

// ── 閒話台詞（idle chat）：跟情境資料同一套模式，但這份是桌寵「常駐閒置」時隨機講的
// 短句，不是事件觸發的整段情境。內容存在 idle-chat.json，跟 lib/live2d.js 內建給網頁
// 模式用的 L2D_CHAT_C1/C2（50 句陪伴台詞）完全脫鉤——桌寵讀自己這份、透過
// L2D.setIdleChatLines() 蓋掉引擎預設值，網頁模式的行為完全不受影響（見 lib/live2d.js
// 開頭 setIdleChatLines() 的說明）。存檔後一樣叫桌寵 window.reloadIdleChat() 立刻套用。
const IDLE_CHAT_PATH = path.join(__dirname, 'idle-chat.json');

function readIdleChat() {
  try {
    return JSON.parse(fs.readFileSync(IDLE_CHAT_PATH, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[desktop-pet] 讀取 idle-chat.json 失敗，退回空清單：', err.message);
    return [];
  }
}

ipcMain.handle('scene-editor-get-idle-chat', () => {
  try {
    return { ok: true, pairs: readIdleChat() };
  } catch (err) {
    return { ok: false, error: err.message, pairs: [] };
  }
});

// ── 文字泡泡定位校正（headRatio/headXRatio）──────────────────────────────
// 跟情境/閒話台詞同一種「先讀桌寵即時狀態、調完存回資料檔」模式，只是這次寫回的資料檔
// 是 manifest.json（layout 欄位本來就是「跟著模型走」，見 lib/live2d.js 開頭說明），
// 不是 desktop-pet 自己的檔案。
ipcMain.handle('scene-editor-get-bubble-config', async () => {
  if (!_petWindowReady()) return { ok: false, reason: '桌寵視窗還沒開啟' };
  try {
    const result = await win.webContents.executeJavaScript(
      `(window._l2dReady && window.getBubbleConfig) ? window.getBubbleConfig() : null;`
    );
    if (!result) return { ok: false, reason: '桌寵角色還沒載入完成' };
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
});

// 即時套用不寫檔，讓使用者可以邊調邊按「測試」在真正的畫面上確認，滿意了才真的存檔。
// opts 是 { headRatio, headXRatio, bubbleGrow, scale }，欄位可以只帶部分，
// window.setBubbleConfigLive() 自己會判斷哪些欄位有給值才套用。
ipcMain.on('scene-editor-test-bubble-live', (_event, { charKey, opts }) => {
  triggerMotion(`window.setBubbleConfigLive && window.setBubbleConfigLive(${JSON.stringify(charKey)}, ${JSON.stringify(opts)})`);
});

ipcMain.handle('scene-editor-save-bubble-config', (_event, { modelPath, headRatio, headXRatio, bubbleGrow, scale }) => {
  try {
    const rel = String(modelPath || '').replace(/^.*live2d_my_like\//, '');
    const manifestPath = path.join(__dirname, '..', 'live2d_my_like', 'config', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const entry = manifest.find((e) => e.path === rel);
    if (!entry) throw new Error('在 manifest.json 找不到這個模型路徑：' + rel);
    entry.layout = entry.layout && typeof entry.layout === 'object' ? entry.layout : {};
    entry.layout.headRatio = Number(headRatio);
    entry.layout.headXRatio = Number(headXRatio);
    if (bubbleGrow === 'left' || bubbleGrow === 'right') entry.layout.bubbleGrow = bubbleGrow;
    if (scale !== '' && scale != null && !Number.isNaN(Number(scale))) entry.layout.scale = Number(scale);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('scene-editor-save-idle-chat', async (_event, pairs) => {
  try {
    if (!Array.isArray(pairs)) throw new Error('閒話台詞資料格式不對');
    fs.writeFileSync(IDLE_CHAT_PATH, JSON.stringify(pairs, null, 2));
    // 跟 scene-editor-save 同一個道理：等桌寵真的讀完最新內容再回應，避免緊接著的
    // 任何動作（例如之後如果加了「存完立刻測」之類的按鈕）撞上還沒讀完的競爭條件。
    if (_petWindowReady()) {
      try {
        await win.webContents.executeJavaScript(
          `(async function() {
            if (window.reloadIdleChat) { await window.reloadIdleChat(); return true; }
            return false;
          })();`
        );
      } catch (err) {
        console.error('[desktop-pet] 閒話台詞存檔後重新整理失敗：', err);
      }
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// 網頁控制面板觸發互動模式時的安全網：桌寵視窗蓋滿整個主螢幕，一旦不再點擊穿透，
// 會攔截整個螢幕的滑鼠事件——包含使用者想拿來點「切回穿透模式」的瀏覽器按鈕那次
// 點擊，等於按鈕點了等於沒點，卡在互動模式出不來。F9／系統匣選單不會有這個問題
// （前者是全域快捷鍵、後者是另一個 OS 層級，都不會被這個視窗蓋住），所以只有
// 網頁觸發的這條路徑需要「N 秒沒人再切一次就自動跳回」這個保險，見
// toggleInteractiveFromWeb()。
const INTERACTIVE_AUTO_REVERT_MS = 60000;
let interactiveAutoRevertTimer = null;
let interactiveAutoRevertDeadline = null;

function clearInteractiveAutoRevertTimer() {
  if (interactiveAutoRevertTimer) {
    clearTimeout(interactiveAutoRevertTimer);
    interactiveAutoRevertTimer = null;
    interactiveAutoRevertDeadline = null;
  }
}

function setClickThrough(value) {
  // 不管這次切換是從哪裡觸發（F9／系統匣／網頁），都視為「使用者剛確認了最新狀態」，
  // 先取消掉舊的自動跳回計時器，避免它之後突然把使用者剛用 F9 設定好的狀態蓋掉。
  clearInteractiveAutoRevertTimer();
  clickThrough = value;
  win.setIgnoreMouseEvents(clickThrough, { forward: true });
  syncParticleEffectStateFromMain();
  const label = clickThrough ? '穿透模式（滑鼠會穿透到桌面）' : '互動模式（可拖曳角色）';
  console.log(`[desktop-pet] 目前狀態：${label}`);
  if (tray) {
    tray.setToolTip(`Live2D 桌面掛件 — ${label}`);
    tray.setContextMenu(buildTrayMenu());
  }
}

// 只給網頁控制面板的 /toggle-interactive 端點用：切成互動模式時額外掛上自動跳回計時器。
function toggleInteractiveFromWeb() {
  setClickThrough(!clickThrough);
  if (!clickThrough) {
    interactiveAutoRevertDeadline = Date.now() + INTERACTIVE_AUTO_REVERT_MS;
    interactiveAutoRevertTimer = setTimeout(() => {
      interactiveAutoRevertTimer = null;
      interactiveAutoRevertDeadline = null;
      console.log('[desktop-pet] 網頁觸發的互動模式已逾時，自動切回穿透模式');
      setClickThrough(true);
    }, INTERACTIVE_AUTO_REVERT_MS);
  }
}

function resetPosition() {
  // L2D.clearPos() 是 lib/live2d.js 既有的公開方法（清除拖曳存的 localStorage 位置/縮放），
  // 這裡沒有改動共用檔案，只是從桌寵這邊呼叫它，再自動重新整理讓效果生效。
  // 注意：L2D 是 lib/live2d.js 裡用 const 宣告的頂層變數，classic <script> 的頂層
  // let/const 不會變成 window 的屬性（只有明確寫 window.xxx = ... 的東西才會有），
  // 所以這裡（以及所有 executeJavaScript 注入的程式碼）必須用裸的 L2D，不能用 window.L2D，
  // 不然 if 判斷式恆假、裡面的呼叫永遠不會執行。
  win.webContents
    .executeJavaScript(
      `(function() {
        if (typeof L2D !== 'undefined' && typeof L2D.clearPos === 'function') { L2D.clearPos(); return true; }
        return false;
      })();`
    )
    .then((ok) => {
      if (ok) {
        console.log('[desktop-pet] 已還原預設位置/縮放，重新載入畫面...');
        win.reload();
      } else {
        console.warn('[desktop-pet] L2D 尚未就緒（角色可能還在載入中），請稍後再試');
      }
    })
    .catch((err) => console.error('[desktop-pet] 還原預設位置失敗：', err));
}

// ── 清除本機快取並重開 ─────────────────────────────────────────────────────
// 背景：曾經遇過一次角色一/二完全沒反應「動作測試」（playRandom1/2，模型內建
// Cubism 動作檔），但「情境演出」（L2DGesturePlayer 自訂手勢，直接改參數，不走
// 動作檔）跟「交叉飛行」（純位置移動，不碰動作系統）都正常——範圍剛好卡在
// 「動作系統」這條路徑上。程式碼本身沒抓到問題，最後是手動整個刪掉
// %APPDATA%\desktop-pet 資料夾再重開才解決，判斷是某份殘留在本機的舊資料
// （localStorage，例如 _lsKey() 存的每個角色拖曳位置/縮放、額外寵物狀態、角色
// 一/二選過的模型路徑等等，讀取大多包在 try/catch 裡讀壞會安靜跳過）卡住了
// 初始化流程的某個環節，不是核心邏輯壞掉。這裡把「手動刪資料夾」這個復原手段
// 做成選單裡的一鍵操作，不用再手動找路徑。
// 用 session.clearStorageData() 清 Electron 的 web storage（等同刪掉
// %APPDATA%\desktop-pet 底下 Local Storage 那些檔案，比整個刪 userData 資料夾更
// 精準，不會連 Electron 自己的其他內部設定也一起清掉），清完用 app.relaunch()+
// app.exit() 整個重開，才會連主行程（tray 選單記得的目前角色等狀態）都一起歸零，
// 跟手動關掉桌寵、刪資料夾、重開的效果一致。
async function performClearCacheAndRestart() {
  try {
    await session.defaultSession.clearStorageData();
    console.log('[desktop-pet] 已清除本機快取，重新啟動...');
  } catch (err) {
    console.error('[desktop-pet] 清除本機快取失敗：', err);
  }
  app.relaunch();
  app.exit();
}

// 屬於「清空所有已存的位置/角色選擇」這種不容易復原的操作，原本是原生
// dialog.showMessageBox 跳確認，改成獨立小視窗——除了「要不要清除」，還條列列出
// 清除後哪些東西會回到預設狀態（純使用者體驗描述，不提 localStorage／session 這些
// 實作細節），並附上實際會被清掉的資料夾路徑，讓使用者自己判斷要不要先去備份。
let clearCacheWin = null;

function openClearCacheConfirm() {
  if (clearCacheWin) {
    raiseAboveDesktopPets(clearCacheWin);
    return;
  }
  clearCacheWin = new BrowserWindow({
    width: 420,
    height: 460,
    title: '清除本機快取',
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'clear-cache-confirm-preload.js'),
    },
  });
  clearCacheWin.setMenuBarVisibility(false);
  raiseAboveDesktopPets(clearCacheWin);
  clearCacheWin.loadFile(path.join(__dirname, 'clear-cache-confirm.html'));
  clearCacheWin.webContents.on('did-finish-load', () => {
    // 只有 localStorage 這個 web storage 類型是這個 app 實際有在用的（見 index.html
    // 的 _lsKey() 那組 key），實體檔案就在 userData 底下的 Local Storage 資料夾，
    // 直接算給使用者看，比講「web storage」這種術語更清楚被清掉的到底是什麼東西。
    clearCacheWin.webContents.send('init', {
      userDataPath: path.join(app.getPath('userData'), 'Local Storage'),
    });
    raiseAboveDesktopPets(clearCacheWin);
  });
  clearCacheWin.on('closed', () => { clearCacheWin = null; });
}

ipcMain.on('clear-cache-confirm', () => {
  if (clearCacheWin) clearCacheWin.close();
  performClearCacheAndRestart();
});

ipcMain.on('clear-cache-cancel', () => {
  if (clearCacheWin) clearCacheWin.close();
});

// 動作測試選單清單抽到 motion-actions.js 獨立管理，之後想加新動作只要改那個檔案，
// 不用動 main.js（對角線交叉飛行是「開始/停止」合一的切換式選項，label 會動態變化，
// 不適合放這種固定 label 的陣列，另外處理，見下方 toggleFly()）
const MOTION_ACTIONS = require('./motion-actions.js');

let isFlying = false;

function toggleFly() {
  if (isFlying) {
    triggerMotion('window._flyStop.c1 = window._flyStop.c2 = true');
  } else {
    // 特意不帶 legs 參數：飛幾趟由 index.html 的 flyLoop(charKey, legs = ...) 預設值唯一決定，
    // 這樣次數設定只存在一個地方（main.js 跟 index.html 是 Electron 的兩個獨立行程，
    // 沒辦法直接共用一個變數，硬要兩邊各存一份設定值反而更難維護）。
    triggerMotion('flyLoop()');
  }
  isFlying = !isFlying;
  if (tray) tray.setContextMenu(buildTrayMenu());
}

// renderer 端（index.html 的 flyLoop）飛行動畫真的播完、飛回原點時會透過 preload.js 的
// petBridge.flyFinished() 送這個訊息過來——不管是自然播完（legs 數用完）還是被
// 「⏹ 停止飛行」中途打斷，兩種情況最後都會呼叫 animateBackToOrigin()，等它真的跑完才會送這則訊息，
// 所以這裡收到時直接同步 isFlying，不用再去猜當下狀態。
ipcMain.on('fly-finished', () => {
  isFlying = false;
  if (tray) tray.setContextMenu(buildTrayMenu());
});

function triggerMotion(call) {
  // 跟 resetPosition() 同樣手法：executeJavaScript 到 renderer 端執行，L2D 還沒就緒時安靜跳過，
  // 這裡是單純觸發動作、不是改存檔狀態，所以不用像 resetPosition() 那樣重新整理頁面。
  // 用 window._l2dReady（index.html 裡 L2D.init().then() 才會設 true）判斷，
  // 比單純檢查 typeof L2D.playRandom1 準確——後者只代表 lib/live2d.js 腳本載入完成，
  // 不代表角色模型（moc3/材質）真的抓完、L2D.init() 已經 resolve。
  win.webContents
    .executeJavaScript(
      `(function() {
        if (window._l2dReady) { ${call}; return true; }
        return false;
      })();`
    )
    .then((ok) => {
      if (!ok) console.warn('[desktop-pet] L2D 尚未就緒（角色可能還在載入中），請稍後再試');
    })
    .catch((err) => console.error('[desktop-pet] 觸發動作失敗：', err));
}

// ── 語音播放（docs/specs/0001-desktop-pet-tts-playback.md）──────────────────
// 「即時對話」本身還沒做，這裡先提供系統匣手動測試入口，驗證「給文字→語音播出來」
// 這條管線是通的；之後即時對話要接語音輸出時，直接呼叫 speakText() 即可。
const SPEECH_TEST_ITEMS = [
  { label: '角色一：測試語音', charKey: 'c1', text: '哈囉，我是角色一，這是一段語音測試。' },
  { label: '角色二：測試語音', charKey: 'c2', text: '嗨，我是角色二，這是一段語音測試。' },
];

// L2D 是否就緒——多處共用（語音測試、即時對話都要在花錢呼叫付費 API 之前先確認，
// 不要為了一個注定不會被看到/聽到的結果白白呼叫）。
async function isL2dReady() {
  if (!_petWindowReady()) return false;
  try {
    return await win.webContents.executeJavaScript('!!window._l2dReady');
  } catch (err) {
    console.error('[desktop-pet] 檢查 L2D 就緒狀態失敗：', err);
    return false;
  }
}

// 顯示文字泡泡 + 播放語音——語音測試（speakText）、即時對話（chat-send）共用。
// 呼叫前呼叫端要自己確認 L2D 就緒／key 存在；這裡只管「已經有文字了，讓角色說出來」。
// 語音合成失敗時仍然顯示文字泡泡（優雅降級：至少看得到角色想說什麼，不會整個安靜失敗），
// 只有真的連文字都送不出去（L2D 未就緒）才會完全沒反應，那個情況呼叫端會先擋下。
//
// 泡泡消失時機：有語音的情況下，不再用「跟文字長度成比例」的估計值去猜多久該消失
// （回覆長度跟 TTS 唸出來的實際時長常常對不上，估太短字都還沒唸完泡泡就先消失、
// 估太長則是話講完了泡泡還留一大段時間）。改成真的等 renderer 回報播放結束
// （waitForTtsPlaybackFinished）之後再等 1 秒才用 L2D.dismissFor() 主動收掉泡泡——
// 呼叫 speakFor() 時給一個遠大於任何合理播放長度的 duration，只是為了不讓
// lib/live2d.js 內建的自動消失計時器搶在我們自己收掉之前先觸發。
// 語音合成失敗（沒有播放可以對齊）時才退回原本「跟文字長度成比例」的估計值。
function bubbleDurationFor(text) {
  const MIN_MS = 4000, MAX_MS = 20000, MS_PER_CHAR = 180;
  return Math.max(MIN_MS, Math.min(MAX_MS, text.length * MS_PER_CHAR));
}
const BUBBLE_DISMISS_DELAY_AFTER_SPEECH_MS = 1000;
const BUBBLE_NO_AUTO_DISMISS_MS = 10 * 60 * 1000; // 10 分鐘，實務上不可能真的等到這裡

// renderer 端的 playTtsAudio() 播放真的結束（或失敗）時會呼叫 petBridge.ttsPlaybackFinished()
// 回報這裡，speakAndShow() 才會真的 resolve——語音模式（docs/specs/0004-desktop-pet-voice-input.md）
// 的續錄迴圈接在 chat-send 的回傳後面，等這個而不是「音檔送出去了就算數」，才不會在角色
// 話還沒講完時就把麥克風重新打開，錄到自己講話的聲音造成聲學回授。
let _ttsPlaybackResolve = null;
ipcMain.on('tts-playback-finished', () => {
  if (_ttsPlaybackResolve) { const r = _ttsPlaybackResolve; _ttsPlaybackResolve = null; r(); }
});

function waitForTtsPlaybackFinished(timeoutMs = 30000) {
  return new Promise((resolve) => {
    _ttsPlaybackResolve = resolve;
    // 保險：renderer 萬一沒送回報（例如播放途中發生沒被接住的例外），別讓語音模式
    // 卡死在「思考中」，設一個上限逾時強制放行。
    setTimeout(() => {
      if (_ttsPlaybackResolve === resolve) { _ttsPlaybackResolve = null; resolve(); }
    }, timeoutMs);
  });
}

// L2D.startIdleChat()（index.html 載入完就常駐開著，每 PET_CFG.idleMotionMs＝15 秒
// 跳出來講一句閒話）跟真正的對話回覆共用同一個文字泡泡 DOM（speakFor() 內部一律
// box.replaceChildren(bubble) 整個換掉），完全不管當下是不是正在顯示一輪真正的回覆——
// 閒聊計時器一到就會直接蓋掉還在顯示/播放中的回覆泡泡，使用者看起來像是「泡泡突然消失
// /被打斷」。用一個進行中計數器包住每一輪 speakAndShow：開始時（第一輪）暫停閒置聊天，
// 所有進行中的輪次都結束時（計數歸零）才重新啟動——用計數器而不是單純的
// stop-before/start-after，是因為角色一/二可能同時各自在進行一輪對話，先結束的那一輪
// 不能直接重啟閒置聊天，否則會蓋掉另一個角色還在進行中的回覆。
let _activeSpeakCount = 0;
// spokenText：選填，TTS 要念的內容跟文字泡泡顯示的 text 不同時才傳（例如 CLI 模式的系統
// 指令——文字泡泡保留完整指令方便使用者同意前確實看過，但不希望 TTS 逐字念出指令裡的
// 符號、旗標，見 docs/specs/0009 與 claude-cli.js 的 spokenToolUseSummary）。省略時兩者
// 相同，行為跟原本完全一樣。
async function speakAndShow(charKey, text, { spokenText } = {}) {
  const textToSpeak = spokenText || text;
  _activeSpeakCount++;
  if (_activeSpeakCount === 1) {
    triggerMotion(`typeof L2D !== 'undefined' && L2D.stopIdleChat && L2D.stopIdleChat()`);
  }
  try {
    const apiKey = settingsStore.getApiKey();
    let audioBuffer;
    try {
      audioBuffer = await synthesizeSpeech({ text: textToSpeak, apiKey });
    } catch (err) {
      console.error(`[desktop-pet] 語音合成失敗（${err.code || 'UNKNOWN_ERROR'}）：${err.message}`);
    }
    const fn = charKey === 'c2' ? 'speak2' : 'speak';
    const duration = audioBuffer ? BUBBLE_NO_AUTO_DISMISS_MS : bubbleDurationFor(text);
    triggerMotion(`typeof L2D !== 'undefined' && L2D.${fn} && L2D.${fn}(${JSON.stringify(text)}, { type: 'info', duration: ${duration} })`);
    if (audioBuffer) {
      // charKey 一併送過去，讓 renderer 端知道該把嘴型同步套用到哪個角色的模型
      // （見 docs/specs/0003-desktop-pet-lip-sync.md）。播放結束（自然播完或使用者
      // 中途打斷，兩者走同一條 tts-playback-finished 回報路徑，這裡不用分辨是哪一種）
      // 之後才等 1 秒、主動呼叫 L2D.dismissFor() 收掉泡泡——上面給 speakFor() 的
      // duration 刻意設得很大，就是要確保這裡的 dismissFor() 一定搶在內建計時器之前
      // 觸發，不會兩邊搶著收泡泡。
      const playbackFinished = waitForTtsPlaybackFinished();
      win.webContents.send('play-tts-audio', { audioBase64: audioBuffer.toString('base64'), charKey });
      await playbackFinished;
      await new Promise((resolve) => setTimeout(resolve, BUBBLE_DISMISS_DELAY_AFTER_SPEECH_MS));
      triggerMotion(`typeof L2D !== 'undefined' && L2D.dismissFor && L2D.dismissFor(${JSON.stringify(charKey)})`);
    }
  } finally {
    _activeSpeakCount--;
    if (_activeSpeakCount === 0) {
      triggerMotion(`typeof L2D !== 'undefined' && L2D.startIdleChat && typeof PET_CFG !== 'undefined' && L2D.startIdleChat(PET_CFG.idleMotionMs)`);
    }
  }
}

async function speakText(charKey, text) {
  if (!(await isL2dReady())) {
    console.warn('[desktop-pet] L2D 尚未就緒（角色可能還在載入中），語音測試略過');
    return;
  }
  const apiKey = settingsStore.getApiKey();
  if (!apiKey) {
    console.error('[desktop-pet] 尚未設定 OpenAI API key，請先從系統匣「設定...」輸入後再試');
    return;
  }
  await speakAndShow(charKey, text);
}

// ── 即時對話（docs/specs/0002-desktop-pet-live-chat.md）────────────────────
const DEFAULT_PERSONA = '你是桌面上的 Live2D 角色助理，回覆盡量簡短口語（一到三句話）。';
const CHAT_URL_REGEX = /https?:\/\/[^\s]+/i;
const chatInFlight = new Set(); // 同一個角色的訊息要排隊，避免並發請求把記憶寫入順序弄亂
// 使用者打錯字/講錯話想收回時用（Esc，見 index.html 的 Esc 判斷邏輯）：charKey ->
// 目前這則訊息的 AbortController，只在「等 OpenAI/Ollama 回覆」這段期間存在，
// chat-send 的 finally 一定會清掉。這個 controller 只會餵給一般聊天（OpenAI/Ollama）
// 的請求，CLI 模式的任務改走 ClaudeCliSession.abort()（見 chat-cancel handler）；
// 但 chat-send 一開頭是無條件 set 這個 map（早於任何 CLI 模式判斷），所以 CLI
// 任務執行期間這個 map 裡一樣有一筆（沒被用到的）entry，直到整個 handler 收尾
// 才清掉——chat-cancel 判斷該用哪個機制時不能只看這個 map 有沒有 entry，得先看
// cliModeActive（見那裡的說明，這裡曾經因為誤判「兩者互斥」而讓 CLI 模式的 Esc
// 完全失效過）。
const chatAbortControllers = new Map();
// 同一種「思考中按 Esc 收回」，用在語音輸入的轉錄階段（見下面 voice-transcribe
// handler）。這裡故意是單一變數不是 Map——跟 chat-send 不同，錄音/轉錄用的是
// renderer 端單一共用的麥克風狀態（isRecording／voiceInputActive 都不分角色），
// 同一時間本來就只可能有一段錄音在轉錄，不需要照 charKey 分開追蹤。
let voiceTranscribeController = null;

// ── CLI 模式（docs/specs/0006-desktop-pet-claude-cli-mode.md）──────────────
// 觸發短語沿用既有的點擊錄音/打字流程，不新增背景常駐麥克風（見 ADR-0008：
// 0004 spec 已經因為聲學回授問題拿掉過一次持續語音模式，這裡不重蹈覆轍）。
// 比對前先正規化（去空白、轉小寫），"進入CLI模式"／"進入 cli 模式" 都算數。
function normalizeTriggerPhrase(s) {
  return (s || '').trim().toLowerCase().replace(/\s+/g, '');
}
const CLI_MODE_ENTER_PHRASES = new Set(['進入CLI模式', 'enter cli mode'].map(normalizeTriggerPhrase));
const CLI_MODE_EXIT_PHRASES = new Set(['退出CLI模式', '離開CLI模式', 'exit cli mode'].map(normalizeTriggerPhrase));
// CLI 模式預設在整個 repo 根目錄（跟這台機器上跑 Claude Code 的目錄一致），不是
// desktop-pet 自己那個子資料夾——見 spec 的使用者決定。目前沒有開放設定畫面調整
// （Out of Scope，見 spec）。開發模式 vs 打包成 portable .exe 之後這裡算出來的路徑
// 不一樣，見 cli-cwd.js 開頭註解。
const { CLAUDE_CLI_CWD } = require('./cli-cwd.js');
const cliModeActive = new Set(); // 目前處於 CLI 模式的 charKey
const claudeCliSessions = new Map(); // charKey -> ClaudeCliSession，退出 CLI 模式就整個丟掉

// 桌寵主視窗 win 蓋滿整個螢幕、釘在 'screen-saver'（見上面 1703 行、raiseAboveDesktopPets
// 的說明）——這是為了使用者點別的視窗時桌寵不會被蓋住，但副作用是 CLI 模式用瀏覽器工具
// （docs/adr/0012）叫出來的 Chrome 分頁，永遠疊在桌寵這層透明視窗底下：實測過使用者在
// 「互動模式」下完全看不到 Chrome 內容（畫面空白），要手動切成「穿透模式」再點一下畫面
// 空白處，逼出一次重繪，Chrome 內容才會顯示——這樣使用者每次都要記得多做這個步驟。
//
// browserLoweredChars：目前「因為在跑瀏覽器工具而暫時降低置頂等級」的 charKey 集合。用
// Set 而不是單一 boolean，是因為角色一、角色二可能同時各自在 CLI 模式跑瀏覽器工具——只要
// 還有任何一個角色在跑，桌寵視窗就該維持降級狀態，讓 Chrome 顯示得出來；全部角色都結束了
// 才恢復 'screen-saver'。Set.add()/delete() 本身是 idempotent 的，呼叫端不需要自己追蹤
// 「這個角色是不是已經降過級了」，重複呼叫同一個 charKey 也不會有副作用。
const browserLoweredChars = new Set();
function setBrowserToolActive(charKey, active) {
  if (active) browserLoweredChars.add(charKey);
  else browserLoweredChars.delete(charKey);
  if (!win) return; // 理論上呼叫這個函式時 win 一定已經存在，防禦性檢查避免初始化時序問題
  win.setAlwaysOnTop(true, browserLoweredChars.size > 0 ? 'normal' : 'screen-saver');
}

// ── Esc 的全域快捷鍵版本（只在有東西可以取消時才註冊）───────────────────────
// index.html 的 Esc 監聽（chatInput 的 keydown、document 的 keydown）只在桌寵視窗
// 真的有 OS 鍵盤焦點時才收得到事件——但穿透模式下，滑鼠事件會 forward 給底下的視窗
// （見 setClickThrough()），使用者點擊桌寵後面的其他視窗（例如 CLI 模式瀏覽器工具
// 叫出來的 Chrome）時，那個視窗會拿到 OS 焦點，這之後按 Esc 只會傳給那個視窗，桌寵
// 完全收不到，卡住的任務就沒辦法用 Esc 中斷了。
//
// 不能像 F9/F10 那樣永遠註冊：globalShortcut 是整個作業系統層級攔截，Esc 又是各種
// 程式都在用的常見按鍵，如果桌寵一直開著就永遠搶走全系統的 Esc，會讓使用者在別的
// 程式（例如正在瀏覽的 Chrome）也按不出 Esc 該有的效果，副作用太大。改成動態註冊：
// 只有「目前真的有東西在跑、有必要被中斷」的時間窗才註冊，做完/沒有任何任務時立刻
// 取消註冊，讓 Esc 還給其他程式。
//
// hasAnyAbortableOperation()：chatAbortControllers 非空就代表至少有一個角色的
// chat-send handler 還在跑（不管是一般聊天還是 CLI 模式——後者的 entry 雖然沒有
// 真的接到任何取消邏輯，見 chat-cancel handler 的說明，但存在與否仍然正確反映
// 「這個 handler 呼叫還沒結束」，可以拿來當作「有東西在跑」的訊號；這也涵蓋
// TTS 正在播放的階段，因為 chat-send handler 是 await speakAndShow() 播完才
// return，chatAbortControllers 的 entry 要到那之後的 finally 才清掉）。
// recordingActive：唯一main process 完全看不到、只能靠 renderer 主動回報的狀態——
// 使用者剛點🎤、MediaRecorder 正在錄音，這時候還沒有任何送到 main process 的網路
// 請求，chatAbortControllers／voiceTranscribeController 都是空的，但這正是使用者
// 三個要打斷的情境之一（見 recording-active handler、index.html 的 notifyRecordingActive
// 呼叫點）。
let recordingActive = false;
function hasAnyAbortableOperation() {
  return chatAbortControllers.size > 0 || !!voiceTranscribeController || recordingActive;
}

// 全域 Escape 要做兩件事，缺一不可：
// 1. 直接中止 main process 這邊看得到、管得到的東西（跟 chat-cancel IPC handler
//    同一套判斷邏輯：CLI 模式優先查 claudeCliSessions，一般聊天才用
//    chatAbortControllers）。這裡不透過 IPC、不透過「目前開著哪個聊天框」的
//    renderer 狀態，一次處理所有角色——全域快捷鍵沒有「使用者按 Esc 時是針對哪個
//    角色」這個上下文，穩妥起見全部一起中斷，多中斷到一個原本沒打算取消的任務，
//    後果比「該中斷的中斷不了」小很多。
// 2. 把「Escape 被按下」這件事轉送給 renderer——錄音（MediaRecorder）、TTS 播放
//    中斷、麥克風按鈕外觀重置、聊天框關閉，這些狀態完全活在 renderer 裡，main
//    process 沒有辦法直接操作，只能靠 index.html 收到這個事件後，用它自己既有的
//    document keydown Escape 那套判斷順序處理（見 index.html 的
//    window.petBridge.onGlobalEscape 註冊處）。兩邊都做，即使 renderer 那邊剛好
//    也透過 cancelChatMessage/cancelTranscription 重複呼叫到同一個 abort()，
//    AbortController.abort() 跟 ClaudeCliSession.abort() 本身都是重複呼叫安全的
//    （後者對已經不是 busy 的 session 直接回傳 false，不會出錯）。
function handleGlobalEscape() {
  for (const charKey of chatAbortControllers.keys()) {
    if (cliModeActive.has(charKey)) {
      const cliSession = claudeCliSessions.get(charKey);
      if (cliSession) cliSession.abort();
    } else {
      chatAbortControllers.get(charKey).abort();
    }
  }
  if (voiceTranscribeController) voiceTranscribeController.abort();
  if (win) win.webContents.send('global-escape');
}

let globalEscapeRegistered = false;
function updateGlobalEscapeRegistration() {
  const shouldBeRegistered = hasAnyAbortableOperation();
  if (shouldBeRegistered && !globalEscapeRegistered) {
    // register() 失敗（例如 Escape 已經被其他程式搶走）就靜靜放棄，退回「只有桌寵
    // 視窗有焦點時，index.html 的本地監聽還是有效」這個原本就有的行為，不是關鍵路徑，
    // 不用跳錯誤打斷使用者。
    globalEscapeRegistered = globalShortcut.register('Escape', handleGlobalEscape);
  } else if (!shouldBeRegistered && globalEscapeRegistered) {
    globalShortcut.unregister('Escape');
    globalEscapeRegistered = false;
  }
}

// 把每一輪即時對話（使用者說了什麼、角色回了什麼）印到終端機（跟現有「未預期錯誤都印到
// 終端機」同一個習慣，見桌面寵物說明.md）——CLI 模式的進入/離開/確認/任務結果，跟一般
// 聊天（OpenAI/Ollama）都算「即時對話」，全部經過這裡統一印出，方便在終端機視窗直接
// 看對話紀錄，不用另外開設定或記憶檔案查。純粹印出，不寫檔、不影響任何既有的
// chatMemoryStore 記憶邏輯。
function logConversationTurn(charKey, label, userMessage, replyText) {
  const charLabel = CHAR_LABEL[charKey] || charKey;
  console.log(`[desktop-pet] ${charLabel}對話（${label}）\n  你：${userMessage}\n  ${charLabel}：${replyText}`);
}

function readPersonas() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'personas.json'), 'utf8'));
    return {
      c1: (typeof data.c1 === 'string' && data.c1.trim()) ? data.c1 : DEFAULT_PERSONA,
      c2: (typeof data.c2 === 'string' && data.c2.trim()) ? data.c2 : DEFAULT_PERSONA,
    };
  } catch (err) {
    // personas.json 不存在或損毀，兩個角色都退回通用預設人設，不要讓對話功能因此打不開。
    if (err.code !== 'ENOENT') console.warn('[desktop-pet] 讀取 personas.json 失敗，退回預設人設：', err.message);
    return { c1: DEFAULT_PERSONA, c2: DEFAULT_PERSONA };
  }
}

ipcMain.handle('chat-send', async (_event, { charKey, message }) => {
  if (charKey !== 'c1' && charKey !== 'c2') {
    return { ok: false, error: '不明的角色' };
  }
  if (chatInFlight.has(charKey)) {
    return { ok: false, error: '上一則訊息還在處理中，請稍候' };
  }
  chatInFlight.add(charKey);
  const controller = new AbortController();
  chatAbortControllers.set(charKey, controller);
  updateGlobalEscapeRegistration();
  try {
    if (!(await isL2dReady())) {
      return { ok: false, error: 'L2D 尚未就緒（角色可能還在載入中），請稍後再試' };
    }

    // CLI 模式的觸發短語/離開短語，跟一般聊天完全分開處理——不呼叫 OpenAI/Ollama，
    // 不用檢查 API key，訊息也不進 chatMemoryStore（技術性質的操作記錄跟角色聊天記憶
    // 混在一起沒有意義，見 spec 的 Edge Cases）。
    const normalizedMsg = normalizeTriggerPhrase(message);
    if (!cliModeActive.has(charKey) && CLI_MODE_ENTER_PHRASES.has(normalizedMsg)) {
      cliModeActive.add(charKey);
      // 免確認模式開啟時把這件事講在最前面——使用者一進入 CLI 模式就該知道這次不會被
      // 逐步問過，而不是等到第一個風險操作自動執行完才發現（見 docs/adr/0010）。
      const reply = settingsStore.getCliFreePermissionMode()
        ? `已進入 CLI 模式，工作目錄是 ${CLAUDE_CLI_CWD}。⚡ 免確認模式目前是開啟的，遇到寫檔、跑指令等操作我會直接自動執行，只在這裡告訴你做了什麼，不會先問你。想離開的話說「退出 CLI 模式」，要關閉免確認模式請到設定畫面。`
        : `已進入 CLI 模式，工作目錄是 ${CLAUDE_CLI_CWD}。接下來跟我說的話都會送去 Claude Code 執行本機任務，遇到讀檔案以外的操作（寫檔、跑指令...）我會先問過你才做。想離開的話說「退出 CLI 模式」。`;
      logConversationTurn(charKey, 'CLI 模式', message, reply);
      await speakAndShow(charKey, reply);
      return { ok: true };
    }
    if (cliModeActive.has(charKey) && CLI_MODE_EXIT_PHRASES.has(normalizedMsg)) {
      cliModeActive.delete(charKey);
      claudeCliSessions.delete(charKey); // 半途的任務／待確認操作直接丟棄，不留著跨模式的殘留狀態
      setBrowserToolActive(charKey, false); // 退出時如果剛好卡在瀏覽器工具的待確認操作，不留下降級狀態殘留
      const reply = '已退出 CLI 模式，回到一般聊天。';
      logConversationTurn(charKey, 'CLI 模式', message, reply);
      await speakAndShow(charKey, reply);
      return { ok: true };
    }
    // 已經在 CLI 模式裡又講一次進入短語：不能落到下面的「已在 CLI 模式」邏輯，否則會被
    // 誤當成待確認操作的同意/拒絕回覆（interpretYesNo 判不出來會回「聽不懂」），或者沒有
    // 待確認操作時被當成任務 prompt 直接送給 Claude Code 執行。這裡當成無害的重申來處理，
    // 不觸碰現有 session／確認狀態。
    if (cliModeActive.has(charKey) && CLI_MODE_ENTER_PHRASES.has(normalizedMsg)) {
      const reply = '已經在 CLI 模式了，不用再說一次，要離開請說「退出CLI模式」。';
      logConversationTurn(charKey, 'CLI 模式', message, reply);
      await speakAndShow(charKey, reply);
      return { ok: true };
    }
    if (cliModeActive.has(charKey)) {
      let session = claudeCliSessions.get(charKey);
      let outcome;
      if (session && session.hasPendingConfirmation) {
        const allow = interpretYesNo(message);
        if (allow === null) {
          const reply = '我聽不懂這是同意還是拒絕，請明確回覆「同意」或「拒絕」。';
          logConversationTurn(charKey, 'CLI 模式', message, reply);
          await speakAndShow(charKey, reply);
          return { ok: true };
        }
        outcome = await session.resolveConfirmation(allow);
      } else {
        if (!session) {
          // freePermissionMode 讀的是「進入這個 session 當下」的設定值，中途在設定畫面切換
          // 不會影響已經在跑的 session——要重新進入 CLI 模式才會套用新值（見 claude-cli.js
          // 建構子的註解、docs/adr/0010）。onNarration 是免確認模式下的即時實況：跟一般
          // outcome 走的 speakAndShow 是同一個函式，但獨立呼叫、不經過 start()/
          // resolveConfirmation() 的回傳值，因為一個任務裡可能連續自動執行好幾個風險操作。
          session = new ClaudeCliSession({
            cwd: CLAUDE_CLI_CWD,
            freePermissionMode: settingsStore.getCliFreePermissionMode(),
            onNarration: (text, spokenText) => {
              logConversationTurn(charKey, 'CLI 模式（免確認自動執行）', '(無，自動執行中)', text);
              return speakAndShow(charKey, text, { spokenText });
            },
            // 見上面 setBrowserToolActive() 的說明：瀏覽器工具一開始要跑（不管最後是問過
            // 使用者還是免確認自動放行）就先把桌寵視窗降級，讓 Chrome 顯示得出來。
            onToolUse: (toolName) => {
              if (toolName.startsWith('mcp__playwright__')) setBrowserToolActive(charKey, true);
            },
          });
          claudeCliSessions.set(charKey, session);
        }
        outcome = await session.start(message);
      }
      // 任務真的結束了（不是還在等下一個確認）才恢復置頂等級——同一個任務裡可能連續
      // 好幾個瀏覽器工具呼叫，每次都呼叫 setBrowserToolActive(charKey, true) 是安全的
      // （Set 語意），但只有整個任務收尾（result／error／cancelled）才該恢復。
      if (outcome.type !== 'confirm') setBrowserToolActive(charKey, false);
      logConversationTurn(charKey, 'CLI 模式', message, outcome.text);
      // outcome.spokenText 只有 confirm 類型（等待同意/拒絕的風險操作）才會有值——result／
      // error 是 Claude 自己生成的自然語言或我們自己組的錯誤訊息，本來就適合直接念出來，
      // 不需要另外準備 spokenText（見 claude-cli.js canUseTool 只有 confirm 分支才傳）。
      await speakAndShow(charKey, outcome.text, { spokenText: outcome.spokenText });
      return { ok: true };
    }

    // 兩個 provider 分開檢查各自的必要設定，不要在還沒確定要用哪個之前就先擋 OpenAI
    // key——選了 Ollama 的使用者根本不需要 OpenAI key（見
    // docs/specs/0005-desktop-pet-ollama-provider.md）。
    const providerSettings = settingsStore.getChatProviderSettings();
    const apiKey = settingsStore.getApiKey();
    if (providerSettings.provider === 'openai' && !apiKey) {
      return { ok: false, error: '尚未設定 OpenAI API key，請先從系統匣「設定...」輸入' };
    }

    // 訊息裡若偵測到網址，先抓取內容當額外上下文；只處理第一個網址，抓取失敗優雅降級——
    // 讓角色照樣回覆（告知讀取失敗），不要讓一個網址讀取失敗擋住整段對話。
    // 純貼網址、沒附加問題時（把網址拿掉後訊息是空的）要明確告訴模型「使用者沒問問題，
    // 預設當作要摘要」，不然模型收到一段網址+一大坨網頁內文卻沒有明確指示，容易愣住
    // 或答非所問。
    let context = '';
    const urlMatch = message.match(CHAT_URL_REGEX);
    if (urlMatch) {
      const messageWithoutUrl = message.replace(urlMatch[0], '').trim();
      try {
        const pageText = await fetchPageText({ url: urlMatch[0], signal: controller.signal });
        const instruction = messageWithoutUrl
          ? '供回答參考'
          : '使用者只貼了網址、沒有附加問題，預設請摘要這個網頁的重點內容給使用者';
        context = `\n\n[使用者提到的網頁內容，${instruction}]\n${pageText}`;
      } catch (err) {
        // 使用者按 Esc 取消（見 index.html 的 Esc 判斷邏輯）：整個 chat-send 到此為止，
        // 不要當成「網址讀取失敗、照樣送去問 AI」繼續往下跑——那樣等於使用者取消不掉。
        if (err.name === 'AbortError') return { ok: false, cancelled: true };
        context = `\n\n[使用者提到的網址讀取失敗，請告知使用者無法讀取這個網頁：${err.message}]`;
      }
    }

    const systemPrompt = readPersonas()[charKey];
    const history = chatMemoryStore.getHistory(charKey);

    let reply;
    try {
      if (providerSettings.provider === 'ollama') {
        const result = await sendOllamaChatMessage({
          message: message + context, systemPrompt, history,
          model: providerSettings.ollamaModel, baseUrl: providerSettings.ollamaBaseUrl,
          signal: controller.signal,
        });
        reply = result.reply;
      } else {
        const result = await sendChatMessage({
          message: message + context, systemPrompt, history, apiKey, signal: controller.signal,
        });
        reply = result.reply;
      }
    } catch (err) {
      // 使用者按 Esc 取消——沒有回覆可以存，直接結束，不寫進 chatMemoryStore、也不
      // 呼叫 speakAndShow（沒有東西可以顯示/念出來）。跟上面網址讀取那段取消是同一種
      // 判斷方式（err.name === 'AbortError'），呼叫端（index.html）看 cancelled 這個
      // 欄位決定要不要顯示成錯誤——見那邊 sendTextMessage() 的說明。
      if (err.name === 'AbortError') return { ok: false, cancelled: true };
      return { ok: false, error: `聊天失敗（${err.code || 'UNKNOWN_ERROR'}）：${err.message}` };
    }

    // 使用者按 Esc 取消，但 OpenAI/Ollama 剛好在 abort() 送達前就已經回完整段回覆——
    // fetch 本身沒有東西可以中止，AbortError 不會發生，會直接落到這裡而不是上面的
    // catch。單靠「fetch 有沒有被真的中止」判斷取消，在回覆很快的短訊息上常常會因為
    // 這個時間差而「按了 Esc 卻還是看到回覆」，體感上像是 Esc 沒作用。這裡用
    // controller.signal.aborted 補一道判斷：只要 chat-cancel 呼叫過 abort()，
    // 不管底層 fetch 有沒有來得及被中止，一律當成取消處理，不寫進記憶、不顯示、
    // 不念出來——使用者的取消意圖優先於「回覆技術上已經拿到手」這件事。
    if (controller.signal.aborted) return { ok: false, cancelled: true };

    // 記憶只存原始使用者訊息（不含抓來的網頁內容），避免記憶檔案被網頁全文塞爆。
    chatMemoryStore.appendTurn(charKey, message, reply);
    logConversationTurn(charKey, providerSettings.provider === 'ollama' ? 'Ollama' : 'OpenAI', message, reply);
    await speakAndShow(charKey, reply);
    return { ok: true };
  } finally {
    chatInFlight.delete(charKey);
    chatAbortControllers.delete(charKey);
    updateGlobalEscapeRegistration();
  }
});

// 使用者打錯字/講錯話，趁「思考中」還沒收到回覆時按 Esc 收回——見 chatAbortControllers
// 宣告處的說明、index.html 的 Esc 判斷邏輯。只是呼叫 controller.abort()，實際的
// 「回傳取消結果、不寫進記憶、不念出來」邏輯都在 chat-send 的 catch 區塊處理，這裡
// 不用重複判斷狀態。
// CLI 模式的訊息也是走同一個 chat-send／chatRequestPending，index.html 那邊的 Esc
// 判斷邏輯不分辨目前是不是 CLI 模式，一律呼叫這個 IPC。
//
// 這裡曾經先查 chatAbortControllers、找不到才退回 claudeCliSessions，註解寫著
// 「兩者互斥（同一個 charKey 不會同時有 chatAbortControllers 的 entry 又在 CLI
// 模式）」——這個假設是錯的：chatAbortControllers.set(charKey, controller) 在
// chat-send 一開頭就無條件執行（早於任何 CLI 模式判斷），要到整個 handler 函式
// 結束（含 CLI 分支跑完）的 finally 才 delete。也就是說 CLI 任務執行期間，這個
// map 裡一樣有一筆 entry——但這個 controller 從來沒有被傳進 ClaudeCliSession
// 或 canUseTool 的任何地方，呼叫 controller.abort() 對 CLI 任務完全是空操作。
// 原本的寫法會先命中這個空操作、直接 return { ok: true }，實際上根本沒有取消
// 到任何東西，等於 CLI 模式底下 Esc 從來沒有真的生效過——即使桌寵視窗當下確實
// 有鍵盤焦點。改成先看 cliModeActive 判斷目前是不是 CLI 模式，是的話直接找
// claudeCliSessions 處理，不會被這個一直存在、卻沒有實際作用的 controller 攔截。
// 都找不到（例如訊息剛好在這個 IPC 送達前就已經處理完）就安靜什麼都不做，不當成
// 錯誤。
ipcMain.handle('chat-cancel', (_event, { charKey }) => {
  if (cliModeActive.has(charKey)) {
    const cliSession = claudeCliSessions.get(charKey);
    return { ok: cliSession ? cliSession.abort() : false };
  }
  const controller = chatAbortControllers.get(charKey);
  if (controller) { controller.abort(); return { ok: true }; }
  return { ok: false };
});

// 語音輸入要在真的呼叫 getUserMedia／開始錄音之前，先知道有沒有設定 API key
// （Acceptance Criteria #8：沒設定 key 不嘗試錄音，不是錄完轉錄才發現）。
ipcMain.handle('has-api-key', () => ({ hasKey: !!settingsStore.getApiKey() }));

// ── 語音輸入（docs/specs/0004-desktop-pet-voice-input.md）───────────────────
// 只管「錄音 bytes → 轉錄文字」這一步；轉錄完的文字由 renderer 端直接重用
// 上面的 chat-send 送出，不在這裡重複組一次對話流程（人設/記憶/網頁摘要/語音回覆
// 全部沿用既有的 chat-send，語音輸入只是換一種方式產生要送出的文字）。
ipcMain.handle('voice-transcribe', async (_event, { audioBase64, mimeType }) => {
  const apiKey = settingsStore.getApiKey();
  if (!apiKey) {
    return { ok: false, error: '尚未設定 OpenAI API key，請先從系統匣「設定...」輸入' };
  }
  let audioBuffer;
  try {
    audioBuffer = Buffer.from(audioBase64, 'base64');
  } catch {
    return { ok: false, error: '收到的錄音資料格式不對' };
  }
  const controller = new AbortController();
  voiceTranscribeController = controller;
  updateGlobalEscapeRegistration();
  try {
    const { text } = await transcribeAudio({ audioBuffer, mimeType, apiKey, signal: controller.signal });
    // 使用者按 Esc 取消，但 Whisper 剛好在 abort() 送達前就已經回完轉錄結果——跟
    // chat-send 那邊同一個時間差問題（見那裡的說明），短音檔常常來得及在使用者按下
    // Esc 前就轉錄完成。一律用 controller.signal.aborted 補判斷，取消意圖優先於
    // 「轉錄技術上已經拿到手」這件事。
    if (controller.signal.aborted) return { ok: false, cancelled: true };
    return { ok: true, text };
  } catch (err) {
    // 使用者按 Esc 取消（見 index.html 的 Esc 判斷邏輯）——跟 chat-cancel 同一套判斷方式。
    if (err.name === 'AbortError') return { ok: false, cancelled: true };
    return { ok: false, error: `語音轉錄失敗（${err.code || 'UNKNOWN_ERROR'}）：${err.message}` };
  } finally {
    if (voiceTranscribeController === controller) voiceTranscribeController = null;
    updateGlobalEscapeRegistration();
  }
});

// 使用者打錯字/講錯話，趁「轉錄中」按 Esc 收回（跟 chat-cancel 同一種模式，見那裡的
// 說明）。沒有進行中的轉錄就安靜什麼都不做，不當成錯誤。
ipcMain.handle('voice-transcribe-cancel', () => {
  const controller = voiceTranscribeController;
  if (controller) controller.abort();
  return { ok: !!controller };
});

// renderer 主動回報「現在有沒有在錄音」（見 preload.js notifyRecordingActive、
// index.html 的 isRecording 兩個切換點）——main process 看不到 MediaRecorder，
// 只能靠這個訊號決定全域 Escape 該不該保持註冊（見 hasAnyAbortableOperation）。
// 用 ipcMain.on 不是 handle：這只是單向通知，不需要回傳值。
ipcMain.on('recording-active', (_event, active) => {
  recordingActive = !!active;
  updateGlobalEscapeRegistration();
});

function buildSpeechTestSubmenu() {
  return SPEECH_TEST_ITEMS.map(({ label, charKey, text }) => ({
    label,
    click: () => speakText(charKey, text),
  }));
}

function buildMotionSubmenu() {
  return [
    ...MOTION_ACTIONS.map(({ label, call }) => ({
      label,
      click: () => triggerMotion(call),
    })),
    {
      label: isFlying ? '⏹ 停止飛行' : '對角線交叉飛行',
      click: () => toggleFly(),
    },
  ];
}

// 情境演出子選單：情境資料本身放在 desktop-pet/scenes.json（不再是寫死的
// scene-actions.js 清單），這裡每次開選單都直接讀一次最新內容，用「情境編輯器」
// 新增/修改情境後不用再手動改任何 .js 檔案，選單就會自動跟著出現。
// 跟動作測試共用同一個 triggerMotion()（executeJavaScript 到 renderer 呼叫
// window.ScenePlayer.trigger(...)），index.html 那邊的 ScenePlayer 自己會擋掉
// 「已經有情境在演出中」的重複觸發，這裡不用額外判斷。
function readScenes() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'scenes.json'), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[desktop-pet] 讀取 scenes.json 失敗，退回空清單：', err.message);
    return {};
  }
}

function buildSceneSubmenu() {
  const scenes = readScenes();
  const keys = Object.keys(scenes);
  if (!keys.length) return [{ label: '（尚無情境，開啟「情境編輯器」新增）', enabled: false }];
  return keys.map((key) => ({
    label: scenes[key].label || key,
    click: () => triggerMotion(`window.ScenePlayer.trigger(${JSON.stringify(key)})`),
  }));
}

// 「光粒子特效」開合成一個子選單：開關 + 分隔線 + particleModelKeys 清單（radio，
// 選了哪個就打勾）。particleModelKeys 由 refreshParticleModelKeys() 讀
// particle-effect/sources.js 填好，這裡單純渲染，不重讀檔案（避免每次開選單都
// 觸發一次動態 import()）。
function buildParticleEffectSubmenu() {
  const modelItems = particleModelKeys.length
    ? particleModelKeys.map((key) => ({
        label: key,
        type: 'radio',
        checked: key === activeParticleModel,
        click: () => selectParticleModel(key),
      }))
    : [{ label: '（sources.js 讀不到模型，或裡面還沒有任何項目）', enabled: false }];

  return [
    {
      label: particleEffectOn ? '關閉' : '開啟',
      type: 'checkbox',
      checked: particleEffectOn,
      click: () => toggleParticleEffect(),
    },
    {
      // 模式層級的控制，跟上面總開關放一起、跟下面的模型清單分開一段——選這個
      // 不是選某一個模型，是切換「要不要在全部模型之間連續變形」這個播放模式。
      // 快捷鍵 Ctrl+Alt+S 是同一個開關，兩邊觸發都會呼叫同一個 toggleParticleSequence()。
      label: `模型序列播放（Ctrl+Alt+S）${particleSequenceOn ? '：播放中' : ''}`,
      type: 'checkbox',
      checked: particleSequenceOn,
      click: () => toggleParticleSequence(),
    },
    { type: 'separator' },
    ...modelItems,
  ];
}

function buildTrayMenu() {
  const hasPendingChange = pendingChar1 !== currentChar1 || pendingChar2 !== currentChar2;
  const extraPetCandidates = getExtraPetCandidates();
  const charMenuItems = myLikeManifest.length
    ? [
        { type: 'separator' },
        { label: '角色一', submenu: buildCharSubmenu('char1') },
        { label: '角色二', submenu: buildCharSubmenu('char2') },
        {
          label: hasPendingChange ? '✅ 確定套用（重新整理）' : '確定套用（尚無變更）',
          enabled: hasPendingChange,
          click: () => applyMyLikeSelection(),
        },
        ...(extraPetCandidates.length
          ? [
              // 原生選單點一下就會收起來，勾選多隻很麻煩，改開一個獨立小視窗
              // （見 openExtraPetsPicker），可以一直開著勾好幾隻再一次套用。
              {
                label: extraPetIds.length ? `額外寵物設定...（場上總共 ${extraPetIds.length} 隻）` : '額外寵物設定...',
                click: () => openExtraPetsPicker(),
              },
              {
                label: '額外寵物隨機遊走',
                type: 'checkbox',
                checked: extraPetWander,
                click: () => toggleExtraPetWander(),
              },
            ]
          : []),
      ]
    : [];

  return Menu.buildFromTemplate([
    {
      label: clickThrough ? '切換成互動模式（可拖曳角色）' : '切換成穿透模式（滑鼠穿透桌面）',
      click: () => setClickThrough(!clickThrough),
    },
    { label: '還原預設位置/縮放', click: () => resetPosition() },
    { label: '動作測試', submenu: buildMotionSubmenu() },
    { label: '語音測試', submenu: buildSpeechTestSubmenu() },
    { label: '情境演出', submenu: buildSceneSubmenu() },
    { label: '光粒子特效', submenu: buildParticleEffectSubmenu() },
    ...charMenuItems,
    { type: 'separator' },
    { label: '設定...', click: () => openSettings() },
    { label: '模型命名管理...', click: () => openNameManager() },
    { label: '情境編輯器...', click: () => openSceneEditor() },
    { type: 'separator' },
    { label: '清除本機快取並重開...', click: () => openClearCacheConfirm() },
    { type: 'separator' },
    { label: '結束', click: () => app.quit() },
  ]);
}

function createTray() {
  try {
    // tray-icon.png 是預先從 desktop-pet/default_avatar.png 裁切/縮放好的正規 32x32 PNG
    // （離線用 PIL 產生，避免在執行期用 nativeImage 處理來源檔而重演之前的崩潰；
    // default_avatar.png 是從 multi/default_avatar.png 複製過來的獨立副本，見 README.md）
    let icon = nativeImage.createFromPath(path.join(__dirname, 'tray-icon.png'));
    if (icon.isEmpty()) {
      console.warn('[desktop-pet] tray-icon.png 讀取失敗，改用內建純色圖示');
      icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
    }
    tray = new Tray(icon);
    tray.setContextMenu(buildTrayMenu());
  } catch (err) {
    console.error('[desktop-pet] 系統匣圖示建立失敗，改用快捷鍵操作即可：', err);
  }
}

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  win = new BrowserWindow({
    width,
    height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      // 視窗真的被最小化／隱藏，或（即使關了原生遮擋偵測）仍被判定為背景時，
      // 不要把 renderer 的計時器與 rAF 降頻——桌寵要一直動。搭配上面的
      // CalculateNativeWinOcclusion switch 一起，確保被便利貼牆蓋住也不會凍。
      backgroundThrottling: false,
    },
  });
  // 建構子的 alwaysOnTop:true 只給預設置頂等級，跟 raiseAboveDesktopPets() 那幾個小視窗
  // 一開始踩過的坑一樣：Windows 不保證預設等級的置頂視窗，一定會疊在使用者點擊到的
  // 其他一般視窗（瀏覽器、IDE...）上面——使用者切去做別的事、點別的視窗時，桌寵
  // （含文字泡泡）容易被蓋住、視覺上像是「消失了」。用 raiseAboveDesktopPets() 同一個
  // 'screen-saver' 最高置頂等級，確保不管使用者點哪個視窗，桌寵都留在最上層可見。
  // focus() 完全不能加，不然會變成每次都搶走使用者剛點的其他視窗的焦點，反而干擾他
  // 去做別的事；moveTop() 只動 z-order、不搶焦點，可以安全地重複呼叫（見下面的自我置頂迴圈）。
  win.setAlwaysOnTop(true, 'screen-saver');

  // ── 讓桌寵穩定疊在「桌面便利貼牆」(C:\Tools\file_search\wallpaper-app) 之上 ──────
  // 便利貼牆跟桌寵一樣把自己釘在 'screen-saver'——Windows 上這是最高置頂帶，沒有更高
  // 一階可用，同帶內誰在上面完全看誰「最後一個」呼叫 SetWindowPos。便利貼牆會在切換
  // 即時模式、螢幕解析度變動、Shift+X 顯示、按「結束程式」鈕取得焦點時重新 setAlwaysOnTop，
  // 一旦觸發就蓋到桌寵上面；桌寵這邊只在建視窗時設一次鬥不過。低頻率地把自己重新頂回
  // 最上層來解決。這些事件都是零星觸發，1 秒一次即可，使用者幾乎不會察覺曾被蓋住。
  const petOwnChildWindows = () =>
    [extraPetsPickerWin, nameManagerWin, settingsWin, sceneEditorWin, clearCacheWin];
  const keepPetOnTopTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    // CLI 模式跑瀏覽器工具時桌寵是「刻意」降級的（見 setBrowserToolActive），那段期間
    // 不要把 Chrome 又蓋回去。
    if (browserLoweredChars.size > 0) return;
    // 桌寵自己的設定／改名／場景編輯…小視窗開著時暫停自我置頂：那些視窗本來就該在
    // 桌寵之上（raiseAboveDesktopPets），而且它們開著時使用者不會同時在點便利貼牆，
    // 沒有「被牆蓋住」的急迫性；小視窗一關，下一個 tick 就恢復自我置頂。
    if (petOwnChildWindows().some((w) => w && !w.isDestroyed() && w.isVisible())) return;
    win.setAlwaysOnTop(true, 'screen-saver');
    win.moveTop();
  }, 1000);
  win.on('closed', () => clearInterval(keepPetOnTopTimer));

  // 把 renderer 端「手動微調 debug 工具」（particle-effect.js 的
  // handleManualNudgeKey()）印的 [particle-debug] 開頭訊息轉印到這個終端機——
  // renderer 的 console.log 預設只會出現在 DevTools 的 Console 分頁，不會進到
  // `npm start` 這個終端機視窗。只過濾白名單前綴的訊息，不是全部 renderer console
  // 訊息都轉印：particle-sampler.js／particle-effect.js 其他地方的 log 已經很多，
  // 全部轉印會把終端機灌爆，而且那些原本就只是給 DevTools 除錯用，沒有「一定要在
  // 終端機看到」的需求。「閒置閒聊音效音量」/「對話語音回覆音量」（Ctrl+Alt+[/]/-/=
  // 調整時印的，見下面音量快捷鍵註冊處）也在白名單內——使用者要求按下這幾顆快捷鍵
  // 時終端機也要看得到目前音量，即使按住連發會多印幾行，這裡優先滿足這個需求。
  win.webContents.on('console-message', (_event, _level, message) => {
    if (
      message.startsWith('[particle-debug]') ||
      message.startsWith('[desktop-pet] 閒置閒聊音效音量：') ||
      message.startsWith('[desktop-pet] 對話語音回覆音量：')
    ) {
      console.log(message);
    }
  });

  // 專案持續在開發，index.html／lib 底下的檔案隨時可能被改動，強制這個視窗永遠拿最新版，
  // 不要被 Chromium 自己的磁碟快取卡住（跟瀏覽器分頁踩過的 Cache-Control 問題是同一類風險）：
  // 1) 每次啟動先清掉舊視窗累積下來的快取
  // 2) 之後每個回應都在 session 層強制蓋成 no-store，不管內容本身有沒有送這個標頭
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    details.responseHeaders['Cache-Control'] = ['no-store'];
    callback({ responseHeaders: details.responseHeaders });
  });

  // 語音輸入要用麥克風（docs/adr/0007）：只自動放行 media（麥克風/攝影機）這一種權限，
  // 其他類型維持預設拒絕，不是整個放飛權限檢查。桌寵沒有分割 session（多個視窗共用
  // defaultSession），註冊在這裡即可涵蓋所有視窗；反正只有這個主視窗會真的呼叫
  // getUserMedia，其他視窗（設定/情境編輯器等）不會觸發這個 handler。
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media');
  });

  win.setIgnoreMouseEvents(clickThrough, { forward: true });
  // clearCache() 是非同步的，一定要等它 resolve 才能呼叫 loadFile()——舊寫法是
  // `clearCache().catch(() => {})` 之後緊接著同步呼叫 loadFile()，兩者幾乎同時觸發，
  // 等於清快取跟載入頁面在賽跑，不保證清完才開始載入，這就是「改完 renderer 端程式碼、
  // 使用者重開 app 卻還是吃到改之前的舊版」的根因（見
  // docs/specs/0004-desktop-pet-voice-input.md 麥克風幻覺那幾輪除錯的經過）。改用
  // .finally() 而不是 .then()：清快取失敗也要照樣載入頁面，不能讓這個失敗卡住整個
  // 桌寵開不起來，跟原本 .catch(() => {}) 吞掉錯誤但繼續跑的行為一致。
  win.webContents.session.clearCache().finally(() => {
    win.loadFile(path.join(__dirname, 'index.html'));
  });

  // 每次載入/重新整理完成後，跟畫面上實際生效的角色選擇對一次（包含 applyMyLikeSelection() 觸發的 reload）
  win.webContents.on('did-finish-load', () => {
    syncMyLikeSelectionFromRenderer();
    // particle-effect.js 每次 reload（F8、套用角色選擇...）都會重新初始化成它
    // 自己的預設值（開關永遠回到關閉），這裡補兩次同步，讓系統匣選單勾選狀態、
    // 滑鼠抓取游標判斷跟畫面實際狀態對齊（見 syncParticleModelFromRenderer()／
    // syncParticleEffectStateFromMain() 開頭的說明）。
    syncParticleModelFromRenderer();
    syncParticleEffectStateFromMain();
    // 模型序列播放沒有「開機預設值」這種東西（見 particleSequenceOn 宣告處的
    // 說明），每次 reload 都直接同步，不用像下面 particleEffectOn 那樣分
    // 「第一次啟動」跟「之後 reload」兩種情況處理。
    syncParticleSequenceEnabledFromRenderer();

    // Live2D 顯示：套用使用者在設定畫面存的開機預設值（settingsStore.getShowLive2DOnStartup()）。
    // 這個沒有運行期切換（不像光粒子特效有系統匣選單可以隨時開關），永遠等於這份
    // 設定，每次 reload 都套用同一個值即可，不用像下面 particleEffectOn 那樣分
    // 「第一次啟動」跟「之後 reload」兩種情況處理。
    win.webContents.executeJavaScript(
      `window.setLive2DVisible ? window.setLive2DVisible(${settingsStore.getShowLive2DOnStartup()}) : null`
    ).catch(() => {});

    if (!hasAppliedParticleEffectStartupDefault) {
      // 桌寵這次真的剛啟動：套用使用者設定的開機預設值，不透過
      // syncParticleEffectEnabledFromRenderer() 校正——那個函式是拿 renderer 的
      // 「真實現況」回頭校正 main.js 記的 particleEffectOn，但第一次啟動時
      // renderer 才剛開始載入、還沒套用任何東西，讀到的是「還沒套用開機預設值前」
      // 的暫時關閉狀態，這時候校正只會把剛剛從設定畫面讀回來的 particleEffectOn
      // 錯誤地蓋回 false。
      hasAppliedParticleEffectStartupDefault = true;
      if (particleEffectOn) {
        win.webContents
          .executeJavaScript(`window.setParticleEffect ? window.setParticleEffect(true) : null`)
          .catch(() => {});
      }
    } else {
      // 之後任何 reload（F8、套用角色選擇...）：維持原本修好的行為——
      // particle-effect.js reload 後一律回到關閉，這裡讓 main.js 記的狀態（系統匣
      // 勾選）跟著對齊，不會卡在 reload 前的勾選狀態（見 syncParticleEffectEnabledFromRenderer()
      // 開頭的說明）。這裡刻意不再套用開機預設值，不然每次 F8 都會自動重新打開
      // 特效，跟「F8 reload 一律回到關閉」的既有修正互相矛盾。
      syncParticleEffectEnabledFromRenderer();
    }
  });

  // F9：切換「點擊穿透」。單一按鍵，比組合鍵好按。若跟其他軟體快捷鍵衝突導致註冊失敗，
  // 系統匣圖示（右下角、右鍵選單）是保證能用的備援切換方式。
  const ok = globalShortcut.register('F9', () => setClickThrough(!clickThrough));
  if (!ok) console.warn('[desktop-pet] F9 全域快捷鍵註冊失敗（可能跟其他程式衝突），請改用系統匣圖示右鍵選單切換');

  const okQ = globalShortcut.register('F10', () => app.quit());
  if (!okQ) console.warn('[desktop-pet] F10 全域快捷鍵註冊失敗，請改用系統匣圖示右鍵選單結束');

  // Ctrl+Alt+C：跟 F10 做同一件事（結束桌寵），多一個安全前綴組合鍵當備援——F10 是
  // 裸鍵，比較容易跟其他常駐軟體（截圖/錄影工具、瀏覽器擴充功能等）的全域快捷鍵衝突。
  // 使用者要求這顆一定要在終端機印出提示，跟 F10 靜默結束不同，好讓「桌寵是被快捷鍵
  // 結束的，不是當掉」這件事在終端機看得到，不用回頭猜。
  const okQuit = globalShortcut.register('Control+Alt+C', () => {
    console.log('[desktop-pet] 收到 Ctrl+Alt+C，結束桌寵。');
    app.quit();
  });
  if (!okQuit) console.warn('[desktop-pet] Ctrl+Alt+C 全域快捷鍵註冊失敗（可能跟其他程式衝突），請改用 F10 或系統匣圖示右鍵選單結束');

  const okReset = globalShortcut.register('F8', resetPosition);
  if (!okReset) console.warn('[desktop-pet] F8 全域快捷鍵註冊失敗，請改用系統匣圖示右鍵選單還原');

  // Ctrl+Shift+I：開關 DevTools。這個視窗沒有設定應用程式選單（frame:false 本來就沒有
  // 選單列），Electron 預設綁在選單上的「切換開發人員工具」F12/Ctrl+Shift+I 快捷鍵不會
  // 生效，所以跟 F8/F9/F10 一樣手動註冊一個。原本試過 F12，但那顆鍵很容易被其他軟體
  // （截圖/錄影工具等）全域佔用，改用瀏覽器 DevTools 同款的 Ctrl+Shift+I 組合鍵比較不
  // 容易撞。主要是給校正 particle-effect（光粒子特效）模型的 scale/position/rotation
  // 用——particle-sampler.js 沒填 scale/position 時會把自動置中縮放算出來的包圍盒
  // 尺寸/中心印在 Console，直接照著抄就是校正起點。
  const okDevTools = globalShortcut.register('CommandOrControl+Shift+I', () => win.webContents.toggleDevTools());
  if (!okDevTools) console.warn('[desktop-pet] Ctrl+Shift+I 全域快捷鍵註冊失敗（可能跟其他程式衝突）');

  // Ctrl+Alt+S：切換「模型序列播放」（S 對應 Sequence；一鍵在 sources.js 的多個
  // 模型之間連續變形，無限循環，直到再按一次停止，見 particle-effect.js 的
  // window.setParticleSequencePlayback()）。原本試過 Ctrl+Alt+M，註冊失敗（跟
  // 其他程式衝突，Windows 上很多軟體的靜音/切換快捷鍵會搶 Ctrl+Alt+M），改用
  // 這個。跟下面 Ctrl+Alt+數字鍵盤同一種安全前綴慣例（避開會被日常打字誤觸的
  // 裸鍵），註冊失敗時比照 F8/F9/F10，提示改用系統匣選單。
  const okSequence = globalShortcut.register('Control+Alt+S', () => toggleParticleSequence());
  if (!okSequence) console.warn('[desktop-pet] Ctrl+Alt+S 全域快捷鍵註冊失敗（可能跟其他程式衝突），請改用系統匣圖示右鍵選單切換');

  // Ctrl+Alt+E／Ctrl+Alt+V：切換桌寵左下角那兩顆音效按鈕（見 index.html 的
  // makeMuteButton()），不用切成互動模式、點得到按鈕才能操作。E 對應「閒置閒聊
  // 音效」（角色待機時的環境音效，Effect）、V 對應「對話語音回覆」（即時對話的
  // TTS 語音，Voice）——兩顆按鈕本來就用不同顏色色條/徽章區分（見 index.html
  // makeMuteButton() 的說明），這裡的快捷鍵字母跟著同一組英文意象取，方便記。
  // 跟 Ctrl+Alt+S 同一種安全前綴慣例，避開日常打字會誤觸的裸鍵；實際切換邏輯
  // 呼叫 index.html 掛在 window 上的 toggleIdleChatSound()/toggleTtsSound()，
  // 跟滑鼠點按鈕共用同一份 toggle()，不會兩邊邏輯兜不起來。
  const okChatSound = globalShortcut.register('Control+Alt+E', () => {
    win.webContents
      .executeJavaScript('window.toggleIdleChatSound ? window.toggleIdleChatSound() : null')
      .catch((err) => console.error('[desktop-pet] Ctrl+Alt+E 切換閒置閒聊音效失敗：', err));
  });
  if (!okChatSound) console.warn('[desktop-pet] Ctrl+Alt+E 全域快捷鍵註冊失敗（可能跟其他程式衝突），請改用畫面左下角的音效按鈕切換');

  const okTtsSound = globalShortcut.register('Control+Alt+V', () => {
    win.webContents
      .executeJavaScript('window.toggleTtsSound ? window.toggleTtsSound() : null')
      .catch((err) => console.error('[desktop-pet] Ctrl+Alt+V 切換對話語音回覆失敗：', err));
  });
  if (!okTtsSound) console.warn('[desktop-pet] Ctrl+Alt+V 全域快捷鍵註冊失敗（可能跟其他程式衝突），請改用畫面左下角的音效按鈕切換');

  // Ctrl+Alt+N：切換 3D 模型微調 debug 模式（N 對應「Nudge」，跟 particle-effect.js
  // 的 MANUAL_NUDGE_KEYS／handleManualNudgeKey() 是同一組詞彙）。這組方向鍵/[ ]/
  // PageUp/PageDown/Home/End/R/P 原本借用「互動模式」當開關，但互動模式同時也是能
  // 打字聊天的狀態，方向鍵會被這裡搶走、聊天輸入框的游標移動反而失效——改成獨立、
  // 預設關閉的開關，只有明確按過這顆快捷鍵才會生效，用完記得再按一次關掉，避免忘記
  // 開著、之後打字時又被搶鍵。呼叫 particle-effect.js 掛在 window 上的
  // toggleParticleNudgeMode()，開/關都會印 [particle-debug] 開頭的訊息（見上面
  // console-message 白名單，會同時出現在 DevTools Console 跟這個終端機視窗）。
  const okNudgeMode = globalShortcut.register('Control+Alt+N', () => {
    win.webContents
      .executeJavaScript('window.toggleParticleNudgeMode ? window.toggleParticleNudgeMode() : null')
      .catch((err) => console.error('[desktop-pet] Ctrl+Alt+N 切換 3D 模型微調模式失敗：', err));
  });
  if (!okNudgeMode) console.warn('[desktop-pet] Ctrl+Alt+N 全域快捷鍵註冊失敗（可能跟其他程式衝突）');

  // Ctrl+Alt+Z：等同直接點麥克風鈕，不用先點角色開輸入框再點🎤兩個步驟。原本用
  // Ctrl+Alt+M（M 對應「Mic」），但上面 Ctrl+Alt+S 那段註解就記過 Windows 上很多
  // 軟體的靜音/切換快捷鍵會搶 Ctrl+Alt+M，這裡也一樣踩到，改用 Z（跟其他既有快捷鍵
  // 沒有衝突，鍵盤位置也好按）。因為是全域快捷鍵（OS 層級攔截），互動/穿透模式都
  // 按得到——穿透模式下滑鼠點不到角色本體，這是唯一能直接開口說話的入口。呼叫
  // index.html 掛在 window 上的 startVoiceChatShortcut()：聊天框沒開就先開給目前
  // 有就緒的角色，再等同觸發一次🎤點擊（見該函式定義處說明，含「錄音中再按一次＝
  // 提前停止」「開講前先打斷正在播放的角色語音，避免錄到自己回覆造成回授」這些跟
  // 滑鼠操作一致的行為）。
  const okVoiceChat = globalShortcut.register('Control+Alt+Z', () => {
    win.webContents
      .executeJavaScript('window.startVoiceChatShortcut ? window.startVoiceChatShortcut() : null')
      .catch((err) => console.error('[desktop-pet] Ctrl+Alt+Z 觸發語音輸入失敗：', err));
  });
  if (!okVoiceChat) console.warn('[desktop-pet] Ctrl+Alt+Z 全域快捷鍵註冊失敗（可能跟其他程式衝突）');

  // Ctrl+Alt+[／]：調「閒置閒聊音效」音量（跟上面 Ctrl+Alt+E 切的是同一顆按鈕）；
  // Ctrl+Alt+-／=：調「對話語音回覆」音量（跟 Ctrl+Alt+V 切的是同一顆）。方括號/
  // 減等號各自成對、位置相鄰好記，跟切靜音用的 E/V 字母刻意分開，避免同一顆鍵
  // 身兼「切靜音」跟「調音量」兩種語意。呼叫 index.html 掛在 window 上的
  // adjustIdleChatVolume()/adjustTtsVolume()，每次 ±10%，並印目前音量（見 index.html
  // 該函式的說明）——這則 log 在上面 win.webContents.on('console-message', ...) 的
  // 白名單內，會同時出現在 DevTools Console 跟這個終端機視窗。
  const VOLUME_STEP = 0.1;
  const okChatVolDown = globalShortcut.register('Control+Alt+[', () => {
    win.webContents
      .executeJavaScript(`window.adjustIdleChatVolume ? window.adjustIdleChatVolume(-${VOLUME_STEP}) : null`)
      .catch((err) => console.error('[desktop-pet] Ctrl+Alt+[ 調降閒置閒聊音效音量失敗：', err));
  });
  if (!okChatVolDown) console.warn('[desktop-pet] Ctrl+Alt+[ 全域快捷鍵註冊失敗（可能跟其他程式衝突）');

  const okChatVolUp = globalShortcut.register('Control+Alt+]', () => {
    win.webContents
      .executeJavaScript(`window.adjustIdleChatVolume ? window.adjustIdleChatVolume(${VOLUME_STEP}) : null`)
      .catch((err) => console.error('[desktop-pet] Ctrl+Alt+] 調升閒置閒聊音效音量失敗：', err));
  });
  if (!okChatVolUp) console.warn('[desktop-pet] Ctrl+Alt+] 全域快捷鍵註冊失敗（可能跟其他程式衝突）');

  const okTtsVolDown = globalShortcut.register('Control+Alt+-', () => {
    win.webContents
      .executeJavaScript(`window.adjustTtsVolume ? window.adjustTtsVolume(-${VOLUME_STEP}) : null`)
      .catch((err) => console.error('[desktop-pet] Ctrl+Alt+- 調降對話語音回覆音量失敗：', err));
  });
  if (!okTtsVolDown) console.warn('[desktop-pet] Ctrl+Alt+- 全域快捷鍵註冊失敗（可能跟其他程式衝突）');

  const okTtsVolUp = globalShortcut.register('Control+Alt+=', () => {
    win.webContents
      .executeJavaScript(`window.adjustTtsVolume ? window.adjustTtsVolume(${VOLUME_STEP}) : null`)
      .catch((err) => console.error('[desktop-pet] Ctrl+Alt+= 調升對話語音回覆音量失敗：', err));
  });
  if (!okTtsVolUp) console.warn('[desktop-pet] Ctrl+Alt+= 全域快捷鍵註冊失敗（可能跟其他程式衝突）');

  // Ctrl+Alt+數字鍵盤 1~9：依序觸發 scenes.json 裡的情境，順序跟系統匣「情境演出」子選單
  // （buildSceneSubmenu()）完全一致——都是 Object.keys(readScenes())，同一份資料來源，
  // 不會兩邊對不上。每次按下才即時呼叫 readScenes()，不是註冊當下就把情境名稱寫死，
  // 所以「情境編輯器」新增/刪除/調整過情境之後，數字鍵對應的內容會自動跟著換，
  // 不用重開桌寵、也不用重新註冊快捷鍵。
  // 原本只綁裸的 num1~num9，結果 globalShortcut 是整個作業系統層級攔截，桌寵一直開著
  // 就等於數字鍵盤整個被吃掉，會議記錄、試算表等日常輸入數字都會失效。改成一定要
  // 搭配 Ctrl+Alt 這個平常打字幾乎不會同時按到的組合，兩邊需求才能並存：情境觸發
  // 還是不用切到互動模式、隨時按得到；一般作業敲數字鍵盤完全不受影響。
  for (let n = 1; n <= 9; n++) {
    const okScene = globalShortcut.register(`Control+Alt+num${n}`, () => {
      const keys = Object.keys(readScenes());
      const key = keys[n - 1];
      if (!key) {
        console.log(`[desktop-pet] Ctrl+Alt+數字鍵盤 ${n} 沒有對應的情境（目前只有 ${keys.length} 個）`);
        return;
      }
      triggerMotion(`window.ScenePlayer.trigger(${JSON.stringify(key)})`);
    });
    if (!okScene) console.warn(`[desktop-pet] Ctrl+Alt+數字鍵盤 ${n}（Control+Alt+num${n}）全域快捷鍵註冊失敗，可能跟其他程式衝突，請改用系統匣圖示右鍵選單觸發情境`);
  }
}

// ── 本機控制伺服器：給 desktop-pet-web 網頁按鈕用（見 control-server.js 開頭說明）──
// 只包一層轉接，實際動作都重用桌寵既有的函式（setClickThrough／triggerMotion／
// resetPosition），跟系統匣選單、快捷鍵是同一套邏輯、同一份狀態，不會兩邊對不上。
function randomMotion() {
  if (!MOTION_ACTIONS.length) return;
  const { call } = MOTION_ACTIONS[Math.floor(Math.random() * MOTION_ACTIONS.length)];
  triggerMotion(call);
}

function getControlStatus() {
  return {
    visible: !!(win && !win.isDestroyed() && win.isVisible()),
    clickThrough,
    isFlying,
    interactiveAutoRevertAt: interactiveAutoRevertDeadline,
  };
}

// preload 腳本載入失敗（例如踩到 sandbox 模式限制 require 本地檔案、或路徑打錯）預設
// 只會在該視窗自己的 DevTools console 印一行，main process 這邊的終端機完全看不到、
// 很容易誤以為是別的原因——這裡把它轉印出來，任何視窗的 preload 出這種問題都能在
// 啟動桌寵的終端機直接看到，不用一個一個開 DevTools 找。
app.on('preload-error', (_event, preloadPath, error) => {
  console.error('[desktop-pet] preload 腳本載入失敗：', preloadPath, '\n', error);
});

app.whenReady().then(async () => {
  loadMyLikeManifest();
  // 開 tray 選單前先把光粒子模型清單讀好，避免「光粒子特效」子選單第一次打開
  // 時是空的、要等下一次選單重畫才補上（見 refreshParticleModelKeys() 開頭說明）。
  await refreshParticleModelKeys();
  watchParticleModelSources();
  createWindow();
  createTray();
  console.log([
    '[desktop-pet] 啟動完成，快捷鍵：',
    '[desktop-pet]   F8 還原預設位置/縮放',
    '[desktop-pet]   F9 切換互動/穿透模式',
    '[desktop-pet]   F10 結束',
    '[desktop-pet]   Ctrl+Alt+C 結束（跟 F10 一樣，備援組合鍵，觸發時會印這行提示）',
    '[desktop-pet]   Ctrl+Alt+數字鍵盤 1-9 依序觸發情境',
    '[desktop-pet]   Ctrl+Alt+E 切換閒置閒聊音效',
    '[desktop-pet]   Ctrl+Alt+V 切換對話語音回覆',
    '[desktop-pet]   Ctrl+Alt+N 切換 3D 模型微調 debug 模式（開啟後方向鍵/[ ]/PageUp/PageDown/Home/End/R/P 才會生效）',
    '[desktop-pet]   Ctrl+Alt+S 切換模型序列播放（sources.js 設定的多個 3D 模型間連續變形，跟系統匣「光粒子特效」子選單是同一個開關）',
    '[desktop-pet]   Ctrl+Alt+Z 直接開始語音輸入（等同點🎤，穿透模式下也按得到）',
    '[desktop-pet]   Ctrl+Alt+[ / ] 調降/調升閒置閒聊音效音量',
    '[desktop-pet]   Ctrl+Alt+- / = 調降/調升對話語音回覆音量',
    '[desktop-pet]   Ctrl+Shift+I 開關 DevTools（校正 particle-effect 模型 scale/position 用，見 particle-effect/動畫參數說明.md）',
  ].join('\n'));
  setClickThrough(clickThrough);
  startControlServer({
    getStatus: getControlStatus,
    // show()/hide() 除了視窗層級的顯示/隱藏，還會呼叫 index.html 的
    // reloadLive2DForShow()/unloadLive2DForHide()（見該檔案定義處說明），讓「隱藏」
    // 真的把主角色模型 destroy() 掉、釋放 GPU/貼圖資源，不是只有視窗看不到而已。
    // win.show()/win.hide() 先執行讓使用者感受到的顯示/隱藏是立即的，卸載/重新載入
    // 模型另外非同步跑、失敗只印警告，不擋住視窗顯示/隱藏本身。
    show: () => {
      if (!win || win.isDestroyed()) return;
      win.show();
      win.webContents
        .executeJavaScript('window.reloadLive2DForShow ? window.reloadLive2DForShow() : Promise.resolve(false)')
        .catch((err) => console.error('[desktop-pet] 顯示桌寵時重新載入模型失敗：', err));
    },
    hide: () => {
      if (!win || win.isDestroyed()) return;
      win.hide();
      win.webContents
        .executeJavaScript('window.unloadLive2DForHide ? window.unloadLive2DForHide() : Promise.resolve(false)')
        .catch((err) => console.error('[desktop-pet] 隱藏桌寵時卸載模型失敗：', err));
    },
    toggleInteractive: toggleInteractiveFromWeb,
    randomMotion,
    resetPosition,
  });
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());
