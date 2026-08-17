import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ClaudeCliSession, interpretYesNo, describeToolUse, spokenToolUseSummary, SAFE_TOOLS,
  buildPlaywrightMcpServer,
} from './claude-cli.js';

// 模擬 SDK 的 query()：真正的 SDK 內部在生成訊息的過程中會呼叫呼叫端傳進去的
// canUseTool，並且要等它 resolve 才繼續——這裡用 async generator 手動重現這個協定，
// 讓 ClaudeCliSession 不用真的裝這個套件、不用真的連上 Claude 就能測。
function makeQueryImpl(steps) {
  // steps 是一連串「這一步要不要呼叫 canUseTool，呼叫了要送什麼 toolName/input」的腳本，
  // 最後一步一定是 result。
  return vi.fn(async function* ({ options }) {
    for (const step of steps) {
      if (step.toolUse) {
        const result = await options.canUseTool(step.toolUse.name, step.toolUse.input, step.toolUse.opts || {});
        if (result.behavior === 'deny') {
          yield { type: 'result', subtype: 'error_during_execution', session_id: 'sess-1' };
          return;
        }
      } else if (step.result) {
        yield { type: 'result', subtype: 'success', result: step.result, session_id: step.sessionId || 'sess-1' };
      }
    }
  });
}

