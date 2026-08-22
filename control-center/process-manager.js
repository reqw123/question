'use strict';
// 桌寵模式（desktop-pet）／App 模式（host-app）／網頁模式（multi/，透過 caddy.exe 或
// launchers/serve-lan.js）的行程啟動/關閉——這是 launchers/*.bat 現有做法（雙擊、視窗
// 開著、手動叉掉視窗結束）的程式化版本，不是取代它們：不管這個 control-center 開不開，
// 三個 .bat 一樣可以正常雙擊使用，這裡只是額外多一個能從 GUI 按鈕控制的入口。
//
// 每個模式同一時間只允許這個 control-center 自己追蹤到一個正在跑的行程（Map 存
// modeId -> child）——如果使用者是自己另外用 .bat 開的，這裡完全不知道、也不會嘗試
// 去接管或重複啟動，「啟動」按鈕還是會真的再開一個新的（跟使用者自己雙擊兩次 .bat
// 結果一樣），這裡不做「偵測到 port 已經有人在聽就拒絕啟動」這種額外機制。

const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

// REPO_ROOT 的算法（開發模式 vs 打包成 portable .exe 之後的差異）見 repo-root.js 開頭註解。
const { REPO_ROOT } = require('./repo-root.js');
const DESKTOP_PET_DIR = path.join(REPO_ROOT, 'desktop-pet');
const DESKTOP_PET_WEB_DIR = path.join(REPO_ROOT, 'desktop-pet-web');
const HOST_APP_DIR = path.join(REPO_ROOT, 'host-app');
const CADDY_EXE = path.join(REPO_ROOT, 'caddy.exe');
const SERVE_LAN_JS = path.join(REPO_ROOT, 'launchers', 'serve-lan.js');

const MODES = {
  'desktop-pet': { label: '桌寵模式（desktop-pet）' },
  'desktop-pet-web': { label: '桌寵介紹網頁（desktop-pet-web）' },
  'host-app': { label: 'App 模式（host-app）' },
  web: { label: '網頁模式（multi/，8080 埠）' },
};

// modeId -> { child, pid, startedAt, label }
const running = new Map();

// 原本直接指到 node_modules/.bin/electron.cmd，實測炸了：spawn() 沒開 shell:true 時，
// Windows 沒辦法直接執行 .cmd（那是給命令列直譯器讀的批次檔，不是原生可執行檔），
// child_process.spawn() 對它一律回傳 EINVAL。開 shell:true 可以繞過，但那樣 spawn()
// 回傳的 PID 會變成 cmd.exe 這層外殼的 PID，不是真正的 electron.exe——跟 stop() 用
// taskkill /pid 的邏輯對不上（砍掉外殼行程，裡面真正的 electron 可能變成孤兒，沒被
// 一起砍掉）。改成直接讀 electron npm 套件自己寫好的 path.txt（內容就是執行檔檔名，
// 例如 "electron.exe"）+ dist/ 資料夾，組出真正 .exe 的完整路徑，繞過 .cmd 這層包裝，
// spawn() 拿到的 PID 就是真正的 electron.exe 主行程。
function electronBinFor(projectDir) {
  const pathTxtFile = path.join(projectDir, 'node_modules', 'electron', 'path.txt');
  const exeName = fs.readFileSync(pathTxtFile, 'utf8').trim();
  return path.join(projectDir, 'node_modules', 'electron', 'dist', exeName);
}

