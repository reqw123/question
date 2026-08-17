import { describe, it, expect, vi } from 'vitest';
import { transcribeAudio } from './stt.js';

describe('transcribeAudio', () => {
  it('returns transcribed text when the API call succeeds', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ text: '你好，今天天氣真好' }),
    });

    const result = await transcribeAudio({
      audioBuffer: Buffer.from([1, 2, 3, 4]),
      apiKey: 'sk-test-key',
      fetchImpl,
    });

    expect(result).toEqual({ text: '你好，今天天氣真好' });
  });

  it('discards the text when every segment reports a high no_speech_prob (likely hallucinated on near-silence)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        text: 'Thanks for watching.',
        segments: [{ no_speech_prob: 0.92 }, { no_speech_prob: 0.88 }],
      }),
    });

    const result = await transcribeAudio({
      audioBuffer: Buffer.from([1, 2, 3, 4]),
      apiKey: 'sk-test-key',
      fetchImpl,
    });

    expect(result).toEqual({ text: '' });
  });

  it('keeps the text when every segment reports a low no_speech_prob (confident there was real speech)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        text: '你好，今天天氣真好',
        segments: [{ no_speech_prob: 0.05 }, { no_speech_prob: 0.02 }],
      }),
    });

    const result = await transcribeAudio({
      audioBuffer: Buffer.from([1, 2, 3, 4]),
      apiKey: 'sk-test-key',
      fetchImpl,
    });

    expect(result).toEqual({ text: '你好，今天天氣真好' });
  });

  it('keeps the text when a confident-speech segment is dragged down by the recording\'s built-in silence tail (regression: averaging discarded real speech)', async () => {
    // index.html 的錄音一定會在偵測到安靜後多錄 1.5 秒尾音才停止（見 silence-detector.js），
    // 這截尾音常被 Whisper 切成獨立的高 no_speech_prob segment——如果整段音檔只講了短短一句話，
    // 真實發言 segment 跟尾音靜音 segment 的「平均值」很容易被拉過門檻，把使用者真的講的話丟掉。
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        text: '打開小算盤',
        segments: [{ no_speech_prob: 0.05 }, { no_speech_prob: 0.95 }],
      }),
    });

    const result = await transcribeAudio({
      audioBuffer: Buffer.from([1, 2, 3, 4]),
      apiKey: 'sk-test-key',
      fetchImpl,
    });

    expect(result).toEqual({ text: '打開小算盤' });
  });

  it('rejects an empty audio buffer without calling the network layer', async () => {
    const fetchImpl = vi.fn();

    await expect(
      transcribeAudio({ audioBuffer: Buffer.alloc(0), apiKey: 'sk-test-key', fetchImpl })
    ).rejects.toMatchObject({ name: 'SttError', code: 'INVALID_INPUT' });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a missing API key without calling the network layer', async () => {
    const fetchImpl = vi.fn();

    await expect(
      transcribeAudio({ audioBuffer: Buffer.from([1, 2, 3]), apiKey: '', fetchImpl })
    ).rejects.toMatchObject({ name: 'SttError', code: 'INVALID_INPUT' });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('classifies a 401 response as an auth error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401 });

    await expect(
      transcribeAudio({ audioBuffer: Buffer.from([1, 2, 3]), apiKey: 'sk-revoked', fetchImpl })
    ).rejects.toMatchObject({ name: 'SttError', code: 'AUTH_ERROR' });
  });

  it('classifies a 429 response as a rate limit error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 429 });

    await expect(
      transcribeAudio({ audioBuffer: Buffer.from([1, 2, 3]), apiKey: 'sk-test-key', fetchImpl })
    ).rejects.toMatchObject({ name: 'SttError', code: 'RATE_LIMIT' });
  });

  it('classifies other non-OK responses as a generic API error and includes the response body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => '{"error":{"message":"model `whisper-1` unavailable"}}',
    });

    await expect(
      transcribeAudio({ audioBuffer: Buffer.from([1, 2, 3]), apiKey: 'sk-test-key', fetchImpl })
    ).rejects.toMatchObject({ name: 'SttError', code: 'API_ERROR' });
    await expect(
      transcribeAudio({ audioBuffer: Buffer.from([1, 2, 3]), apiKey: 'sk-test-key', fetchImpl })
    ).rejects.toThrow(/model `whisper-1` unavailable/);
  });

  it('classifies a network-layer failure as a network error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

    await expect(
      transcribeAudio({ audioBuffer: Buffer.from([1, 2, 3]), apiKey: 'sk-test-key', fetchImpl })
    ).rejects.toMatchObject({ name: 'SttError', code: 'NETWORK_ERROR' });
  });

  it('passes the abort signal through to fetch and rethrows AbortError as-is (not wrapped in SttError)', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    const fetchImpl = vi.fn().mockRejectedValue(abortError);
    const controller = new AbortController();

    await expect(
      transcribeAudio({
        audioBuffer: Buffer.from([1, 2, 3]), apiKey: 'sk-test-key', fetchImpl, signal: controller.signal,
      })
    ).rejects.toBe(abortError);

    expect(fetchImpl.mock.calls[0][1].signal).toBe(controller.signal);
  });
});
