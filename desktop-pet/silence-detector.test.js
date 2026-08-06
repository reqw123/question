import { describe, it, expect } from 'vitest';
import { checkSilence } from './silence-detector.js';

describe('checkSilence', () => {
  it('resets silence tracking when the input is loud (above threshold)', () => {
    const result = checkSilence({ rms: 0.5, silenceStartedAt: 12345, now: 20000 });

    expect(result).toEqual({ shouldStop: false, silenceStartedAt: null });
  });

  it('starts tracking silence when it is first detected (no prior silenceStartedAt)', () => {
    const result = checkSilence({ rms: 0.001, silenceStartedAt: null, now: 5000 });

    expect(result).toEqual({ shouldStop: false, silenceStartedAt: 5000 });
  });

  it('signals shouldStop once silence has lasted at least the configured duration', () => {
    // 安靜從 5000 開始，現在是 6600，已經過了 1600ms，超過預設的 1500ms 門檻
    const result = checkSilence({ rms: 0.001, silenceStartedAt: 5000, now: 6600 });

    expect(result.shouldStop).toBe(true);
  });

  it('keeps the original silenceStartedAt (does not restart the clock) while still under the duration threshold', () => {
    // 安靜從 5000 開始，現在是 5800，只過了 800ms，還沒到 1500ms 門檻
    const result = checkSilence({ rms: 0.001, silenceStartedAt: 5000, now: 5800 });

    expect(result).toEqual({ shouldStop: false, silenceStartedAt: 5000 });
  });
});
