import { describe, it, expect, vi } from 'vitest';
import { ClaudeCliSession, interpretYesNo, describeToolUse, spokenToolUseSummary, SAFE_TOOLS } from './claude-cli.js';

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
      onNarration: async (text) => {
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
