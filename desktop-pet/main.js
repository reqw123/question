'use strict';
const { app, BrowserWindow, globalShortcut, screen, Tray, Menu, nativeImage, ipcMain, session, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const settingsStore = require('./settings-store.js');
const { synthesizeSpeech } = require('./tts.js');
const { sendChatMessage } = require('./chat.js');
const { fetchPageText } = require('./page-digest.js');
const chatMemoryStore = require('./chat-memory-store.js');
const { transcribeAudio } = require('./stt.js');

// 未預期的錯誤一律印到終端機，不讓主行程默默中止（方便排查）
process.on('uncaughtException', (err) => {
  console.error('[desktop-pet] 未預期錯誤，程式可能已停止運作：', err);
});

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
  return [
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
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch {}
  try { names = JSON.parse(fs.readFileSync(path.join(dir, 'names.json'), 'utf8')); } catch {}
  try { history = JSON.parse(fs.readFileSync(path.join(dir, 'names_history.json'), 'utf8')); } catch {}
  return { manifest, names, history };
}

// names.json 存檔完之後，把這次出現過的名字一併併入 names_history.json（只增不減），
// 回傳更新後的歷史清單，讓視窗不用關掉重開就能立刻在名字池選單看到剛剛新打的名字。
function appendNameHistory(names) {
  const dir = path.join(__dirname, '..', 'live2d_my_like', 'config');
  const historyPath = path.join(dir, 'names_history.json');
  let history = [];
  try { history = JSON.parse(fs.readFileSync(historyPath, 'utf8')); } catch {}
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
    settingsWin.webContents.send('init', { hasKey: !!settingsStore.getApiKey(), micSettings: settingsStore.getMicSettings() });
    return;
  }
  settingsWin = new BrowserWindow({
    width: 420,
    height: 560,
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
    settingsWin.webContents.send('init', { hasKey: !!settingsStore.getApiKey(), micSettings: settingsStore.getMicSettings() });
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

// 語音輸入的靜音/幻覺防呆兩個門檻（見 docs/specs/0004-desktop-pet-voice-input.md）。
// 'get-mic-settings' 給桌寵主視窗（preload.js 的 petBridge）在每次開始錄音前問目前值，
// 跟設定視窗開啟時塞進 'init' payload 的 micSettings 是同一份資料、同一個來源
// （settingsStore.getMicSettings()），不會兩邊算出不一樣的值。
ipcMain.handle('get-mic-settings', () => settingsStore.getMicSettings());

ipcMain.handle('settings-save-mic-settings', (_event, payload) => settingsStore.saveMicSettings(payload));

ipcMain.handle('settings-reset-mic-settings', () => settingsStore.resetMicSettings());

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
  } catch {
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

function setClickThrough(value) {
  clickThrough = value;
  win.setIgnoreMouseEvents(clickThrough, { forward: true });
  const label = clickThrough ? '穿透模式（滑鼠會穿透到桌面）' : '互動模式（可拖曳角色）';
  console.log(`[desktop-pet] 目前狀態：${label}`);
  if (tray) {
    tray.setToolTip(`Live2D 桌面掛件 — ${label}`);
    tray.setContextMenu(buildTrayMenu());
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
// lib/live2d.js 的 speakFor() 本來就吃一個 duration（ms）選項，不帶的話 type:'info'
// 預設是 L2D_CFG.speechDurationBefore＝3000ms——那是幫問答遊戲「答題前提示」調的，
// 一兩句話就好，即時對話的回覆通常長得多，3 秒常常字都還沒看完就消失了。這裡不改
// lib/live2d.js 本身（唯讀引用），純粹在呼叫端算一個跟文字長度成比例的 duration 蓋過去。
function bubbleDurationFor(text) {
  const MIN_MS = 4000, MAX_MS = 20000, MS_PER_CHAR = 180;
  return Math.max(MIN_MS, Math.min(MAX_MS, text.length * MS_PER_CHAR));
}

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

async function speakAndShow(charKey, text) {
  const apiKey = settingsStore.getApiKey();
  let audioBuffer;
  try {
    audioBuffer = await synthesizeSpeech({ text, apiKey });
  } catch (err) {
    console.error(`[desktop-pet] 語音合成失敗（${err.code || 'UNKNOWN_ERROR'}）：${err.message}`);
  }
  const fn = charKey === 'c2' ? 'speak2' : 'speak';
  const duration = bubbleDurationFor(text);
  triggerMotion(`typeof L2D !== 'undefined' && L2D.${fn} && L2D.${fn}(${JSON.stringify(text)}, { type: 'info', duration: ${duration} })`);
  if (audioBuffer) {
    // charKey 一併送過去，讓 renderer 端知道該把嘴型同步套用到哪個角色的模型
    // （見 docs/specs/0003-desktop-pet-lip-sync.md）。
    const playbackFinished = waitForTtsPlaybackFinished();
    win.webContents.send('play-tts-audio', { audioBase64: audioBuffer.toString('base64'), charKey });
    await playbackFinished;
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

function readPersonas() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'personas.json'), 'utf8'));
    return {
      c1: (typeof data.c1 === 'string' && data.c1.trim()) ? data.c1 : DEFAULT_PERSONA,
      c2: (typeof data.c2 === 'string' && data.c2.trim()) ? data.c2 : DEFAULT_PERSONA,
    };
  } catch {
    // personas.json 不存在或損毀，兩個角色都退回通用預設人設，不要讓對話功能因此打不開。
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
  try {
    if (!(await isL2dReady())) {
      return { ok: false, error: 'L2D 尚未就緒（角色可能還在載入中），請稍後再試' };
    }
    const apiKey = settingsStore.getApiKey();
    if (!apiKey) {
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
        const pageText = await fetchPageText({ url: urlMatch[0] });
        const instruction = messageWithoutUrl
          ? '供回答參考'
          : '使用者只貼了網址、沒有附加問題，預設請摘要這個網頁的重點內容給使用者';
        context = `\n\n[使用者提到的網頁內容，${instruction}]\n${pageText}`;
      } catch (err) {
        context = `\n\n[使用者提到的網址讀取失敗，請告知使用者無法讀取這個網頁：${err.message}]`;
      }
    }

    const systemPrompt = readPersonas()[charKey];
    const history = chatMemoryStore.getHistory(charKey);

    let reply;
    try {
      const result = await sendChatMessage({ message: message + context, systemPrompt, history, apiKey });
      reply = result.reply;
    } catch (err) {
      return { ok: false, error: `聊天失敗（${err.code || 'UNKNOWN_ERROR'}）：${err.message}` };
    }

    // 記憶只存原始使用者訊息（不含抓來的網頁內容），避免記憶檔案被網頁全文塞爆。
    chatMemoryStore.appendTurn(charKey, message, reply);
    await speakAndShow(charKey, reply);
    return { ok: true };
  } finally {
    chatInFlight.delete(charKey);
  }
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
  } catch (err) {
    return { ok: false, error: '收到的錄音資料格式不對' };
  }
  try {
    const { text } = await transcribeAudio({ audioBuffer, mimeType, apiKey });
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: `語音轉錄失敗（${err.code || 'UNKNOWN_ERROR'}）：${err.message}` };
  }
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
  } catch {
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
    },
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
  win.webContents.on('did-finish-load', syncMyLikeSelectionFromRenderer);

  // F9：切換「點擊穿透」。單一按鍵，比組合鍵好按。若跟其他軟體快捷鍵衝突導致註冊失敗，
  // 系統匣圖示（右下角、右鍵選單）是保證能用的備援切換方式。
  const ok = globalShortcut.register('F9', () => setClickThrough(!clickThrough));
  if (!ok) console.warn('[desktop-pet] F9 全域快捷鍵註冊失敗（可能跟其他程式衝突），請改用系統匣圖示右鍵選單切換');

  const okQ = globalShortcut.register('F10', () => app.quit());
  if (!okQ) console.warn('[desktop-pet] F10 全域快捷鍵註冊失敗，請改用系統匣圖示右鍵選單結束');

  const okReset = globalShortcut.register('F8', resetPosition);
  if (!okReset) console.warn('[desktop-pet] F8 全域快捷鍵註冊失敗，請改用系統匣圖示右鍵選單還原');

  // 數字鍵盤 1~9：依序觸發 scenes.json 裡的情境，順序跟系統匣「情境演出」子選單
  // （buildSceneSubmenu()）完全一致——都是 Object.keys(readScenes())，同一份資料來源，
  // 不會兩邊對不上。每次按下才即時呼叫 readScenes()，不是註冊當下就把情境名稱寫死，
  // 所以「情境編輯器」新增/刪除/調整過情境之後，數字鍵對應的內容會自動跟著換，
  // 不用重開桌寵、也不用重新註冊快捷鍵。
  // 用實體數字鍵盤（num1~num9，Electron accelerator 語法）而不是主鍵盤數字列，
  // 符合需求指定的「數字鍵盤」，也避免跟其他視窗（例如角色命名輸入框）打字時的
  // 一般數字鍵衝突。
  for (let n = 1; n <= 9; n++) {
    const okScene = globalShortcut.register(`num${n}`, () => {
      const keys = Object.keys(readScenes());
      const key = keys[n - 1];
      if (!key) {
        console.log(`[desktop-pet] 數字鍵盤 ${n} 沒有對應的情境（目前只有 ${keys.length} 個）`);
        return;
      }
      triggerMotion(`window.ScenePlayer.trigger(${JSON.stringify(key)})`);
    });
    if (!okScene) console.warn(`[desktop-pet] 數字鍵盤 ${n}（num${n}）全域快捷鍵註冊失敗，可能跟其他程式衝突，請改用系統匣圖示右鍵選單觸發情境`);
  }
}

app.whenReady().then(() => {
  loadMyLikeManifest();
  createWindow();
  createTray();
  console.log('[desktop-pet] 啟動完成 — F8 還原預設位置/縮放，F9 切換互動/穿透模式，F10 結束，數字鍵盤 1-9 依序觸發情境');
  setClickThrough(clickThrough);
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());