describe('ClaudeCliSession', () => {
  it('auto-allows safe tools (Read/Glob/Grep) without pausing for confirmation', async () => {
    const queryImpl = makeQueryImpl([
      { toolUse: { name: 'Read', input: { file_path: 'a.txt' } } },
      { toolUse: { name: 'Glob', input: { pattern: '*.js' } } },
      { result: '讀完了，這個檔案是...' },
    ]);
    const session = new ClaudeCliSession({ cwd: 'C:\\question', queryImpl });

    const outcome = await session.start('幫我看一下 a.txt');

    expect(outcome).toEqual({ type: 'result', text: '讀完了，這個檔案是...' });
    expect(session.busy).toBe(false);
    expect(session.hasPendingConfirmation).toBe(false);
  });

  // onToolUse：main.js 用這個通知偵測「瀏覽器工具要執行了」去暫時降低桌寵視窗的置頂
  // 等級（見 docs/adr/0012）——這裡只驗證 ClaudeCliSession 這端「每個工具呼叫都會通知
  // 一次，不管最後是唯讀自動放行還是要暫停問使用者」，不驗證 Electron 那端的視窗行為
  // （main.js 沒有自動測試，見 docs/specs/0006 的 Testing Decisions）。
  it('notifies onToolUse for every tool call, including auto-allowed safe tools', async () => {
    const queryImpl = makeQueryImpl([
      { toolUse: { name: 'Read', input: { file_path: 'a.txt' } } },
      { toolUse: { name: 'mcp__playwright__browser_navigate', input: { url: 'https://example.com' } } },
      { result: '完成了' },
    ]);
    const toolNames = [];
    const session = new ClaudeCliSession({ cwd: 'C:\\question', queryImpl, onToolUse: (name) => toolNames.push(name) });

    await session.start('讀檔案然後開網頁');
    await session.resolveConfirmation(true); // browser_navigate 不在 SAFE_TOOLS，會暫停等確認

    expect(toolNames).toEqual(['Read', 'mcp__playwright__browser_navigate']);
  });

  it('does not throw when onToolUse is omitted', async () => {
    const queryImpl = makeQueryImpl([
      { toolUse: { name: 'Read', input: { file_path: 'a.txt' } } },
      { result: '完成了' },
    ]);
    const session = new ClaudeCliSession({ cwd: 'C:\\question', queryImpl });

    const outcome = await session.start('讀一下');

    expect(outcome).toEqual({ type: 'result', text: '完成了' });
  });

  it('sends the claude_code system prompt preset with the GUI-launch guidance appended', async () => {
    const queryImpl = makeQueryImpl([{ result: '完成了' }]);
    const session = new ClaudeCliSession({ cwd: 'C:\\question', queryImpl });

    await session.start('幫我打開小算盤');

    const passedOptions = queryImpl.mock.calls[0][0].options;
    expect(passedOptions.systemPrompt.type).toBe('preset');
    expect(passedOptions.systemPrompt.preset).toBe('claude_code');
    // 沒有這句提示的話，實測過同一句「幫我打開 XXX」有時會被模型直接回絕、完全不嘗試
    // 呼叫任何工具（canUseTool 根本不會被觸發）——這句是修這個問題的關鍵內容，不是隨便
    // 一句提示都算數，斷言要包含「幫我打開」這個關鍵字樣，確保沒有被之後的重構改掉語意。
    expect(passedOptions.systemPrompt.append).toContain('幫我打開');
    // 這台機器的桌面被 OneDrive 重新導向到 %USERPROFILE%\OneDrive\Desktop，實測過模型會
    // 一路查錯 %USERPROFILE%\Desktop／Start Menu／Program Files／AppX，來回問了使用者
    // 四次同意都還沒找到，其實東西就躺在桌面上——這句提示是修這個問題的關鍵內容。
    expect(passedOptions.systemPrompt.append).toContain('GetFolderPath');
    expect(passedOptions.systemPrompt.append).toContain('OneDrive');
  });

  it('mentions the browser automation tools in the system prompt so requests to browse a site are not refused', async () => {
    const queryImpl = makeQueryImpl([{ result: '完成了' }]);
    const session = new ClaudeCliSession({ cwd: 'C:\\question', queryImpl });

    await session.start('幫我上網查一下今天天氣');

    const passedOptions = queryImpl.mock.calls[0][0].options;
    // 見 docs/adr/0012：沒有這句提示的話，模型實測過會回覆「我沒有能力操控瀏覽器」
    // 直接拒絕，即使 mcp__playwright__ 工具其實已經接進來了。
    expect(passedOptions.systemPrompt.append).toContain('mcp__playwright__');
    expect(passedOptions.systemPrompt.append).toContain('預設當作可以透過這些工具直接完成');
  });

  it('connects the Playwright MCP server (system Chrome) so mcp__playwright__ tools are available', async () => {
    const queryImpl = makeQueryImpl([{ result: '完成了' }]);
    const session = new ClaudeCliSession({ cwd: 'C:\\question', queryImpl });

    await session.start('幫我開網頁');

    const passedOptions = queryImpl.mock.calls[0][0].options;
    expect(passedOptions.mcpServers.playwright).toEqual(buildPlaywrightMcpServer());
  });

  it('pauses on a risky tool (Bash) and resumes after resolveConfirmation(true)', async () => {
    const queryImpl = makeQueryImpl([
      { toolUse: { name: 'Bash', input: { command: 'npm test' }, opts: { title: 'Claude wants to run: npm test' } } },
      { result: '測試都通過了' },
    ]);
    const session = new ClaudeCliSession({ cwd: 'C:\\question', queryImpl });

    const confirmOutcome = await session.start('幫我跑測試');
    expect(confirmOutcome.type).toBe('confirm');
    expect(confirmOutcome.text).toContain('Claude wants to run: npm test');
    // spokenText 是給 TTS 念的通用版本，Bash 一律不念原始指令內容（見 docs/specs/0009）——
    // 就算 text 顯示的是 SDK 給的 title，spokenText 還是只講「執行一個系統指令」。
    expect(confirmOutcome.spokenText).toContain('執行一個系統指令');
    expect(confirmOutcome.spokenText).not.toContain('npm test');
    expect(session.hasPendingConfirmation).toBe(true);
    expect(session.busy).toBe(true); // 還在等確認，任務沒結束

    const finalOutcome = await session.resolveConfirmation(true);
    expect(finalOutcome).toEqual({ type: 'result', text: '測試都通過了' });
    expect(session.hasPendingConfirmation).toBe(false);
    expect(session.busy).toBe(false);
  });

  it('pauses on a browser automation tool (mcp__playwright__browser_navigate) just like Bash/Write', async () => {
    const queryImpl = makeQueryImpl([
      { toolUse: { name: 'mcp__playwright__browser_navigate', input: { url: 'https://example.com' } } },
      { result: '頁面開好了' },
    ]);
    const session = new ClaudeCliSession({ cwd: 'C:\\question', queryImpl });

    const confirmOutcome = await session.start('幫我開 example.com');
    expect(confirmOutcome.type).toBe('confirm');
    expect(confirmOutcome.text).toContain('開啟網頁：https://example.com');
    expect(session.hasPendingConfirmation).toBe(true);

    const finalOutcome = await session.resolveConfirmation(true);
    expect(finalOutcome).toEqual({ type: 'result', text: '頁面開好了' });
  });

  it('passes a deny behavior through to the SDK when the user rejects', async () => {
    const queryImpl = makeQueryImpl([
      { toolUse: { name: 'Bash', input: { command: 'rm -rf node_modules' } } },
      { result: '好的，我不會執行這個指令' },
    ]);
    const session = new ClaudeCliSession({ cwd: 'C:\\question', queryImpl });

    await session.start('清一下 node_modules');
    const finalOutcome = await session.resolveConfirmation(false);

    // makeQueryImpl 收到 deny 時直接送出 error_during_execution 收尾（模擬「使用者拒絕，
    // Claude 沒有辦法完成」的情境），驗證 deny 真的有傳到 canUseTool 的回傳值。
    expect(finalOutcome).toEqual({ type: 'result', text: '任務沒有成功結束（error_during_execution）' });
  });

  it('handles multiple sequential confirmations within one task', async () => {
    const queryImpl = makeQueryImpl([
      { toolUse: { name: 'Write', input: { file_path: 'a.js' } } },
      { toolUse: { name: 'Bash', input: { command: 'node a.js' } } },
      { result: '檔案寫好了，也跑過了' },
    ]);
    const session = new ClaudeCliSession({ cwd: 'C:\\question', queryImpl });

    const first = await session.start('寫個腳本並執行');
    expect(first.type).toBe('confirm');
    expect(first.text).toContain('修改檔案：a.js');

    const second = await session.resolveConfirmation(true);
    expect(second.type).toBe('confirm');
    expect(second.text).toContain('執行指令：node a.js');

    const third = await session.resolveConfirmation(true);
    expect(third).toEqual({ type: 'result', text: '檔案寫好了，也跑過了' });
  });

  it('rejects starting a new task while one is already busy', async () => {
    const queryImpl = makeQueryImpl([
      { toolUse: { name: 'Bash', input: { command: 'sleep 100' } } },
      { result: 'done' },
    ]);
    const session = new ClaudeCliSession({ cwd: 'C:\\question', queryImpl });

    await session.start('第一個任務'); // 停在 confirm，還沒結束
    const second = await session.start('第二個任務');

    expect(second.type).toBe('error');
    expect(second.text).toContain('還在跑');
  });

  it('returns an error when resolving a confirmation that does not exist', async () => {
    const session = new ClaudeCliSession({ cwd: 'C:\\question', queryImpl: makeQueryImpl([{ result: 'ok' }]) });

    const outcome = await session.resolveConfirmation(true);

    expect(outcome).toEqual({ type: 'error', text: '目前沒有待確認的操作' });
  });

  it('classifies a thrown error from the SDK as an error outcome and resets busy', async () => {
    const queryImpl = vi.fn(async function* () {
      throw new Error('ECONNREFUSED');
      // eslint-disable-next-line no-unreachable
      yield undefined;
    });
    const session = new ClaudeCliSession({ cwd: 'C:\\question', queryImpl });

    const outcome = await session.start('做點什麼');

    expect(outcome).toEqual({ type: 'error', text: 'CLI 任務發生錯誤：ECONNREFUSED' });
    expect(session.busy).toBe(false);
  });

  // 見 claude-cli.js 的註解：如果直接寫 err.message，SDK 丟出非 Error 值時會在 catch
  // block 裡再炸一次、_settle() 永遠不會被呼叫，start() 回傳的 promise 就永遠不會
  // resolve——這個測試如果卡住不動（vitest 逾時失敗），代表這個防護退化了。
  it('does not hang when the SDK throws a non-Error value (e.g. reject(null))', async () => {
    const queryImpl = vi.fn(async function* () {
      throw null;
      // eslint-disable-next-line no-unreachable
      yield undefined;
    });
    const session = new ClaudeCliSession({ cwd: 'C:\\question', queryImpl });

    const outcome = await session.start('做點什麼');

    expect(outcome.type).toBe('error');
    expect(outcome.text).toContain('CLI 任務發生錯誤');
    expect(session.busy).toBe(false);
    // 卡死時使用者按 Esc 會被 abort() 的 `if (!this.busy) return false` 擋掉，看起來
    // 「沒有東西可以取消」——確認這個防護真的解除了 busy，abort() 之後的狀態是一致的。
    expect(session.abort()).toBe(false);
  });

  it('auto-executes risky tools without pausing when freePermissionMode is on, and narrates each one', async () => {
    const queryImpl = makeQueryImpl([
      { toolUse: { name: 'Write', input: { file_path: 'a.js' } } },
      { toolUse: { name: 'Bash', input: { command: 'node a.js' } } },
      { result: '寫好了也跑過了' },
    ]);
    const narrations = [];
    const session = new ClaudeCliSession({
      cwd: 'C:\\question',
      queryImpl,
      freePermissionMode: true,
      onNarration: (text, spokenText) => { narrations.push({ text, spokenText }); },
    });

    const outcome = await session.start('寫個腳本並執行');

    // 不曾停在 confirm——直接一路跑到 result，中途沒有暫停等使用者回覆。
    expect(outcome).toEqual({ type: 'result', text: '寫好了也跑過了' });
    expect(session.hasPendingConfirmation).toBe(false);
    expect(narrations).toEqual([
      {
        text: '⚡ 免確認模式，已自動執行：修改檔案：a.js',
        spokenText: '免確認模式，已自動執行：修改檔案：a.js', // Write 不是 Bash，spokenText 跟顯示內容一致
      },
      {
        text: '⚡ 免確認模式，已自動執行：執行指令：node a.js',
        spokenText: '免確認模式，已自動執行：執行一個系統指令', // Bash：spokenText 不含原始指令內容
      },
    ]);
  });

  it('does not call onNarration for safe tools even when freePermissionMode is on', async () => {
    const queryImpl = makeQueryImpl([
      { toolUse: { name: 'Read', input: { file_path: 'a.txt' } } },
      { result: '讀完了' },
    ]);
    const onNarration = vi.fn();
    const session = new ClaudeCliSession({
      cwd: 'C:\\question', queryImpl, freePermissionMode: true, onNarration,
    });

    await session.start('讀一下 a.txt');

    expect(onNarration).not.toHaveBeenCalled();
  });

  it('waits for onNarration to settle before letting the tool proceed', async () => {
    const queryImpl = makeQueryImpl([
      { toolUse: { name: 'Bash', input: { command: 'echo hi' } } },
      { result: 'done' },
    ]);
    const order = [];
    const session = new ClaudeCliSession({
      cwd: 'C:\\question',
      queryImpl,
      freePermissionMode: true,
      onNarration: async () => {
        order.push('narration-start');
        await Promise.resolve();
        order.push('narration-end');
      },
    });

    await session.start('跑個指令');

    // narration-end 一定在 canUseTool 回傳（也就是工具真的被放行）之前發生。
    expect(order).toEqual(['narration-start', 'narration-end']);
  });

  it('defaults freePermissionMode to off and pauses as usual when the option is omitted', async () => {
    const queryImpl = makeQueryImpl([
      { toolUse: { name: 'Bash', input: { command: 'echo hi' } } },
      { result: 'done' },
    ]);
    const session = new ClaudeCliSession({ cwd: 'C:\\question', queryImpl });

    const outcome = await session.start('跑個指令');

    expect(outcome.type).toBe('confirm');
  });

  it('reuses the captured session_id (resume) on the next task in the same session', async () => {
    const queryImpl = makeQueryImpl([{ result: '第一輪完成', sessionId: 'sess-abc' }]);
    const session = new ClaudeCliSession({ cwd: 'C:\\question', queryImpl });

    await session.start('第一輪任務');
    expect(session.sessionId).toBe('sess-abc');

    queryImpl.mockClear();
    queryImpl.mockImplementationOnce(async function* ({ options }) {
      expect(options.resume).toBe('sess-abc');
      yield { type: 'result', subtype: 'success', result: '第二輪完成', session_id: 'sess-abc' };
    });

    const second = await session.start('第二輪任務，接續前面');
    expect(second).toEqual({ type: 'result', text: '第二輪完成' });
  });

  it('passes an AbortController to the SDK via options.abortController', async () => {
    const queryImpl = makeQueryImpl([{ result: '完成了' }]);
    const session = new ClaudeCliSession({ cwd: 'C:\\question', queryImpl });

    await session.start('幫我做點事');

    expect(queryImpl.mock.calls[0][0].options.abortController).toBeInstanceOf(AbortController);
  });

  it('abort() returns false and does nothing when there is no task running', () => {
    const session = new ClaudeCliSession({ cwd: 'C:\\question', queryImpl: makeQueryImpl([]) });
    expect(session.abort()).toBe(false);
  });

  it('abort() cancels a task that is actively running (not paused for confirmation), resolving start() as cancelled', async () => {
    // 模擬真正的 SDK：abortController 被 abort() 之前這一步的 await 會一直卡著（代表
    // 「還在跑，沒有暫停等確認」），abort() 之後才讓它拋出 AbortError 結束——這裡故意
    // 不用 makeQueryImpl（那個 helper 的 steps 都是同步跑完，沒有機會在中途呼叫
    // abort()），改手寫一個會卡在 abortController.signal 上的版本。
    const queryImpl = vi.fn(async function* ({ options }) {
      await new Promise((_resolve, reject) => {
        options.abortController.signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
      yield { type: 'result', subtype: 'success', result: '不會用到，abort 後任務已經結束', session_id: 'sess-1' };
    });
    const session = new ClaudeCliSession({ cwd: 'C:\\question', queryImpl });

    const startPromise = session.start('幫我做一件需要一陣子的事');
    expect(session.busy).toBe(true);
    expect(session.hasPendingConfirmation).toBe(false);

    expect(session.abort()).toBe(true);

    const outcome = await startPromise;
    expect(outcome).toEqual({ type: 'cancelled', text: '已取消目前的 CLI 任務。' });
    expect(session.busy).toBe(false);
  });

  it('abort() while paused for confirmation denies the pending tool use and leaves the session idle (no hang)', async () => {
    const queryImpl = makeQueryImpl([
      { toolUse: { name: 'Bash', input: { command: 'rm -rf something' } } },
      { result: '不會用到，abort 後任務已經結束' },
    ]);
    const session = new ClaudeCliSession({ cwd: 'C:\\question', queryImpl });

    const confirmOutcome = await session.start('幫我跑一個危險指令');
    expect(confirmOutcome.type).toBe('confirm');
    expect(session.hasPendingConfirmation).toBe(true);

    expect(session.abort()).toBe(true);
    expect(session.hasPendingConfirmation).toBe(false);

    // abort() 解開卡住的 canUseTool 之後，_runLoop 要跑完剩下的收尾邏輯（deny → mock
    // yield 一則 result → 判斷 _cancelled）才會真的把 busy 收掉，這段是非同步的，
    // 用 setTimeout(0) 讓這條 microtask/macrotask 鏈跑完，確保沒有卡住、最後 busy
    // 一定會回到 false。
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.busy).toBe(false);
  });
});

describe('describeToolUse', () => {
  it('prefers the SDK-provided title when present', () => {
    expect(describeToolUse('Bash', { command: 'ls' }, { title: 'Claude wants to list files' }))
      .toBe('Claude wants to list files');
  });

  it('summarizes a Bash command when no title is given', () => {
    expect(describeToolUse('Bash', { command: 'rm -rf /' }, {})).toBe('執行指令：rm -rf /');
  });

  it('summarizes a file edit when no title is given', () => {
    expect(describeToolUse('Write', { file_path: 'foo.js' }, {})).toBe('修改檔案：foo.js');
  });

  it('falls back to a generic JSON summary for unknown tools', () => {
    expect(describeToolUse('WebFetch', { url: 'https://example.com' }, {})).toContain('WebFetch');
  });

  it('summarizes browser_navigate with the target URL', () => {
    expect(describeToolUse('mcp__playwright__browser_navigate', { url: 'https://example.com' }, {}))
      .toBe('開啟網頁：https://example.com');
  });

  it('summarizes browser_click with the target element', () => {
    expect(describeToolUse('mcp__playwright__browser_click', { element: '登入按鈕', ref: 'e12' }, {}))
      .toBe('點擊網頁元素：登入按鈕');
  });

  it('summarizes browser_type with the typed text and field', () => {
    expect(describeToolUse('mcp__playwright__browser_type', { text: 'hello', element: '搜尋框' }, {}))
      .toBe('在網頁輸入文字：hello（欄位：搜尋框）');
  });

  it('summarizes browser_evaluate (in-page JS) with the code, truncated', () => {
    expect(describeToolUse('mcp__playwright__browser_evaluate', { function: 'document.title' }, {}))
      .toBe('在網頁裡執行 JavaScript：document.title');
  });

  it('flags browser_run_code_unsafe as local-machine execution equivalent to Bash, not just "browser code"', () => {
    // 見 claude-cli.js 的註解：官方文件明講這個工具「executes arbitrary JavaScript in the
    // Playwright server process and is RCE-equivalent」——風險跟 browser_evaluate（頁面內
    // JS）完全不是同一個等級，描述文字必須明確講出「本機」跟「風險等同 Bash」，不能沿用
    // browser_evaluate 那句聽起來很輕鬆的話，避免使用者低估風險就隨手同意。
    const description = describeToolUse('mcp__playwright__browser_run_code_unsafe', { code: 'require("fs").readFileSync("C:/secrets.txt")' }, {});
    expect(description).toContain('本機');
    expect(description).toContain('風險等同 Bash');
    expect(description).toContain('require("fs")');
  });
});

describe('spokenToolUseSummary', () => {
  it('replaces Bash descriptions with a generic phrase, never echoing the raw command', () => {
    const description = describeToolUse('Bash', { command: 'rm -rf --no-preserve-root /' }, {});
    expect(spokenToolUseSummary('Bash', description)).toBe('執行一個系統指令');
  });

  it('still replaces Bash even when the description came from an SDK title', () => {
    const description = describeToolUse('Bash', { command: 'npm test' }, { title: 'Claude wants to run: npm test' });
    expect(spokenToolUseSummary('Bash', description)).toBe('執行一個系統指令');
  });

  it('leaves non-Bash descriptions unchanged (already human-readable)', () => {
    const description = describeToolUse('Write', { file_path: 'foo.js' }, {});
    expect(spokenToolUseSummary('Write', description)).toBe(description);
  });

  it('replaces browser_evaluate descriptions with a generic phrase, never reading raw JS aloud', () => {
    const description = describeToolUse('mcp__playwright__browser_evaluate', { function: 'localStorage.clear()' }, {});
    expect(spokenToolUseSummary('mcp__playwright__browser_evaluate', description)).toBe('在網頁裡執行一段 JavaScript');
  });

  it('gives browser_run_code_unsafe its own spoken phrase that names the elevated (Bash-equivalent) risk', () => {
    const description = describeToolUse('mcp__playwright__browser_run_code_unsafe', { code: 'process.exit(1)' }, {});
    const spoken = spokenToolUseSummary('mcp__playwright__browser_run_code_unsafe', description);
    expect(spoken).not.toContain('process.exit'); // 不逐字念程式碼，跟 Bash/browser_evaluate 同規則
    expect(spoken).toBe('在本機執行一段任意程式碼，風險等同執行系統指令');
  });

  it('leaves browser_navigate descriptions unchanged (a URL is fine to read aloud)', () => {
    const description = describeToolUse('mcp__playwright__browser_navigate', { url: 'https://example.com' }, {});
    expect(spokenToolUseSummary('mcp__playwright__browser_navigate', description)).toBe(description);
  });
});

describe('buildPlaywrightMcpServer', () => {
  const originalToken = process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
  afterEach(() => {
    if (originalToken === undefined) delete process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
    else process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = originalToken;
  });

  it('spawns @playwright/mcp over stdio using --extension (connects to the already-running Chrome)', () => {
    const config = buildPlaywrightMcpServer();
    expect(config.type).toBe('stdio');
    expect(config.command).toBe('npx');
    expect(config.args).toEqual(['-y', '@playwright/mcp', '--extension']);
  });

  // 見 claude-cli.js 的註解：沒設 timeout 的話卡多久是 SDK 內建、我們查不到的黑盒值——
  // 明確設一個上限，讓「Chrome 授權對話框沒人理」這種情況最後會變成一個有清楚錯誤訊息、
  // 會自動結束的逾時，而不是不知道要等多久的無底洞。
  it('sets an explicit tool-call timeout so an unanswered Chrome dialog cannot hang indefinitely', () => {
    expect(buildPlaywrightMcpServer().timeout).toBe(120000);
  });

  it('does not set env when PLAYWRIGHT_MCP_EXTENSION_TOKEN is not set, leaving the child process to inherit the default environment', () => {
    delete process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
    expect(buildPlaywrightMcpServer().env).toBeUndefined();
  });

  // 見 claude-cli.js 的註解：--extension 每次 spawn 預設會拿到一組新的隨機 token，導致
  // Chrome 的授權對話框每次用瀏覽器工具都跳出來。把使用者自己設定的 token 傳給子行程，
  // 之後每次 spawn 都用同一個已授權過的 token，才不會一直跳。
  it('forwards a pinned PLAYWRIGHT_MCP_EXTENSION_TOKEN to the child process env so the extension does not re-prompt every spawn', () => {
    process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = 'test-token-abc';
    expect(buildPlaywrightMcpServer().env.PLAYWRIGHT_MCP_EXTENSION_TOKEN).toBe('test-token-abc');
  });

  // 不能只塞 PLAYWRIGHT_MCP_EXTENSION_TOKEN 這一個 key——npx 這個子行程需要 PATH 之類的
  // 基本環境變數才能找到 node/npm，如果 env 只有這一個 key，等於把子行程的環境變數表
  // 整個清空，npx 會直接啟動失敗。
  it('merges the pinned token into the full parent environment, not a replacement env with only that one key', () => {
    process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = 'test-token-abc';
    const config = buildPlaywrightMcpServer();
    expect(Object.keys(config.env).length).toBeGreaterThan(1);
    expect(config.env.PATH ?? config.env.Path).toBeTruthy();
  });

  // 不帶版本／@latest：npx 遇到明確版本 tag 一定會連 npm registry 查一次，就算本地已經
  // 裝了對應版本（package.json 的 @playwright/mcp）也一樣要查——不帶版本才會優先用本地
  // 已安裝的版本，不用每個 CLI 任務都額外連一次網路。
  it('does not pin an npm version/tag, so npx prefers the locally installed copy', () => {
    const config = buildPlaywrightMcpServer();
    expect(config.args).not.toContain('@playwright/mcp@latest');
    expect(config.args.some((arg) => arg.startsWith('@playwright/mcp@'))).toBe(false);
  });

  // 不用 --browser/--user-data-dir 自己啟動一個新的 Chrome 行程——見 claude-cli.js 的
  // 註解，那個做法在使用者已經開著 Chrome 時會撞上 profile 鎖定、卡在 about:blank。
  it('does not launch a separate Chrome process (no --browser or --user-data-dir flags)', () => {
    const config = buildPlaywrightMcpServer();
    expect(config.args).not.toContain('--browser');
    expect(config.args).not.toContain('--user-data-dir');
  });
});

describe('SAFE_TOOLS', () => {
  it('only contains the read-only tools', () => {
    expect(SAFE_TOOLS).toEqual(['Read', 'Glob', 'Grep']);
  });
});

describe('interpretYesNo', () => {
  it.each([
    ['同意', true],
    ['好，執行吧', true],
    ['ok', true],
    ['yes', true],
    ['可以', true],
  ])('treats %j as allow', (input, expected) => {
    expect(interpretYesNo(input)).toBe(expected);
  });

  it.each([
    ['拒絕', false],
    ['不要', false],
    ['不可以', false], // 含有「可以」子字串，但否定詞優先比對，不能被誤判成同意
    ['不同意', false], // 含有「同意」子字串，同上
    ['no', false],
    ['cancel', false],
  ])('treats %j as deny', (input, expected) => {
    expect(interpretYesNo(input)).toBe(expected);
  });

  it('does not misfire on an English word that merely contains "no" as a substring', () => {
    expect(interpretYesNo('I know about this')).toBe(null);
  });

  it('returns null for ambiguous or unrelated replies, never guessing', () => {
    expect(interpretYesNo('今天天氣不錯')).toBe(null);
    expect(interpretYesNo('')).toBe(null);
    expect(interpretYesNo('   ')).toBe(null);
  });
});
