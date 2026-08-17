'use strict';

// desktop-pet「CLI 模式」——透過 Claude Agent SDK（@anthropic-ai/claude-agent-sdk）讓桌寵對話
// 觸發本機 Claude Code 執行任務。見 docs/specs/0006-desktop-pet-claude-cli-mode.md、
// docs/adr/0008-desktop-pet-claude-cli-mode-local-execution.md。
//
// 瀏覽器操控（Playwright MCP）見 docs/specs/0011-desktop-pet-cli-browser-automation.md、
// docs/adr/0012-desktop-pet-cli-browser-automation.md。
//
// 核心設計：SDK 的 canUseTool 是一個 async callback，SDK 會等它 resolve 才繼續往下執行/
// 生成下一則訊息——這個特性讓我們可以把「有風險的操作」暫停下來，等桌寵這邊的使用者用
// 聊天回覆同意/拒絕，再把結果餵回去，不用自己重新發明一套暫停/恢復機制。整個任務（可能
// 橫跨好幾輪確認）活在同一個 ClaudeCliSession 物件裡，直到任務做完或發生錯誤。
//
// 只有 Read/Glob/Grep 這幾個唯讀工具自動放行，其餘（Bash、Write、Edit、WebFetch...）
// 一律經過 canUseTool 問過使用者才執行——見 spec 的使用者決定（「每次風險操作都回報確認」）。

let sdkQuery = null;
function loadSdkQuery() {
  if (!sdkQuery) {
    // 延遲 require：這個套件只有真的進入 CLI 模式才需要，也讓測試完全不需要真的載入這個
    // 套件——測試一律注入 queryImpl mock（跟 chat.js/tts.js/stt.js/ollama.js 的
    // fetchImpl 是同一種測試 seam 手法）。
    ({ query: sdkQuery } = require('@anthropic-ai/claude-agent-sdk'));
  }
  return sdkQuery;
}

const SAFE_TOOLS = ['Read', 'Glob', 'Grep'];

