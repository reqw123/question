import { describe, it, expect, vi } from 'vitest';
import { sendChatMessage, ChatError } from './chat.js';

describe('sendChatMessage', () => {
  it('returns the assistant reply when the API call succeeds', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { role: 'assistant', content: '哈囉，我是角色一！' } }],
      }),
    });

    const result = await sendChatMessage({
      message: '你好',
      systemPrompt: '你是活潑的角色一',
      history: [],
      apiKey: 'sk-test-key',
      fetchImpl,
    });

    expect(result).toEqual({ reply: '哈囉，我是角色一！' });
  });

  it('rejects blank messages without calling the network layer', async () => {
    const fetchImpl = vi.fn();

    await expect(
      sendChatMessage({ message: '   ', systemPrompt: '人設', apiKey: 'sk-test-key', fetchImpl })
    ).rejects.toMatchObject({ name: 'ChatError', code: 'INVALID_INPUT' });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a missing API key without calling the network layer', async () => {
    const fetchImpl = vi.fn();

    await expect(
      sendChatMessage({ message: '你好', systemPrompt: '人設', apiKey: '', fetchImpl })
    ).rejects.toMatchObject({ name: 'ChatError', code: 'INVALID_INPUT' });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('classifies a 401 response as an auth error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401 });

    await expect(
      sendChatMessage({ message: '你好', systemPrompt: '人設', apiKey: 'sk-revoked', fetchImpl })
    ).rejects.toMatchObject({ name: 'ChatError', code: 'AUTH_ERROR' });
  });

  it('classifies a 429 response as a rate limit error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 429 });

    await expect(
      sendChatMessage({ message: '你好', systemPrompt: '人設', apiKey: 'sk-test-key', fetchImpl })
    ).rejects.toMatchObject({ name: 'ChatError', code: 'RATE_LIMIT' });
  });

  it('classifies other non-OK responses as a generic API error and includes the response body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => '{"error":{"message":"model `gpt-4o-mini` unavailable"}}',
    });

    await expect(
      sendChatMessage({ message: '你好', systemPrompt: '人設', apiKey: 'sk-test-key', fetchImpl })
    ).rejects.toMatchObject({ name: 'ChatError', code: 'API_ERROR' });
    await expect(
      sendChatMessage({ message: '你好', systemPrompt: '人設', apiKey: 'sk-test-key', fetchImpl })
    ).rejects.toThrow(/model `gpt-4o-mini` unavailable/);
  });

  it('classifies a network-layer failure as a network error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

    await expect(
      sendChatMessage({ message: '你好', systemPrompt: '人設', apiKey: 'sk-test-key', fetchImpl })
    ).rejects.toMatchObject({ name: 'ChatError', code: 'NETWORK_ERROR' });
  });
});
