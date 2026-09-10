/**
 * Null-test pipa segmen `separateMdx` dengan model identitas (docs/26 P0).
 *
 * Dengan model identitas, satu-satunya perubahan spektral adalah yang memang
 * disengaja pipa MDX: crop dimF 3072 dan `spek[:, :, :3, :] = 0`. Sinyal uji
 * dibuat band-limited (300 Hz – 12 kHz, fade in/out) supaya keduanya tidak
 * mengubah isi sinyal; yang tersisa untuk diuji adalah penjahitan: pad,
 * trim, overlap + Hann, divider, panjang, compensate, denoise, abort.
 *
 * Catatan overlap 0 (diukur, lihat laporan P0): potongan keras + padding
 * refleksi membuat patahan di tepi tiap segmen; nol-kan 3 bin pada frame
 * yang melintasi tepi itu menghasilkan galat sub-17 Hz sepanjang ±nFft dari
 * tepi, lebih panjang dari `trim` 3840. Pada overlap 0 `demix` menumpuk
 * keluaran segmen UTUH (trim hanya dipotong di tepi global), sehingga batas
 * interior `k·segment − trim` membawa artefak ini apa adanya — sifat
 * algoritma rujukan (alasan UVR default 0,25), bukan bug jahitan. Maka
 * overlap 0 diuji > 100 dB di luar jendela ±nFft sekitar batas interior dan
 * > 55 dB keseluruhan (terukur ≈ 62–65 dB); overlap 0,25 dan 0,5 > 100 dB
 * di semua sampel karena jendela Hann jahitan menekan frame tepi.
 */
import { describe, expect, it, vi } from 'vitest';

// Tes ini mengolah puluhan detik audio dengan FFT murni JS; di runner CI
// (2 vCPU) satu kasus bisa > 5 s — bawaan vitest. Batas per berkas, bukan
// per kasus, supaya kasus baru tidak lupa memakainya.
vi.setConfig({ testTimeout: 60_000 });

import { VOCAL_MODELS, samplesPerSegment, segmentTrim } from '../catalog';
import {
  hanningSymmetric,
  paddedLength,
  segmentCount,
  segmentStep,
  separateMdx,
  type MdxModel,
  type MdxOverlap,
} from '../mdx-separate';
import { bandLimitedStereo, snrDb } from './signals';

const KIM = VOCAL_MODELS['kim-vocal-2'].mdx;
const SR = 44_100;
const SECONDS = 30;
const SEGMENT = samplesPerSegment(KIM);
const TRIM = segmentTrim(KIM);

const identity: MdxModel = async (input, dims) => {
  expect(dims).toEqual([1, 4, 3072, 256]);
  expect(input.length).toBe(4 * 3072 * 256);
  return input;
};

/** Identitas yang menyalin, supaya mutasi in-place di jalur denoise tidak menyentuh input. */
const identityCopy: MdxModel = async (input) => Float32Array.from(input);

/** Sinyal band-limited 30 detik, dibuat sekali (pembangkitannya yang paling mahal). */
const song = bandLimitedStereo(SR * SECONDS, { seed: 21 });

/** SNR terburuk di jendela-jendela `width` sampel (sambungan segmen, tepi). */
function worstWindowSnr(ref: Float32Array, got: Float32Array, width: number): number {
  let worst = Number.POSITIVE_INFINITY;
  for (let start = 0; start < ref.length; start += width) {
    const end = Math.min(start + width, ref.length);
    worst = Math.min(worst, snrDb(ref.subarray(start, end), got.subarray(start, end)));
  }
  return worst;
}

/**
 * SNR hanya pada sampel yang berjarak ≥ `margin` dari batas interior segmen
 * (`k·step − trim` dalam koordinat mix, k ≥ 1). Tepi awal/akhir sinyal
 * TIDAK dikecualikan — itu justru yang dijaga trim.
 */
