import { describe, expect, it } from 'vitest';

import { buildEnvelope } from './envelope';
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

describe('peakOf lewat peak pyramid', () => {
  /**
   * Sinyal panjang dengan puncak yang SENGAJA ditaruh di dalam bucket yang
   * hanya tersentuh sebagian, supaya jalur cepat ketahuan kalau ia membulatkan
   * rentang ke batas bucket terdekat.
   */
  function longSignal(n: number): number[] {
    const a = new Array<number>(n);
    for (let i = 0; i < n; i += 1) a[i] = Math.sin(i * 0.01) * 0.4;
    a[5_000] = 0.99; // di luar region yang diuji — TIDAK boleh ikut terhitung
    a[9_001] = 0.77; // tepat setelah batas bucket 64 (9.001 = 140×64 + 41)
    a[20_478] = -0.85;
    return a;
  }

  const N = 30_000;
  const data = longSignal(N);
  const buf = fakeBuffer([data]);
  const env = buildEnvelope({
    numberOfChannels: 1,
    length: N,
    sampleRate: 48_000,
    getChannelData: () => Float32Array.from(data),
  });

  it('hasilnya IDENTIK dengan pemindaian penuh, termasuk di tepi yang tidak rata bucket', () => {
    // Rentang dipilih supaya kedua tepinya jatuh di tengah bucket, dan supaya
    // puncak 0,99 di sample 5.000 berada tepat di luar sebagian di antaranya.
    const ranges: [number, number][] = [
      [0, N],
      [4_999, 2],
      [5_001, 4_000],
      [8_900, 200],
      [9_002, 11_000],
      [20_000, 1_000],
      [1, N - 2],
      [12_345, 7],
    ];
    for (const [from, len] of ranges) {
      expect(peakOf(buf, from, len, env)).toBeCloseTo(peakOf(buf, from, len), 6);
    }
  });

  it('puncak di luar region tidak ikut terbawa hanya karena satu bucket dengannya', () => {
    // Sample 5.000 ada di bucket 78 (78×64 = 4.992). Region di bawah dimulai
    // SETELAH sample itu tapi masih di dalam bucket yang sama — kalau bucket
    // parsial dipakai apa adanya, 0,99 akan bocor masuk.
    const peak = peakOf(buf, 5_001, 3_000, env);
    expect(peak).toBeLessThan(0.99);
    expect(peak).toBeCloseTo(peakOf(buf, 5_001, 3_000), 6);
  });

  it('envelope yang tidak sepadan dengan buffer diabaikan, bukan dipercaya', () => {
    const other = buildEnvelope({
      numberOfChannels: 1,
      length: 100,
      sampleRate: 48_000,
      getChannelData: () => new Float32Array(100),
    });
    // Kalau envelope asing dipakai, hasilnya akan 0 — bukan puncak sebenarnya.
    expect(peakOf(buf, 0, N, other)).toBeCloseTo(peakOf(buf, 0, N), 6);
  });
});