// Playwright MCP（@playwright/mcp）的伺服器名稱固定叫 "playwright"，SDK 會把它底下的工具
// 取名成 mcp__playwright__<動作>（例如 mcp__playwright__browser_navigate）。見 ADR-0012：
// 使用者選擇要操控自己平常在用的系統 Chrome、沿用既有登入狀態，而不是 Playwright 另外
// 開一個乾淨的獨立瀏覽器。
//
// 一開始用的是 --browser chrome --user-data-dir <使用者的 Chrome 個人資料夾>，讓
// Playwright 自己啟動一個指向同一個 profile 的新 Chrome 行程——但實測發現使用者平常
// 就開著 Chrome 時，這個新行程會撞上 Chrome 的 profile 鎖定：跳出一個新視窗、卡在
// about:blank 不會真的收到導覽指令（Chromium 的 single-instance 機制把新行程的請求
// 轉交給既有行程，Playwright 的 CDP 連線卻還連著那個新開、實際上沒被 Chromium 接手
// 的視窗）。改用 --extension：透過 Chrome 的「Playwright Extension」擴充套件連到
// 使用者「本來就開著」的那個 Chrome，完全不另外啟動瀏覽器行程/不用另外指定
// --user-data-dir，因此不會有 profile 鎖定衝突。代價是使用者要先手動從 Chrome 線上
// 應用程式商店安裝這個擴充套件一次（無法用程式自動安裝瀏覽器擴充套件），且第一次
// 連線時 Chrome 那邊會跳出一個分頁選擇畫面，讓使用者選要把哪個分頁交給 Claude 操控。
//
// 指定的是 "@playwright/mcp"，不帶版本／@latest：npx 遇到明確指定版本或 tag（例如
// @latest）一定會先連 npm registry 查一次「latest 現在是哪一版」才決定要不要用，就算
// package.json 已經裝了對應版本也一樣要查——等於每一次 CLI 模式任務（mcpServers 是
// 每個 _runLoop() 都重新組一次，不只牽涉瀏覽器的任務也一樣會 spawn 這個 server）都多一
// 個網路依賴，離線時還可能拖慢/搞壞完全不需要瀏覽器工具的任務。不帶版本讓 npx 優先用
// package.json 已經裝好的本地版本，不用每次都連網路確認。
//
// PLAYWRIGHT_MCP_EXTENSION_TOKEN：--extension 模式第一次連線時，Chrome 那邊的擴充套件會
// 跳出一個授權對話框（「要不要把整個瀏覽器交給這個自動化工具控制」），並顯示一組隨機
// token。由於 mcpServers 是每個 _runLoop()（CLI 模式的每一句新指令）都重新組一次、重新
// spawn 一次 @playwright/mcp 行程，預設情況下每次 spawn 都會拿到一組新的隨機 token，
// 使用者會發現這個授權對話框每次用到瀏覽器工具都跳出來一次，不會只跳一次。如果使用者
// 自己把某次拿到的 token 設成這個環境變數（並且瀏覽器那邊已經對這個 token 按過一次
// 「Allow」），之後每次 spawn 都帶著同一個已授權過的 token，就不會再跳對話框——這是
// @playwright/mcp 官方支援的做法，不是繞過安全機制：使用者還是要親自看過警告、按過一次
// 「Allow & select」，只是把「這個 token 已經授權過」的狀態從單次 spawn 延續到之後每次。
// 沒有設這個環境變數時完全不影響行為（子行程照常繼承目前的環境變數，只是 token 是新產生
// 的，會需要重新授權）。用 { ...process.env, ... } 而不是只塞這一個 key，是因為 npx 這個
// 子行程需要 PATH 之類的基本環境變數才能找到 node/npm，不能讓這個設定意外把整個環境變數
// 表清空、導致 npx 直接啟動失敗。
//
// timeout：SDK 對 MCP 工具呼叫本身有逾時機制（MCP_TOOL_TIMEOUT／McpStdioServerConfig.timeout），
// 但沒設的話用的是 SDK 內建預設值——原始碼是編譯過的，我們查不到確切數字，等於卡多久是
// 一個黑盒。實測發現如果使用者沒有及時處理 Chrome 那邊跳出的「Allow & select」授權對話框
// （或分頁選擇畫面卡住沒反應），desktop-pet 這邊只會停在「思考中」，沒有任何提示使用者
// Chrome 那邊有東西在等他，使用者不知道要等多久、也不確定是不是真的卡死了。明確設一個
// 120 秒（比 Playwright 自己導覽逾時的預設 60 秒更寬鬆一點，避免比 Playwright 自己的逾時
// 還早觸發），讓最壞情況變成一個已知、會自動結束、附帶清楚錯誤訊息的等待，而不是不知道
// 要等多久的未知數。這不能完全解決「授權對話框沒人理」的體驗問題（使用者還是得自己發現
// Chrome 跳出視窗），但至少卡住有個底線，逾時後 `_runLoop` 的既有 catch 會把它轉成明確的
// error 訊息，不會讓桌寵永遠停在思考中。
function buildPlaywrightMcpServer() {
  const config = {
    type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp', '--extension'], timeout: 120000,
  };
  if (process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN) {
    config.env = { ...process.env, PLAYWRIGHT_MCP_EXTENSION_TOKEN: process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN };
  }
  return config;
}