function spawnAndTrack(modeId, command, args, options, onLog) {
  if (running.has(modeId)) {
    return { ok: false, error: `${MODES[modeId].label} 已經在跑（PID ${running.get(modeId).pid}），請先停止再重新啟動` };
  }
  let child;
  try {
    child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return { ok: false, error: `啟動失敗：${err.message}` };
  }
  if (!child.pid) {
    return { ok: false, error: '啟動失敗：沒有取得行程 PID（執行檔可能不存在，先確認對應資料夾有沒有跑過 npm install）' };
  }
  const entry = { child, pid: child.pid, startedAt: Date.now(), label: MODES[modeId].label };
  running.set(modeId, entry);
  const forward = (streamName) => (chunk) => {
    if (onLog) onLog(modeId, chunk.toString('utf8'), streamName);
  };
  child.stdout.on('data', forward('stdout'));
  child.stderr.on('data', forward('stderr'));
  child.on('exit', (code, signal) => {
    running.delete(modeId);
    if (onLog) onLog(modeId, `— 行程已結束（exit code ${code}, signal ${signal}） —\n`, 'meta');
  });
  child.on('error', (err) => {
    if (onLog) onLog(modeId, `— 行程錯誤：${err.message} —\n`, 'meta');
  });
  return { ok: true, pid: child.pid };
}

// electronBinFor() 讀 path.txt 失敗（對應資料夾根本沒 npm install 過）會丟同步例外——
// 這裡接住，回傳一般的 { ok:false, error }，不要讓例外一路往上炸穿 ipcMain.handle，
// 變成 renderer 端 await 到一個 reject 而不是預期的失敗結果物件。
function startDesktopPet(onLog) {
  let electronBin;
  try {
    electronBin = electronBinFor(DESKTOP_PET_DIR);
  } catch (err) {
    return { ok: false, error: `找不到 desktop-pet 的 electron 執行檔（${err.message}）——請先在 desktop-pet 資料夾執行 npm install` };
  }
  return spawnAndTrack('desktop-pet', electronBin, ['.'], { cwd: DESKTOP_PET_DIR }, onLog);
}

// desktop-pet-web（跟 desktop-pet/ 是不同專案，見該資料夾 README.md：獨立的 React+Vite
// 介紹網頁）—— 頁面裡的「本機控制面板」是靠輪詢 desktop-pet/control-server.js
// （127.0.0.1:47821）遙控正在跑的桌寵，所以雖然是技術上獨立的行程，使用情境上跟
// 桌寵模式綁在一起：desktop-pet 沒有跑，這個網頁一樣開得起來，只是控制面板按了沒反應。
// `npm run dev` 背後其實是純 JS 的 `node_modules/vite/bin/vite.js`（不是原生執行檔），
// 直接用 node 執行這個檔案，同樣繞過 node_modules/.bin/vite.cmd 那層批次檔包裝，避免
// 跟 electron.cmd 同一種 spawn EINVAL。
function startDesktopPetWeb(onLog) {
  const viteBin = path.join(DESKTOP_PET_WEB_DIR, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!fs.existsSync(viteBin)) {
    return { ok: false, error: '找不到 desktop-pet-web 的 vite 執行檔——請先在 desktop-pet-web 資料夾執行 npm install' };
  }
  const result = spawnAndTrack('desktop-pet-web', process.execPath, [viteBin], { cwd: DESKTOP_PET_WEB_DIR }, onLog);
  if (result.ok && onLog) {
    onLog('desktop-pet-web', '— Vite dev server 預設開在 http://localhost:5173/（實際網址以下面輸出為準，port 被占用時 Vite 會自動換一個） —\n', 'meta');
  }
  return result;
}

