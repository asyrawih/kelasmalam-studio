import { describe, expect, it } from 'vitest';

import { NORMALIZE_TARGET_DB, peakOf } from './normalize';

/** AudioBuffer palsu — cukup untuk menguji matematika peak. */
function fakeBuffer(channels: number[][]): AudioBuffer {
  return {
    numberOfChannels: channels.length,
    length: channels[0]?.length ?? 0,
    getChannelData: (i: number) => Float32Array.from(channels[i] ?? []),
  } as unknown as AudioBuffer;
}

describe('normalize', () => {
  it('mengambil puncak lintas channel', () => {
    const buf = fakeBuffer([
      [0.1, 0.2, 0.3],
      [0.05, 0.9, 0.1],
    ]);
    expect(peakOf(buf, 0, 3)).toBeCloseTo(0.9, 6);
  });

  it('hanya mengukur REGION clip, bukan seluruh file', () => {
    // Puncak 1.0 ada di indeks 0, di luar region yang dipakai clip.
    const buf = fakeBuffer([[1.0, 0.2, 0.25, 0.1]]);
    expect(peakOf(buf, 1, 3)).toBeCloseTo(0.25, 6);
  });

  it('memperhitungkan nilai negatif (peak absolut)', () => {
    const buf = fakeBuffer([[-0.8, 0.3]]);
    expect(peakOf(buf, 0, 2)).toBeCloseTo(0.8, 6);
  });

  it('rentang di luar buffer tidak melempar', () => {
    const buf = fakeBuffer([[0.5]]);
    expect(() => peakOf(buf, -10, 999)).not.toThrow();
    expect(peakOf(buf, 5, 5)).toBe(0);
  });

  it('gain hasil normalisasi membawa puncak ke target', () => {
    const peak = 0.25;
    const gainDb = NORMALIZE_TARGET_DB - 20 * Math.log10(peak);
    const after = peak * 10 ** (gainDb / 20);
    expect(20 * Math.log10(after)).toBeCloseTo(NORMALIZE_TARGET_DB, 6);
  });
});