// 不給 systemPrompt 的話，SDK 不會自動套用 Claude Code 那套「你是可以放心用 Bash 完成
// 本機任務的代理」身分框架，模型會退回比較保守的通用判斷——實測過「幫我打開小算盤」
// 這種請求，同一句話有時會被直接回絕（回「這超出我能力範圍，我只能操作程式碼/檔案/
// 終端機」），完全不嘗試呼叫任何工具、canUseTool 根本不會被觸發，跟明講「請用終端機
// 打開小算盤」時穩定會呼叫 Bash 是兩種結果。用 claude_code 預設身分 + append 這句提示，
// 讓「幫我打開...」這類請求穩定被判斷成「可以透過指令做到」，不會忽冷忽熱。
//
// 桌面路徑那句是另一次實測踩到的坑：這台機器開了 OneDrive「備份你的資料夾」，真正的
// 桌面被重新導向到 %USERPROFILE%\OneDrive\Desktop，不是一般預設的 %USERPROFILE%\Desktop。
// 曾經實測過「幫我從桌面打開 XXX」，模型一路查 Get-StartApps／%USERPROFILE%\Desktop／
// Start Menu Programs／Program Files／LocalAppData／AppX 套件，每一個都查了但唯獨沒查對
// 桌面真正的路徑，來回問了使用者四次同意都還沒找到，其實東西就躺在桌面上，只是查錯資料夾。
const CLI_MODE_SYSTEM_PROMPT_APPEND =
  '使用者是透過桌寵聊天視窗下指令，沒有另外開終端機視窗可以自己操作。如果使用者的訊息是' +
  '「幫我打開／執行／啟動 XXX」這類要啟動本機應用程式的請求，預設當作可以透過 Bash/' +
  'PowerShell 下指令完成（例如 Start-Process），不要因為對象是 GUI 應用程式就拒絕、也' +
  '不要只回覆使用者自己手動操作的步驟；真的不確定使用者想開哪一個程式時才用一般方式' +
  '詢問澄清，不要用「這超出我的能力範圍」這種說法擋掉。如果使用者提到「桌面」，這台機器' +
  '的桌面已被 OneDrive 重新導向，請用 PowerShell 的 ' +
  '[Environment]::GetFolderPath(\'Desktop\') 取得真正的桌面路徑，不要假設是' +
  '%USERPROFILE%\\Desktop，避免因為查錯資料夾而誤判成「桌面上沒有這個東西」。' +
  '你有 mcp__playwright__ 開頭的瀏覽器操控工具（開網頁、點擊、輸入、讀取頁面內容...），' +
  '操作的是使用者平常在用、已經登入的系統 Chrome。使用者要求搜尋資料、瀏覽/操作某個' +
  '網站時，預設當作可以透過這些工具直接完成，不要回覆「我沒有能力操控瀏覽器」這種說法' +
  '擋掉、也不要只給使用者自己手動操作的步驟；因為操作的是使用者真實登入的瀏覽器，涉及' +
  '登入帳號、付款、刪除/送出這類會改變使用者帳號狀態的操作要格外謹慎描述清楚在做什麼' +
  '（每一步仍會照常經過同意流程，不會因為這句提示而跳過確認）。';

// 把 canUseTool 收到的 toolName/input 轉成一句人看得懂的確認文字。優先用 SDK 自己組好的
// title（例如「Claude wants to read foo.txt」，比自己拼字串準確），沒有的話才自己組一個
// 粗略版本，至少常見的 Bash/Write/Edit 給出看得懂的重點而不是整包 JSON。
function describeToolUse(toolName, input, opts) {
  if (opts && opts.title) return opts.title;
  if (toolName === 'Bash' && input && input.command) return `執行指令：${input.command}`;
  if ((toolName === 'Write' || toolName === 'Edit') && input && input.file_path) {
    return `修改檔案：${input.file_path}`;
  }
  if (toolName === 'mcp__playwright__browser_navigate' && input && input.url) {
    return `開啟網頁：${input.url}`;
  }
  if (toolName === 'mcp__playwright__browser_click' && input) {
    return `點擊網頁元素：${input.element || input.ref || ''}`;
  }
  if (toolName === 'mcp__playwright__browser_type' && input) {
    return `在網頁輸入文字：${input.text || ''}${input.element ? `（欄位：${input.element}）` : ''}`;
  }
  if (toolName === 'mcp__playwright__browser_evaluate' && input) {
    return `在網頁裡執行 JavaScript：${String(input.function || '').slice(0, 200)}`;
  }
  // browser_run_code_unsafe 跟 browser_evaluate 不是同一個風險等級：官方文件明講這個工具是
  // 「executes arbitrary JavaScript in the Playwright server process and is RCE-equivalent」
  // ——不是跑在網頁的 JS 沙盒裡，是跑在 MCP server 的 Node.js 行程裡，風險等同（甚至高於）
  // Bash。確認文字必須明講「本機」「風險等同 Bash」，不能跟 browser_evaluate 共用一句聽起來
  // 人畜無害的「在瀏覽器裡執行程式碼」，不然使用者很可能因為以為只是網頁裡的小動作就同意。
  if (toolName === 'mcp__playwright__browser_run_code_unsafe' && input) {
    return `⚠️ 在本機執行任意程式碼（風險等同 Bash）：${String(input.code || input.filename || '').slice(0, 200)}`;
  }
  try {
    return `${toolName}（${JSON.stringify(input).slice(0, 200)}）`;
  } catch {
    return toolName;
  }
}

