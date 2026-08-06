import { describe, it, expect, vi } from 'vitest';
import { synthesizeSpeech, TtsError } from './tts.js';

describe('synthesizeSpeech', () => {
  it('returns audio bytes when the API call succeeds', async () => {
    const fakeAudioBytes = new Uint8Array([1, 2, 3, 4]).buffer;
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => fakeAudioBytes,
    });

    const result = await synthesizeSpeech({
      text: '測試語音',
      apiKey: 'sk-test-key',
      fetchImpl,
    });

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.equals(Buffer.from(fakeAudioBytes))).toBe(true);
  });

  it('rejects blank text without calling the network layer', async () => {
    const fetchImpl = vi.fn();

    await expect(
      synthesizeSpeech({ text: '   ', apiKey: 'sk-test-key', fetchImpl })
    ).rejects.toMatchObject({ name: 'TtsError', code: 'INVALID_INPUT' });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects text longer than the OpenAI TTS input limit without calling the network layer', async () => {
    const fetchImpl = vi.fn();
    const tooLong = 'a'.repeat(4097);

    await expect(
      synthesizeSpeech({ text: tooLong, apiKey: 'sk-test-key', fetchImpl })
    ).rejects.toMatchObject({ name: 'TtsError', code: 'INVALID_INPUT' });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a missing API key without calling the network layer', async () => {
    const fetchImpl = vi.fn();

    await expect(
      synthesizeSpeech({ text: '測試語音', apiKey: '', fetchImpl })
    ).rejects.toMatchObject({ name: 'TtsError', code: 'INVALID_INPUT' });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('classifies a 401 response as an auth error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401 });

    await expect(
      synthesizeSpeech({ text: '測試語音', apiKey: 'sk-revoked', fetchImpl })
    ).rejects.toMatchObject({ name: 'TtsError', code: 'AUTH_ERROR' });
  });

  it('classifies a 429 response as a rate limit error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 429 });

    await expect(
      synthesizeSpeech({ text: '測試語音', apiKey: 'sk-test-key', fetchImpl })
    ).rejects.toMatchObject({ name: 'TtsError', code: 'RATE_LIMIT' });
  });

  it('classifies other non-OK responses as a generic API error', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500 });

    await expect(
      synthesizeSpeech({ text: '測試語音', apiKey: 'sk-test-key', fetchImpl })
    ).rejects.toMatchObject({ name: 'TtsError', code: 'API_ERROR' });
  });

  it('includes the response body text in the error message for diagnosis', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => '{"error":{"message":"model `tts-1` has been retired"}}',
    });

    await expect(
      synthesizeSpeech({ text: '測試語音', apiKey: 'sk-test-key', fetchImpl })
    ).rejects.toThrow(/model `tts-1` has been retired/);
  });

  it('classifies a network-layer failure as a network error', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND'));

    await expect(
      synthesizeSpeech({ text: '測試語音', apiKey: 'sk-test-key', fetchImpl })
    ).rejects.toMatchObject({ name: 'TtsError', code: 'NETWORK_ERROR' });
  });
});
