import { describe, it, expect } from 'vitest';
import { analyzeMouthOpenness } from './lipsync.js';

describe('analyzeMouthOpenness', () => {
  it('returns near-zero openness for silence (all samples at the 128 center point)', () => {
    const silence = new Uint8Array(64).fill(128);

    const result = analyzeMouthOpenness({ timeDomainData: silence, previousValue: 0 });

    expect(result).toBeCloseTo(0, 2);
  });

  it('returns openness close to the 1 ceiling for a full-amplitude signal', () => {
    const loud = new Uint8Array(64);
    for (let i = 0; i < loud.length; i++) loud[i] = i % 2 === 0 ? 0 : 255; // 交替 0/255，最大振幅

    const result = analyzeMouthOpenness({ timeDomainData: loud, previousValue: 0 });

    expect(result).toBeGreaterThan(0.9);
    expect(result).toBeLessThanOrEqual(1);
  });

  it('gates out very quiet signals below the noise threshold to exactly 0', () => {
    // 128 ± 1，振幅極小（背景噪音等級），不該被當成「有人在講話」
    const veryQuiet = new Uint8Array(64);
    for (let i = 0; i < veryQuiet.length; i++) veryQuiet[i] = i % 2 === 0 ? 127 : 129;

    const result = analyzeMouthOpenness({ timeDomainData: veryQuiet, previousValue: 0 });

    expect(result).toBe(0);
  });

  it('clamps output to 1 even with an extreme gain that would otherwise overshoot', () => {
    // 固定偏移 128+32（振幅 0.25，非交替訊號，RMS 剛好等於 0.25，好預測）；
    // gain=50 的話 0.25*50=12.5，沒有 clamp 的話會遠超過 1。
    const moderate = new Uint8Array(64).fill(128 + 32);

    const result = analyzeMouthOpenness({ timeDomainData: moderate, previousValue: 0, gain: 50 });

    expect(result).toBeLessThanOrEqual(1);
    expect(result).toBe(1);
  });

  it('smooths a sudden drop to silence into a gradual decay instead of an instant jump to 0', () => {
    const silence = new Uint8Array(64).fill(128);

    const result = analyzeMouthOpenness({ timeDomainData: silence, previousValue: 1 });

    // 前一幀是滿開（1），這一幀輸入靜音——平滑後應該介於兩者之間，不是瞬間變 0
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(1);
  });
});