// TTS 要念的版本——Bash 指令的 describeToolUse() 結果常常整串是原始 shell 語法（旗標、
// 管線、路徑符號），逐字念出來很難聽懂，改念一句通用提示；完整指令內容還是照常放在文字
// 泡泡裡（呼叫端傳 text 用 describeToolUse()，spokenText 才用這個函式），使用者同意/拒絕
// 前一樣能在畫面上看到自己在同意什麼，只是不用被 TTS 逐字唸過一次。其餘工具類型
// （Write/Edit 的短句、SDK 給的 opts.title）本來就是人看得懂的話，念出來沒問題，維持
// 跟顯示文字一致。
function spokenToolUseSummary(toolName, description) {
  if (toolName === 'Bash') return '執行一個系統指令';
  // 跟 Bash 同樣的理由：input 是原始程式碼，逐字念出來使用者聽不懂也不想聽，文字泡泡
  // （text）仍然完整顯示，只有 TTS 換成通用一句——但 browser_run_code_unsafe 風險等同
  // Bash（見 describeToolUse 的說明），念的內容也要跟 Bash 一樣明確，不能跟風險小很多的
  // browser_evaluate 共用同一句聽起來很輕鬆的話。
  if (toolName === 'mcp__playwright__browser_evaluate') {
    return '在網頁裡執行一段 JavaScript';
  }
  if (toolName === 'mcp__playwright__browser_run_code_unsafe') {
    return '在本機執行一段任意程式碼，風險等同執行系統指令';
  }
  return description;
}

class ClaudeCliSession {
  // freePermissionMode：見 docs/adr/0010-desktop-pet-cli-free-permission-mode.md。開啟後
  // canUseTool 不再暫停等使用者回覆同意/拒絕，風險操作直接放行，但仍透過 onNarration
  // 即時告知使用者做了什麼（不是完全靜默），保留事後可稽核的實況描述。這個旗標在
  // session 建立時決定一次，中途改設定不會影響同一個進行中的 session（要重新進入 CLI
  // 模式才會套用新值），跟其餘設定「讀取當下值」的慣例一致，但避免任務跑到一半行為突變。
  constructor({ cwd, queryImpl, freePermissionMode, onNarration, onToolUse } = {}) {
    this.cwd = cwd;
    this.queryImpl = queryImpl || ((...args) => loadSdkQuery()(...args));
    this.pendingResolve = null; // 有待確認的操作時，存 (allow: boolean) => void
    this.pendingDescription = null;
    this.busy = false; // 目前這個 session 有沒有任務正在跑（含暫停等確認）
    this.sessionId = null; // 上一輪任務結束時的 session id，讓下一輪任務延續同一個對話
    this._settle = null;
    this.freePermissionMode = !!freePermissionMode;
    this.onNarration = typeof onNarration === 'function' ? onNarration : () => {};
    // onToolUse(toolName)：每次 canUseTool 被呼叫（不管最後是唯讀自動放行、免確認自動放行、
    // 還是要暫停問使用者）都會先呼叫一次，純粹是「有這個工具要跑了」的通知，不影響
    // allow/deny 的判斷結果。this 這層完全不知道呼叫端會拿這個通知做什麼——目前的用途是
    // main.js 用它偵測「瀏覽器工具要執行了」，暫時把桌寵視窗的置頂等級降下來，讓 Playwright
    // 開的 Chrome 分頁不會被蓋住（見 docs/adr/0012、main.js 的 setBrowserToolActive()）；
    // 但這裡刻意不寫死跟瀏覽器/視窗相關的邏輯，保持這個模組跟 Electron 無關，維持既有的
    // 「claude-cli.js 可以完全不裝 SDK、不碰 Electron 就測」的設計。
    this.onToolUse = typeof onToolUse === 'function' ? onToolUse : () => {};
    this._abortController = null; // 目前這個任務用的 AbortController，只有真的在跑（含暫停等確認）時才存在
    this._cancelled = false; // abort() 呼叫過——讓 _runLoop 不管 SDK 最後是丟例外、正常收尾還是什麼都沒送，都能一致回報「已取消」而不是「錯誤」或「沒有結果」
  }

  get hasPendingConfirmation() {
    return !!this.pendingResolve;
  }

