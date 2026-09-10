/**
 * FFT mixed-radix == DFT naif (docs/26 P0). N = 15 (murni ganjil → DFT
 * langsung), 30 (2 · 15, gabungan), 7680 (nFft Kim_Vocal_2 = 2^9 · 15), dan
 * 1024 (pangkat dua murni → jalur radix-2).
 */
import { describe, expect, it } from 'vitest';

import { createFft, fftForward, fftInverse } from '../fft';
import { mulberry32 } from './signals';

function naiveDft(re: Float64Array, im: Float64Array): { re: Float64Array; im: Float64Array } {
  const n = re.length;
  const outRe = new Float64Array(n);
  const outIm = new Float64Array(n);
  for (let k = 0; k < n; k += 1) {
    let sr = 0;
    let si = 0;
    for (let t = 0; t < n; t += 1) {
      const angle = (-2 * Math.PI * ((k * t) % n)) / n;
      const c = Math.cos(angle);
      const s = Math.sin(angle);
      sr += re[t]! * c - im[t]! * s;
      si += re[t]! * s + im[t]! * c;
    }
    outRe[k] = sr;
    outIm[k] = si;
  }
  return { re: outRe, im: outIm };
}

function randomComplex(n: number, seed: number): { re: Float64Array; im: Float64Array } {
  const rand = mulberry32(seed);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    re[i] = rand() * 2 - 1;
    im[i] = rand() * 2 - 1;
  }
  return { re, im };
}

/** Galat maksimum relatif terhadap magnitudo terbesar hasil DFT. */
function relativeError(a: { re: Float64Array; im: Float64Array }, b: { re: Float64Array; im: Float64Array }): number {
  let maxErr = 0;
  let maxMag = 0;
  for (let i = 0; i < a.re.length; i += 1) {
    maxErr = Math.max(maxErr, Math.hypot(a.re[i]! - b.re[i]!, a.im[i]! - b.im[i]!));
    maxMag = Math.max(maxMag, Math.hypot(a.re[i]!, a.im[i]!));
  }
  return maxErr / maxMag;
}

describe('fft mixed-radix', () => {
  for (const n of [15, 30, 1024, 7680]) {
    it(`N = ${n}: sama dengan DFT naif (toleransi relatif 1e-4)`, () => {
      const input = randomComplex(n, 100 + n);
      const expected = naiveDft(input.re, input.im);
      const plan = createFft(n);
      const re = Float64Array.from(input.re);
      const im = Float64Array.from(input.im);
      fftForward(plan, re, im);
      const err = relativeError(expected, { re, im });
      expect(err).toBeLessThan(1e-4);
      // Presisi Float64 sebenarnya jauh lebih ketat; jaga agar tidak mundur diam-diam.
      expect(err).toBeLessThan(1e-10);
    });

    it(`N = ${n}: inverse(forward(x)) == x`, () => {
      const input = randomComplex(n, 200 + n);
      const plan = createFft(n);
      const re = Float64Array.from(input.re);
      const im = Float64Array.from(input.im);
      fftForward(plan, re, im);
      fftInverse(plan, re, im);
      expect(relativeError(input, { re, im })).toBeLessThan(1e-12);
    });
  }

  it('faktorisasi 7680 = 15 · 512', () => {
    const plan = createFft(7680);
    expect(plan.m).toBe(15);
    expect(plan.p).toBe(512);
  });

  it('impuls di n=0 → spektrum datar 1', () => {
    const plan = createFft(30);
    const re = new Float64Array(30);
    const im = new Float64Array(30);
    re[0] = 1;
    fftForward(plan, re, im);
    for (let k = 0; k < 30; k += 1) {
      expect(re[k]).toBeCloseTo(1, 12);
      expect(im[k]).toBeCloseTo(0, 12);
    }
  });
});
