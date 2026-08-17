import { describe, it, expect, vi } from 'vitest';
import { sendOllamaChatMessage, listOllamaModels, normalizeOllamaUrl } from './ollama.js';

describe('sendOllamaChatMessage', () => {
  it('returns the assistant reply when the API call succeeds', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ message: { role: 'assistant', content: '哈囉，我是本機模型！' } }),
    });

    const result = await sendOllamaChatMessage({
      message: '你好',
      systemPrompt: '你是活潑的角色一',
      history: [],
      model: 'qwen2.5:7b',
      baseUrl: 'http://localhost:11434',
      fetchImpl,
    });

    expect(result).toEqual({ reply: '哈囉，我是本機模型！' });
    // 打的是原生 /api/chat，不是 OpenAI 相容的 /v1/chat/completions
    // （跟 ai-quiz-generator/index.html 的 callOllama() 同一個端點）。
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:11434/api/chat',
      expect.objectContaining({ method: 'POST' })
    );
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).toMatchObject({ model: 'qwen2.5:7b', stream: false });
    expect(body.messages[0]).toEqual({ role: 'system', content: '你是活潑的角色一' });
    expect(body.messages[1]).toEqual({ role: 'user', content: '你好' });
  });

  it('normalizes a bare host:port base URL before calling the API', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ message: { content: '好' } }),
    });

    await sendOllamaChatMessage({
      message: '你好', systemPrompt: '人設', model: 'qwen2.5:3b',
      baseUrl: '192.168.0.171:11434/', fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledWith('http://192.168.0.171:11434/api/chat', expect.anything());
  });

  it('rejects blank messages without calling the network layer', async () => {
    const fetchImpl = vi.fn();

    await expect(
      sendOllamaChatMessage({ message: '   ', systemPrompt: '人設', model: 'qwen2.5:7b', baseUrl: 'http://localhost:11434', fetchImpl })
    ).rejects.toMatchObject({ name: 'OllamaError', code: 'INVALID_INPUT' });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a missing model without calling the network layer', async () => {
    const fetchImpl = vi.fn();

    await expect(
      sendOllamaChatMessage({ message: '你好', systemPrompt: '人設', model: '', baseUrl: 'http://localhost:11434', fetchImpl })
    ).rejects.toMatchObject({ name: 'OllamaError', code: 'INVALID_INPUT' });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a missing base URL without calling the network layer', async () => {
    const fetchImpl = vi.fn();

    await expect(
      sendOllamaChatMessage({ message: '你好', systemPrompt: '人設', model: 'qwen2.5:7b', baseUrl: '', fetchImpl })
    ).rejects.toMatchObject({ name: 'OllamaError', code: 'INVALID_INPUT' });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('classifies a 404 response as a model-not-found error with a copy-pasteable pull command', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => '' });

    await expect(
      sendOllamaChatMessage({ message: '你好', systemPrompt: '人設', model: 'qwen2.5:7b', baseUrl: 'http://localhost:11434', fetchImpl })
    ).rejects.toMatchObject({ name: 'OllamaError', code: 'MODEL_NOT_FOUND' });
    await expect(
      sendOllamaChatMessage({ message: '你好', systemPrompt: '人設', model: 'qwen2.5:7b', baseUrl: 'http://localhost:11434', fetchImpl })
    ).rejects.toThrow(/ollama pull qwen2.5:7b/);
  });

  it('classifies other non-OK responses as a generic API error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'internal error' });

    await expect(
      sendOllamaChatMessage({ message: '你好', systemPrompt: '人設', model: 'qwen2.5:7b', baseUrl: 'http://localhost:11434', fetchImpl })
    ).rejects.toMatchObject({ name: 'OllamaError', code: 'API_ERROR' });
  });

  it('classifies a network-layer failure (Ollama not running) as a network error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      sendOllamaChatMessage({ message: '你好', systemPrompt: '人設', model: 'qwen2.5:7b', baseUrl: 'http://localhost:11434', fetchImpl })
    ).rejects.toMatchObject({ name: 'OllamaError', code: 'NETWORK_ERROR' });
  });

  it('passes the abort signal through to fetch and rethrows AbortError as-is (not wrapped in OllamaError)', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    const fetchImpl = vi.fn().mockRejectedValue(abortError);
    const controller = new AbortController();

    await expect(
      sendOllamaChatMessage({
        message: '你好', systemPrompt: '人設', model: 'qwen2.5:7b', baseUrl: 'http://localhost:11434',
        fetchImpl, signal: controller.signal,
      })
    ).rejects.toBe(abortError);

    expect(fetchImpl.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it('treats an empty reply as an error rather than sending a blank message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ message: { content: '' } }),
    });

    await expect(
      sendOllamaChatMessage({ message: '你好', systemPrompt: '人設', model: 'qwen2.5:7b', baseUrl: 'http://localhost:11434', fetchImpl })
    ).rejects.toMatchObject({ name: 'OllamaError', code: 'EMPTY_REPLY' });
  });
});

describe('listOllamaModels', () => {
  it('returns the list of pulled model names', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ models: [{ name: 'qwen2.5:7b' }, { name: 'qwen2.5:3b' }] }),
    });

    const result = await listOllamaModels({ baseUrl: 'http://localhost:11434', fetchImpl });

    expect(result).toEqual({ models: ['qwen2.5:7b', 'qwen2.5:3b'] });
    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:11434/api/tags');
  });

  it('returns an empty list when no models are pulled yet', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ models: [] }) });

    const result = await listOllamaModels({ baseUrl: 'http://localhost:11434', fetchImpl });

    expect(result).toEqual({ models: [] });
  });

  it('classifies a connection failure as a network error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(
      listOllamaModels({ baseUrl: 'http://localhost:11434', fetchImpl })
    ).rejects.toMatchObject({ name: 'OllamaError', code: 'NETWORK_ERROR' });
  });
});

describe('normalizeOllamaUrl', () => {
  it('adds http:// to a bare host:port', () => {
    expect(normalizeOllamaUrl('192.168.0.171:11434')).toBe('http://192.168.0.171:11434');
  });

  it('strips trailing slashes and extra path segments down to the origin', () => {
    expect(normalizeOllamaUrl('http://localhost:11434/api/')).toBe('http://localhost:11434');
  });

  it('leaves an https URL untouched apart from trailing slash removal', () => {
    expect(normalizeOllamaUrl('https://ollama.example.com/')).toBe('https://ollama.example.com');
  });
});