  // 使用者打錯字/講錯話，想收回目前這個 CLI 任務時用（Esc，見 main.js 的 chat-cancel
  // handler、index.html 的 Esc 判斷邏輯——跟一般聊天「思考中」按 Esc 收回是同一份使用者
  // 體感，這裡是 CLI 模式版本）。跟 resolveConfirmation(false)（拒絕單一操作，任務
  // 繼續跑、Claude 可能改用其他做法）不一樣：abort 是把整個任務直接結束掉。
  abort() {
    if (!this.busy) return false;
    this._cancelled = true;
    if (this.pendingResolve) {
      // 卡在等使用者同意/拒絕：這個 Promise 是我們自己 new 出來的（見 _runLoop 裡
      // canUseTool 的說明），不會因為底下 abortController.abort() 自動解開，要手動
      // resolve 才能讓 _runLoop 繼續往下走、走到下一次跟 SDK 互動時才會真的被
      // abortController 擋下來。resolve 的值本身不重要（_cancelled 已經是 true，
      // _runLoop 結束時一律回報「已取消」，不會被誤讀成「這個操作被拒絕、任務繼續」）。
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      this.pendingDescription = null;
      resolve(false);
    }
    if (this._abortController) this._abortController.abort();
    return true;
  }

  _armWaiter() {
    let resolveWaiter;
    const promise = new Promise((resolve) => { resolveWaiter = resolve; });
    let settled = false;
    // this._settle 是目前這一步「該讓使用者看到結果」的通知管道，start()／
    // resolveConfirmation() 每次呼叫都重新掛一個，_runLoop 裡永遠讀 this._settle
    // （屬性存取，不是閉包捕捉舊值），確保呼叫到的一定是最新那個 waiter。
    this._settle = (result) => {
      if (settled) return;
      settled = true;
      resolveWaiter(result);
    };
    return promise;
  }

  // 開始新任務。回傳值在「下一個該讓使用者看到的時間點」才 resolve——可能是
  // { type: 'confirm', text }（需要使用者同意/拒絕）或 { type: 'result', text }（任務做完了）
  // 或 { type: 'error', text }；不會整個等到任務全部結束才回傳，任務可能要跑很久。
  start(prompt) {
    if (this.busy) {
      return Promise.resolve({ type: 'error', text: '上一個 CLI 任務還在跑，請等它完成或先回覆待確認的操作' });
    }
    this.busy = true;
    const waiterPromise = this._armWaiter();
    this._runLoop(prompt);
    return waiterPromise;
  }

  // 使用者回覆同意/拒絕待確認的操作，恢復執行直到下一個暫停點。
  resolveConfirmation(allow) {
    if (!this.pendingResolve) {
      return Promise.resolve({ type: 'error', text: '目前沒有待確認的操作' });
    }
    const waiterPromise = this._armWaiter();
    const resolve = this.pendingResolve;
    this.pendingResolve = null;
    this.pendingDescription = null;
    resolve(allow);
    return waiterPromise;
  }

  async _runLoop(prompt) {
    const canUseTool = async (toolName, input, opts) => {
      this.onToolUse(toolName);
      if (SAFE_TOOLS.includes(toolName)) {
        return { behavior: 'allow', updatedInput: input };
      }
      const description = describeToolUse(toolName, input, opts);
      const spokenDescription = spokenToolUseSummary(toolName, description);
      if (this.freePermissionMode) {
        // 不暫停、不等 pendingResolve——直接放行，但先把「做了什麼」送給呼叫端顯示，
        // await 是為了讓文字泡泡在動作真的執行前先更新，時序上讀起來比較合理，不是為了
        // 等使用者回覆（onNarration 不會、也不該回傳同意/拒絕）。text/spokenText 分開傳給
        // 呼叫端，讓文字泡泡跟 TTS 可以顯示不同內容（見 spokenToolUseSummary）。
        await this.onNarration(
          `⚡ 免確認模式，已自動執行：${description}`,
          `免確認模式，已自動執行：${spokenDescription}`,
        );
        return { behavior: 'allow', updatedInput: input };
      }
      const allow = await new Promise((resolve) => {
        this.pendingResolve = resolve;
        this.pendingDescription = description;
        this._settle({
          type: 'confirm',
          text: `🔧 Claude 想要：${description}\n同意請回覆「同意」，不同意請回覆「拒絕」。`,
          spokenText: `Claude 想要：${spokenDescription}。同意請回覆同意，不同意請回覆拒絕。`,
        });
      });
      return allow
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: '使用者拒絕了這個操作，請調整做法或告知使用者無法繼續這一步' };
    };

    this._cancelled = false;
    const abortController = new AbortController();
    this._abortController = abortController;
    try {
      const options = {
        cwd: this.cwd,
        permissionMode: 'default',
        allowedTools: SAFE_TOOLS,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: CLI_MODE_SYSTEM_PROMPT_APPEND },
        mcpServers: { playwright: buildPlaywrightMcpServer() },
        abortController,
        canUseTool,
      };
      // 延續上一輪任務的對話（同一個 CLI 模式 session 內，第二次以後才會有 sessionId）。
      if (this.sessionId) options.resume = this.sessionId;

