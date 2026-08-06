import { describe, it, expect, vi } from 'vitest';
import { transcribeAudio, SttError } from './stt.js';

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

  it('discards the text when Whisper reports a high average no_speech_prob (likely hallucinated on near-silence)', async () => {
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

  it('keeps the text when Whisper reports a low average no_speech_prob (confident there was real speech)', async () => {
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
});