// 用一次性 TCP 連線判斷這個 port 現在有沒有人在聽——跟 launchers/啟動-主持人App.bat
// 用 PowerShell Test-NetConnection 做的事等價，只是換成 Node 內建的 net 模組，不用另外
// 開一個 PowerShell 子行程。連得上代表有人在聽（不管是 VS Code Live Server 還是別的
// 方式），連不上（ECONNREFUSED）或逾時都當作沒有人在聽。
function isPortListening(port, host = '127.0.0.1', timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

// host-app（見 host-app/main.js 的 HOST_URL）固定載入 http://127.0.0.1:5500/multi/host.html，
// 這個 port 本身不是 host-app 自己起的——它假設「已經有東西在服務 multi/host.html」，
// 原本的使用習慣是使用者自己先在 VS Code 對 multi/host.html 按「Go Live」。
// launchers/啟動-主持人App.bat 補過一次這個缺口：偵測不到 5500 就自動改用內建的
// launchers/serve-lan.js 頂上（見該 .bat 檔案），這裡是同一套邏輯的程式化版本——沒補
// 這段的話，「App 模式」按下去 host-app 視窗會是空白的（讀不到內容，不是 host-app
// 本身壞了，是它要讀的網址根本沒人在服務）。
// hostAppFallbackServerPid：這個 control-center 自己起的 5500 備援伺服器（如果有的話）
// 的 PID，跟 host-app 的生命週期綁在一起——stop('host-app') 時如果這個備援伺服器是
// 我們自己起的，一併停掉，不留下一個沒有入口能再管理的孤兒行程；如果 5500 是使用者自己
// 開的 VS Code Live Server（我們沒有啟動任何東西），這裡維持 null，停止 host-app 時
// 完全不會去動使用者自己開的 Live Server。
let hostAppFallbackServerPid = null;

async function startHostApp(onLog) {
  let electronBin;
  try {
    electronBin = electronBinFor(HOST_APP_DIR);
  } catch (err) {
    return { ok: false, error: `找不到 host-app 的 electron 執行檔（${err.message}）——請先在 host-app 資料夾執行 npm install` };
  }

  const already = await isPortListening(5500);
  if (already) {
    if (onLog) onLog('host-app', '— 偵測到 5500 埠已經有東西在服務（VS Code Live Server 或其他方式），直接沿用 —\n', 'meta');
  } else {
    if (onLog) onLog('host-app', '— 偵測不到 5500 埠，改用內建 Node 靜態伺服器頂上（跟 launchers/啟動-主持人App.bat 同一套邏輯） —\n', 'meta');
    let fallback;
    try {
      fallback = spawn(process.execPath, [SERVE_LAN_JS], {
        cwd: REPO_ROOT, env: { ...process.env, PORT: '5500' }, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      return { ok: false, error: `啟動 5500 備援伺服器失敗：${err.message}` };
    }
    if (!fallback.pid) {
      return { ok: false, error: '啟動 5500 備援伺服器失敗：沒有取得行程 PID' };
    }
    hostAppFallbackServerPid = fallback.pid;
    fallback.stdout.on('data', (chunk) => { if (onLog) onLog('host-app', chunk.toString('utf8'), 'stdout'); });
    fallback.stderr.on('data', (chunk) => { if (onLog) onLog('host-app', chunk.toString('utf8'), 'stderr'); });
    fallback.on('exit', () => { hostAppFallbackServerPid = null; });
    // 給備援伺服器一點時間把 port 綁起來，跟 .bat 那句 `ping -n 3 127.0.0.1` 的用意
    // 一樣（純粹是等待，不是真的要 ping 什麼）；輪詢確認真的連得上了才繼續開 host-app，
    // 比固定等一個數字更可靠，不會遇到啟動比預期慢時還是撲空。
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await isPortListening(5500)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  return spawnAndTrack('host-app', electronBin, ['.'], { cwd: HOST_APP_DIR }, onLog);
}

// 跟 launchers/啟動-網頁遊戲.bat 完全同一套判斷邏輯：有 caddy.exe 就用它（支援之後接
// ngrok 開放外網），沒有就退回內建的 launchers/serve-lan.js（純區網，零套件相依）。
function startWeb(onLog) {
  const useCaddy = fs.existsSync(CADDY_EXE);
  const result = useCaddy
    ? spawnAndTrack('web', CADDY_EXE, ['run'], { cwd: REPO_ROOT }, onLog)
    : spawnAndTrack('web', process.execPath, [SERVE_LAN_JS], { cwd: REPO_ROOT, env: { ...process.env, PORT: '8080' } }, onLog);
  if (result.ok && onLog) {
    onLog('web', `— 使用${useCaddy ? ' caddy.exe（公網/ngrok-capable）' : ' 內建 Node 靜態伺服器（純區網，見 launchers/README.md）'} —\n`, 'meta');
  }
  return result;
}

const STARTERS = {
  'desktop-pet': startDesktopPet, 'desktop-pet-web': startDesktopPetWeb,
  'host-app': startHostApp, web: startWeb,
};

function start(modeId, onLog) {
  const starter = STARTERS[modeId];
  if (!starter) return { ok: false, error: `不明的模式：${modeId}` };
  return starter(onLog);
}

// 兩段式停止：先送一般的 taskkill（不加 /f）——對有主視窗的 GUI 程式（Electron）這樣會
// 送出接近使用者按右上角 X 的關閉請求，讓它有機會走正常的 quit 流程；等一小段時間還沒
// 死透，才用 /t /f 強制連同整個行程樹一起砍掉（Electron 在 Windows 上是一個行程樹——
// 主行程 + GPU/renderer 等子行程，只砍主行程 PID 不夠，子行程會變成孤兒繼續佔用資源）。
// desktop-pet／host-app 目前都沒有為了「被外部程式控制」另外加任何 SIGINT/SIGBREAK
// handler（純粹雙擊 .bat、使用者自己叉視窗的既有使用模式），這裡也沒有要求它們加，
// 純粹用 Windows 內建的 taskkill 從外部管理，不改這兩個專案原本的程式碼一行。
// 停掉「App 模式」自己啟動的 5500 備援伺服器（如果有的話）——跟 host-app 本體的
// 生命週期綁在一起，見 startHostApp() 裡 hostAppFallbackServerPid 的說明。這個備援
// 伺服器是純 Node console 行程，沒有 GUI 主視窗，實測過溫和 taskkill（不加 /f）對這種
// 行程常常沒用（跟 web 模式那次實測結果一致），直接用 /f，不用先嘗試溫和關閉再等 3 秒。
function stopHostAppFallbackServer() {
  if (!hostAppFallbackServerPid) return;
  const pid = hostAppFallbackServerPid;
  hostAppFallbackServerPid = null;
  exec(`taskkill /pid ${pid} /f`, () => {});
}

function stop(modeId) {
  const entry = running.get(modeId);
  if (!entry) return Promise.resolve({ ok: false, error: `${MODES[modeId] ? MODES[modeId].label : modeId} 目前沒有在跑` });
  const { pid } = entry;
  return new Promise((resolve) => {
    exec(`taskkill /pid ${pid}`, () => {
      const deadline = Date.now() + 3000;
      const poll = () => {
        if (!running.has(modeId)) {
          if (modeId === 'host-app') stopHostAppFallbackServer();
          resolve({ ok: true });
          return;
        }
        if (Date.now() > deadline) {
          exec(`taskkill /pid ${pid} /t /f`, () => {
            setTimeout(() => {
              if (modeId === 'host-app') stopHostAppFallbackServer();
              resolve({ ok: !running.has(modeId), forced: true });
            }, 500);
          });
          return;
        }
        setTimeout(poll, 300);
      };
      poll();
    });
  });
}

function getStatus() {
  const status = {};
  for (const modeId of Object.keys(MODES)) {
    const entry = running.get(modeId);
    status[modeId] = entry
      ? { running: true, pid: entry.pid, startedAt: entry.startedAt, label: entry.label }
      : { running: false, label: MODES[modeId].label };
  }
  return status;
}

// 供 main.js 在整個 control-center app 要關閉時清理——避免使用者關掉 control-center
// 視窗後，桌寵/host-app/web 伺服器變成沒人管、也沒地方能再停止的孤兒行程。只處理
// 「這個 control-center 自己啟動」的那些，不會影響使用者另外用 .bat 開的行程（那些
// 這裡從一開始就不知道也管不到）。
async function stopAll() {
  const modeIds = [...running.keys()];
  await Promise.all(modeIds.map((modeId) => stop(modeId)));
}

module.exports = { MODES, start, stop, stopAll, getStatus };