      for await (const message of this.queryImpl({ prompt, options })) {
        if (message.type === 'result') {
          this.busy = false;
          this.sessionId = message.session_id || this.sessionId;
          // abort() 呼叫過就一律回報「已取消」，不管 SDK 這次到底有沒有送出 result
          // 訊息——SDK 是不是把中止當成一種特殊的 result subtype 送回來，這裡不用
          // 猜，_cancelled 這個旗標比解析 SDK 訊息形狀可靠。
          if (this._cancelled) { this._settle({ type: 'cancelled', text: '已取消目前的 CLI 任務。' }); return; }
          const text = message.subtype === 'success'
            ? message.result
            : `任務沒有成功結束（${message.subtype}）`;
          this._settle({ type: 'result', text });
          return;
        }
      }
      // 理論上 SDK 一定會送 result 訊息收尾；真的沒送到也要解除等待狀態，不要讓桌寵卡在
      // 「思考中」回不來——也可能是 abort() 之後 SDK 選擇直接結束 async generator（不丟
      // 例外、不送 result），這裡一併判斷 _cancelled。
      this.busy = false;
      this._settle(
        this._cancelled
          ? { type: 'cancelled', text: '已取消目前的 CLI 任務。' }
          : { type: 'result', text: '（任務結束，但沒有收到明確的結果訊息）' }
      );
    } catch (err) {
      this.busy = false;
      this.pendingResolve = null;
      // abort() 之後 SDK 也可能是用丟例外的方式結束（例如 AbortError）——同樣一律
      // 回報「已取消」，不當成真正的錯誤顯示給使用者。
      //
      // err?.message ?? String(err)：不能直接假設 err 一定是標準 Error 物件。如果 SDK
      // 丟出非 Error 值（例如 reject(null)），存取 .message 會在這個 catch block 裡再丟
      // 一次例外——這次沒有人接，_runLoop() 的 promise 變成 unhandled rejection，_settle()
      // 永遠不會被呼叫，main.js 在等的 waiterPromise 永遠不會 resolve，畫面卡在「思考中」；
      // 更糟的是上面已經把 this.busy 設成 false 了，使用者按 Esc 呼叫 abort() 只會看到
      // 「沒有東西可以取消」（abort() 的 `if (!this.busy) return false`），沒有任何操作
      // 救得回來。用 optional chaining 避免這個目前唯一找到的「連 Esc 都沒用」的卡死路徑。
      this._settle(
        this._cancelled
          ? { type: 'cancelled', text: '已取消目前的 CLI 任務。' }
          : { type: 'error', text: `CLI 任務發生錯誤：${err?.message ?? String(err)}` }
      );
    } finally {
      this._abortController = null;
    }
  }
}

// 使用者「同意」/「拒絕」的判斷——刻意寬鬆比對常見講法，但否定詞（不同意/不可以...）
// 一定要排在肯定詞前面比對，不然「不可以」會因為含有「可以」被誤判成同意。看不懂的話
// 回傳 null，呼叫端要求使用者換句話說，絕不在含糊不清時偷偷當作同意。
const DENY_WORDS = ['不同意', '不允許', '不可以', '不要', '不行', '別做', '別執行', '拒絕', '取消', 'no', 'nope', 'cancel', 'deny', 'reject'];
const ALLOW_WORDS = ['同意', '允許', '可以', '好的', '好', '是的', 'yes', 'ok', 'okay', 'sure', '執行', '確認'];

function interpretYesNo(message) {
  const normalized = (message || '').trim().toLowerCase();
  if (!normalized) return null;
  // 純英文字詞用 \b 詞界比對，不然像 "no" 會誤中 "know" 這種訊息裡剛好含子字串的情況；
  // 中文詞沒有空白分詞，維持子字串比對（中文語境下這樣的誤判機率低很多）。
  const matches = (word) => (/^[a-z]+$/.test(word) ? new RegExp(`\\b${word}\\b`).test(normalized) : normalized.includes(word));
  if (DENY_WORDS.some(matches)) return false;
  if (ALLOW_WORDS.some(matches)) return true;
  return null;
}

module.exports = {
  ClaudeCliSession, interpretYesNo, describeToolUse, spokenToolUseSummary, SAFE_TOOLS,
  buildPlaywrightMcpServer,
};
