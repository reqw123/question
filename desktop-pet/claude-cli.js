'use strict';

// desktop-pet「CLI 模式」——透過 Claude Agent SDK（@anthropic-ai/claude-agent-sdk）讓桌寵對話
// 觸發本機 Claude Code 執行任務。見 docs/specs/0006-desktop-pet-claude-cli-mode.md、
// docs/adr/0008-desktop-pet-claude-cli-mode-local-execution.md。
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

// 把 canUseTool 收到的 toolName/input 轉成一句人看得懂的確認文字。優先用 SDK 自己組好的
// title（例如「Claude wants to read foo.txt」，比自己拼字串準確），沒有的話才自己組一個
// 粗略版本，至少常見的 Bash/Write/Edit 給出看得懂的重點而不是整包 JSON。
function describeToolUse(toolName, input, opts) {
  if (opts && opts.title) return opts.title;
  if (toolName === 'Bash' && input && input.command) return `執行指令：${input.command}`;
  if ((toolName === 'Write' || toolName === 'Edit') && input && input.file_path) {
    return `修改檔案：${input.file_path}`;
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
  return toolName === 'Bash' ? '執行一個系統指令' : description;
}

class ClaudeCliSession {
  // freePermissionMode：見 docs/adr/0010-desktop-pet-cli-free-permission-mode.md。開啟後
  // canUseTool 不再暫停等使用者回覆同意/拒絕，風險操作直接放行，但仍透過 onNarration
  // 即時告知使用者做了什麼（不是完全靜默），保留事後可稽核的實況描述。這個旗標在
  // session 建立時決定一次，中途改設定不會影響同一個進行中的 session（要重新進入 CLI
  // 模式才會套用新值），跟其餘設定「讀取當下值」的慣例一致，但避免任務跑到一半行為突變。
  constructor({ cwd, queryImpl, freePermissionMode, onNarration } = {}) {
    this.cwd = cwd;
    this.queryImpl = queryImpl || ((...args) => loadSdkQuery()(...args));
    this.pendingResolve = null; // 有待確認的操作時，存 (allow: boolean) => void
    this.pendingDescription = null;
    this.busy = false; // 目前這個 session 有沒有任務正在跑（含暫停等確認）
    this.sessionId = null; // 上一輪任務結束時的 session id，讓下一輪任務延續同一個對話
    this._settle = null;
    this.freePermissionMode = !!freePermissionMode;
    this.onNarration = typeof onNarration === 'function' ? onNarration : () => {};
  }

  get hasPendingConfirmation() {
    return !!this.pendingResolve;
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

    try {
      const options = {
        cwd: this.cwd,
        permissionMode: 'default',
        allowedTools: SAFE_TOOLS,
        canUseTool,
      };
      // 延續上一輪任務的對話（同一個 CLI 模式 session 內，第二次以後才會有 sessionId）。
      if (this.sessionId) options.resume = this.sessionId;

      for await (const message of this.queryImpl({ prompt, options })) {
        if (message.type === 'result') {
          this.busy = false;
          this.sessionId = message.session_id || this.sessionId;
          const text = message.subtype === 'success'
            ? message.result
            : `任務沒有成功結束（${message.subtype}）`;
          this._settle({ type: 'result', text });
          return;
        }
      }
      // 理論上 SDK 一定會送 result 訊息收尾；真的沒送到也要解除等待狀態，不要讓桌寵卡在
      // 「思考中」回不來。
      this.busy = false;
      this._settle({ type: 'result', text: '（任務結束，但沒有收到明確的結果訊息）' });
    } catch (err) {
      this.busy = false;
      this.pendingResolve = null;
      this._settle({ type: 'error', text: `CLI 任務發生錯誤：${err.message}` });
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

module.exports = { ClaudeCliSession, interpretYesNo, describeToolUse, spokenToolUseSummary, SAFE_TOOLS };
