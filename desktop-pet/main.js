'use strict';
const { app, BrowserWindow, globalShortcut, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

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

function loadMyLikeManifest() {
  try {
    const dir = path.join(__dirname, '..', 'live2d_my_like');
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
      `({ c1: localStorage.getItem('l2d_mylike_d_char1') || '', c2: localStorage.getItem('l2d_mylike_d_char2') || '' })`
    )
    .then(({ c1, c2 }) => {
      currentChar1 = pendingChar1 = c1;
      currentChar2 = pendingChar2 = c2;
      if (tray) tray.setContextMenu(buildTrayMenu());
    })
    .catch((err) => console.warn('[desktop-pet] 讀取目前角色選擇失敗：', err.message));
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
  win.webContents
    .executeJavaScript(
      `(function() {
        if (window.L2D && typeof L2D.clearPos === 'function') { L2D.clearPos(); return true; }
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

// 動作測試選單：手動觸發 lib/live2d.js 既有的公開動作方法，之後想加新動作
// 只要在這個陣列多加一筆 { label, call }，buildMotionSubmenu()／triggerMotion() 都不用改。
// （對角線交叉飛行是「開始/停止」合一的切換式選項，label 會動態變化，不適合放這種固定 label 的陣列，另外處理，見下方 toggleFly()）
const MOTION_ACTIONS = [
  { label: '角色一隨機動作（playRandom1）', call: 'L2D.playRandom1()' },
  { label: '角色二隨機動作（playRandom2）', call: 'L2D.playRandom2()' },
];

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

function buildTrayMenu() {
  const hasPendingChange = pendingChar1 !== currentChar1 || pendingChar2 !== currentChar2;
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
      ]
    : [];

  return Menu.buildFromTemplate([
    {
      label: clickThrough ? '切換成互動模式（可拖曳角色）' : '切換成穿透模式（滑鼠穿透桌面）',
      click: () => setClickThrough(!clickThrough),
    },
    { label: '還原預設位置/縮放', click: () => resetPosition() },
    { label: '動作測試', submenu: buildMotionSubmenu() },
    ...charMenuItems,
    { type: 'separator' },
    { label: '結束', click: () => app.quit() },
  ]);
}

function createTray() {
  try {
    // tray-icon.png 是預先從 multi/default_avatar.png 裁切/縮放好的正規 32x32 PNG
    // （離線用 PIL 產生，避免在執行期用 nativeImage 處理來源檔而重演之前的崩潰）
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
    },
  });

  win.setIgnoreMouseEvents(clickThrough, { forward: true });
  win.loadFile(path.join(__dirname, 'index.html'));

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
}

app.whenReady().then(() => {
  loadMyLikeManifest();
  createWindow();
  createTray();
  console.log('[desktop-pet] 啟動完成 — F8 還原預設位置/縮放，F9 切換互動/穿透模式，F10 結束');
  setClickThrough(clickThrough);
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());