function snrOutsideBoundaries(ref: Float32Array, got: Float32Array, overlap: MdxOverlap, margin: number): number {
  const step = segmentStep(KIM, overlap);
  const excluded = new Uint8Array(ref.length);
  for (let boundary = step - TRIM; boundary < ref.length; boundary += step) {
    excluded.fill(1, Math.max(0, boundary - margin), Math.min(ref.length, boundary + margin));
  }
  let signal = 0;
  let noise = 0;
  let kept = 0;
  for (let n = 0; n < ref.length; n += 1) {
    if (excluded[n]) continue;
    kept += 1;
    signal += ref[n]! * ref[n]!;
    noise += (ref[n]! - got[n]!) ** 2;
  }
  expect(kept).toBeGreaterThan(ref.length / 2);
  return 10 * Math.log10(signal / noise);
}

describe('separateMdx dengan model identitas', () => {
  it('hanningSymmetric == np.hanning', () => {
    expect(Array.from(hanningSymmetric(1))).toEqual([1]);
    const w = hanningSymmetric(5);
    expect(w[0]).toBeCloseTo(0, 15);
    expect(w[2]).toBeCloseTo(1, 15);
    expect(w[4]).toBeCloseTo(0, 15);
    expect(w[1]).toBeCloseTo(0.5, 15);
  });

  it('paddedLength / segmentCount mengikuti demix', () => {
    const gen = SEGMENT - 2 * TRIM;
    const len = SR * 240; // lagu 4 menit
    expect(paddedLength(len, KIM)).toBe(TRIM + len + gen + TRIM - (len % gen));
    // docs/26 §1: ≈ 41 segmen tanpa overlap, ≈ 55 dengan 0,25.
    expect(segmentCount(len, KIM, 0)).toBe(41);
    expect(segmentCount(len, KIM, 0.25)).toBe(55);
    expect(segmentStep(KIM, 0.25)).toBe(195_840);
    expect(segmentStep(KIM, 0.5)).toBe(130_560);
  });

  for (const overlap of [0, 0.25, 0.5] as const) {
    it(`overlap ${overlap}: vokal ≈ input 30 detik, inst = mix × (1 − 1.009), progres per segmen`, async () => {
      const progress: Array<[number, number]> = [];
      const before = performance.now();
      const result = await separateMdx(song.left, song.right, KIM, identity, {
        overlap,
        denoise: false,
        onProgress: (done, total) => progress.push([done, total]),
      });
      const ms = performance.now() - before;
      expect(result.vocals.left.length).toBe(song.left.length);
      expect(result.vocals.right.length).toBe(song.left.length);

      const snrL = snrDb(song.left, result.vocals.left);
      const snrR = snrDb(song.right, result.vocals.right);
      const worst = Math.min(
        worstWindowSnr(song.left, result.vocals.left, SR),
        worstWindowSnr(song.right, result.vocals.right, SR),
      );
      const edge = Math.min(
        snrDb(song.left.subarray(0, 4096), result.vocals.left.subarray(0, 4096)),
        snrDb(song.left.subarray(-4096), result.vocals.left.subarray(-4096)),
        snrDb(song.right.subarray(0, 4096), result.vocals.right.subarray(0, 4096)),
        snrDb(song.right.subarray(-4096), result.vocals.right.subarray(-4096)),
      );
      const outside = Math.min(
        snrOutsideBoundaries(song.left, result.vocals.left, overlap, KIM.nFft),
        snrOutsideBoundaries(song.right, result.vocals.right, overlap, KIM.nFft),
      );
      console.info(
        `[segment-stitch] overlap ${overlap}: SNR L ${snrL.toFixed(1)} dB, R ${snrR.toFixed(1)} dB, ` +
          `terburuk/1 s ${worst.toFixed(1)} dB, tepi 4096 ${edge.toFixed(1)} dB, ` +
          `di luar ±nFft batas interior ${outside.toFixed(1)} dB, ${progress.length} segmen, ${ms.toFixed(0)} ms`,
      );
      // Tepi awal/akhir dan segala sesuatu di luar batas interior: eksak.
      expect(edge).toBeGreaterThan(100);
      expect(outside).toBeGreaterThan(100);
      if (overlap === 0) {
        // Artefak tepi 3-bin algoritma rujukan (lihat catatan di atas).
        expect(snrL).toBeGreaterThan(55);
        expect(snrR).toBeGreaterThan(55);
      } else {
        expect(snrL).toBeGreaterThan(100);
        expect(snrR).toBeGreaterThan(100);
        expect(worst).toBeGreaterThan(100);
      }

      // Instrumental = mix − vokal × 1.009 ≈ mix × (1 − 1.009); galat vokal
      // ε menjadi ε × 1.009 relatif terhadap sinyal yang 0.009 × mix, jadi
      // ambangnya SNR vokal − 41 dB.
      const expectedInstL = Float32Array.from(song.left, (v) => v * (1 - KIM.compensate));
      const expectedInstR = Float32Array.from(song.right, (v) => v * (1 - KIM.compensate));
      const instSnr = Math.min(
        snrDb(expectedInstL, result.instrumental.left),
        snrDb(expectedInstR, result.instrumental.right),
      );
      expect(instSnr).toBeGreaterThan(overlap === 0 ? 10 : 55);
      // Dan identitas aljabar inst = mix − vokal × c berlaku persis per sampel.
      for (let n = 0; n < song.left.length; n += 1000) {
        expect(result.instrumental.left[n]).toBeCloseTo(song.left[n]! - result.vocals.left[n]! * KIM.compensate, 6);
      }

      const total = segmentCount(song.left.length, KIM, overlap);
      expect(progress.length).toBe(total);
      expect(progress.at(-1)).toEqual([total, total]);
      expect(progress.map(([d]) => d)).toEqual(progress.map((_, i) => i + 1));
    }, 60_000);
  }

  it('compensate: false → instrumental = mix − vokal tanpa pengali', async () => {
    const short = bandLimitedStereo(SR * 2, { seed: 4 });
    const result = await separateMdx(short.left, short.right, KIM, identity, {
      overlap: 0.25,
      denoise: false,
      compensate: false,
    });
    let peak = 0;
    for (let n = 0; n < short.left.length; n += 1) {
      peak = Math.max(peak, Math.abs(result.instrumental.left[n]!), Math.abs(result.instrumental.right[n]!));
    }
    // mix − vokal ≈ 0 pada −100 dB relatif amplitudo ~0,5.
    expect(peak).toBeLessThan(1e-4);
  });

  it('panjang aneh: 1, 261 120, 261 121 sampel → panjang keluaran == masukan, isi utuh', async () => {
    for (const length of [1, SEGMENT, SEGMENT + 1]) {
      const input = bandLimitedStereo(length, { seed: length, fadeSeconds: 0.05 });
      for (const overlap of [0, 0.25] as const) {
        const result = await separateMdx(input.left, input.right, KIM, identity, { overlap, denoise: false });
        expect(result.vocals.left.length).toBe(length);
        expect(result.vocals.right.length).toBe(length);
        expect(result.instrumental.left.length).toBe(length);
        expect(result.instrumental.right.length).toBe(length);
        let finite = true;
        for (let n = 0; n < length; n += 1) {
          finite &&= Number.isFinite(result.vocals.left[n]!) && Number.isFinite(result.instrumental.right[n]!);
        }
        expect(finite).toBe(true);
        if (length > 1) {
          const snr = snrDb(input.left, result.vocals.left);
          const outside = snrOutsideBoundaries(input.left, result.vocals.left, overlap, KIM.nFft);
          console.info(`[segment-stitch] panjang ${length}, overlap ${overlap}: SNR ${snr.toFixed(1)} dB, di luar batas ${outside.toFixed(1)} dB`);
          expect(outside).toBeGreaterThan(100);
          expect(snr).toBeGreaterThan(overlap === 0 ? 55 : 100);
        }
      }
    }
  }, 60_000);

  it('denoise dengan model identitas tetap identitas', async () => {
    const short = bandLimitedStereo(SR * 3, { seed: 33 });
    let calls = 0;
    const counting: MdxModel = async (input, dims) => {
      calls += 1;
      return identityCopy(input, dims);
    };
    const result = await separateMdx(short.left, short.right, KIM, counting, { overlap: 0.25, denoise: true });
    const total = segmentCount(short.left.length, KIM, 0.25);
    expect(calls).toBe(2 * total);
    const snr = snrDb(short.left, result.vocals.left);
    console.info(`[segment-stitch] denoise identitas 3 s: SNR ${snr.toFixed(1)} dB`);
    expect(snr).toBeGreaterThan(100);
  });

  it('denoise membatalkan komponen genap model: y = x + 0.1·|x| → x', async () => {
    const short = bandLimitedStereo(SR * 2, { seed: 8 });
    const even: MdxModel = async (input) => Float32Array.from(input, (v) => v + 0.1 * Math.abs(v));
    const plain = await separateMdx(short.left, short.right, KIM, even, { overlap: 0.25, denoise: false });
    const denoised = await separateMdx(short.left, short.right, KIM, even, { overlap: 0.25, denoise: true });
    const before = snrDb(short.left, plain.vocals.left);
    const after = snrDb(short.left, denoised.vocals.left);
    console.info(`[segment-stitch] model genap: tanpa denoise ${before.toFixed(1)} dB, dengan denoise ${after.toFixed(1)} dB`);
    expect(before).toBeLessThan(60);
    expect(after).toBeGreaterThan(100);
  });

  it('abort di tengah melempar AbortError dan onProgress berhenti', async () => {
    const controller = new AbortController();
    let progressCalls = 0;
    const model: MdxModel = async (input) => {
      if (progressCalls === 2) controller.abort();
      return input;
    };
    const run = separateMdx(song.left, song.right, KIM, model, {
      overlap: 0,
      denoise: false,
      signal: controller.signal,
      onProgress: () => { progressCalls += 1; },
    });
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    await expect(run).rejects.toBeInstanceOf(DOMException);
    expect(progressCalls).toBe(2);
    // Tidak ada laporan progres susulan setelah penolakan.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(progressCalls).toBe(2);
  });

  it('signal yang sudah aborted sebelum mulai → langsung AbortError, model tidak dipanggil', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const model: MdxModel = async (input) => { calls += 1; return input; };
    await expect(
      separateMdx(song.left, song.right, KIM, model, { overlap: 0, denoise: false, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(0);
  });

  it('nol-kan 3 bin: energi DC/sub-17 Hz hilang dari vokal, nada 1 kHz utuh', async () => {
    const length = SR * 3;
    const left = new Float32Array(length);
    const right = new Float32Array(length);
    // Offset DC 0,3 + sinus 5 Hz (bin < 1) + nada 1 kHz.
    for (let n = 0; n < length; n += 1) {
      const lf = 0.3 + 0.3 * Math.sin((2 * Math.PI * 5 * n) / SR);
      const tone = 0.3 * Math.sin((2 * Math.PI * 1000 * n) / SR);
      left[n] = lf + tone;
      right[n] = lf - tone;
    }
    const result = await separateMdx(left, right, KIM, identity, { overlap: 0.5, denoise: false });
    // Rata-rata (≈ komponen DC) di tengah sinyal harus jauh berkurang.
    const mid = result.vocals.left.subarray(SR, SR * 2);
    let meanIn = 0;
    let meanOut = 0;
    for (let n = 0; n < mid.length; n += 1) {
      meanIn += left[SR + n]!;
      meanOut += mid[n]!;
    }
    meanIn /= mid.length;
    meanOut /= mid.length;
    console.info(`[segment-stitch] DC masuk ${meanIn.toFixed(4)}, DC keluar ${meanOut.toFixed(4)}`);
    expect(Math.abs(meanIn)).toBeGreaterThan(0.25);
    expect(Math.abs(meanOut)).toBeLessThan(0.02);
    // Nada 1 kHz tetap ada: proyeksi ke nada asli ≈ 1.
    let dot = 0;
    let energy = 0;
    for (let n = 0; n < mid.length; n += 1) {
      const tone = 0.3 * Math.sin((2 * Math.PI * 1000 * (SR + n)) / SR);
      dot += tone * mid[n]!;
      energy += tone * tone;
    }
    expect(dot / energy).toBeCloseTo(1, 2);
  });
});
