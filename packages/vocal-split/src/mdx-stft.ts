/**
 * STFT / iSTFT MDX-Net dengan semantik persis kelas `STFT` di UVR dan
 * python-audio-separator (`uvr_lib_v5/stft.py`), docs/26 §1:
 *
 * - window Hann PERIODIK panjang `nFft` (`torch.hann_window(periodic=True)`:
 *   `w[n] = 0.5 − 0.5·cos(2πn/N)`), `hop` 1024;
 * - `center=true` dengan padding REFLEKSI `nFft/2` di kedua sisi (default
 *   `pad_mode='reflect'` torch.stft; sampel tepi tidak diulang);
 * - jumlah frame = `1 + floor(len / hop)` — 256 untuk segmen 261 120 sampel;
 * - forward tak dinormalisasi (`normalized=False`), onesided → 3841 bin, lalu
 *   hanya `dimF` = 3072 bin terbawah yang disimpan;
 * - layout tensor stereo `[1, 4, dimF, frames]`, sumbu channel
 *   `[L.re, L.im, R.re, R.im]` (reshape UVR dari `[B, ch, 2, F, T]`);
 * - inverse: bin yang dibuang diisi nol sampai 3841, `torch.istft` dengan
 *   window yang sama: overlap-add `ifft(X_t)·w`, dibagi jumlah kuadrat window,
 *   lalu padding center dipotong. Bagian imajiner bin DC dan Nyquist diabaikan
 *   seperti transform C2R.
 *
 * Dua channel real dikemas jadi satu FFT kompleks (`z = l + i·r`) dan
 * dipisah lewat simetri Hermitian — separuh biaya dibanding dua FFT real
 * terpisah, dan stereo memang selalu berpasangan di layout ini.
 *
 * Buffer kerja dialokasikan di `createMdxStft` (dan tumbuh sekali bila
 * panjang input lebih besar dari yang pernah dilihat), bukan per frame.
 * Perhitungan di Float64; tensor keluar/masuk Float32 (bentuk yang diterima
 * ORT).
 */

import type { MdxParams } from './catalog';
import { createFft, fftForward, fftInverse, type FftPlan } from './fft';

export type MdxStftParams = Pick<MdxParams, 'nFft' | 'hop' | 'dimF'>;

/** Dimensi tensor `[batch, 4, dimF, frames]` untuk satu segmen stereo. */
export type MdxDims = readonly [number, number, number, number];

export interface MdxStft {
  readonly nFft: number;
  readonly hop: number;
  readonly dimF: number;
  /** `nFft/2 + 1` — 3841 untuk Kim_Vocal_2. */
  readonly nBins: number;
  /** Jumlah frame untuk input sepanjang `length` (center-padded): `1 + floor(length/hop)`. */
  frameCount(length: number): number;
  /** Ukuran tensor `[4, dimF, frames]` dalam elemen. */
  specSize(frames: number): number;
  /**
   * STFT stereo → tensor `[4, dimF, frames]`. `out` (opsional) harus berukuran
   * tepat `specSize(frames)`; kalau tidak diberi, dialokasikan.
   */
  forward(left: Float32Array, right: Float32Array, out?: Float32Array): Float32Array;
  /**
   * iSTFT tensor `[4, dimF, frames]` → `length` sampel per channel ke
   * `outLeft`/`outRight`. `length` default `hop × (frames − 1)`, sama dengan
   * torch.istft tanpa argumen `length`.
   */
  inverse(spec: Float32Array, frames: number, outLeft: Float32Array, outRight: Float32Array, length?: number): void;
}

/** Hann periodik: `0.5 − 0.5·cos(2πn/N)` — `torch.hann_window(N, periodic=True)`. */
export function hannPeriodic(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i += 1) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

/** Indeks elemen `[channel, bin, frame]` dalam tensor `[4, dimF, frames]`. */
export function specIndex(dimF: number, frames: number, channel: number, bin: number, frame: number): number {
  return (channel * dimF + bin) * frames + frame;
}

/**
 * Nol-kan `count` bin terbawah di keempat channel — `spek[:, :, :3, :] *= 0`
 * di `run_model` UVR, dilakukan SEBELUM tensor masuk model.
 */
export function zeroLowBins(spec: Float32Array, dimF: number, frames: number, count = 3): void {
  for (let channel = 0; channel < 4; channel += 1) {
    for (let bin = 0; bin < count; bin += 1) {
      const start = specIndex(dimF, frames, channel, bin, 0);
      spec.fill(0, start, start + frames);
    }
  }
}

/**
 * Padding refleksi ala torch (`reflect`, tanpa mengulang sampel tepi):
 * `[x[h], …, x[1], x[0], x[1], …, x[L−1], x[L−2], …, x[L−1−h]]`.
 * Mensyaratkan `L > h`, sama seperti torch yang menolak padding ≥ dimensi.
 */
function reflectPad(src: Float32Array, length: number, half: number, dst: Float64Array): void {
  if (length <= half) {
    throw new Error(`Input ${length} sampel terlalu pendek untuk padding refleksi ${half}`);
  }
  for (let i = 0; i < half; i += 1) dst[i] = src[half - i]!;
  for (let i = 0; i < length; i += 1) dst[half + i] = src[i]!;
  const tailBase = half + length;
  for (let i = 0; i < half; i += 1) dst[tailBase + i] = src[length - 2 - i]!;
}

export function createMdxStft(params: MdxStftParams): MdxStft {
  const { nFft, hop, dimF } = params;
  if (nFft % 2 !== 0 || hop < 1 || dimF < 1) throw new Error(`Parameter STFT tidak valid: ${JSON.stringify(params)}`);
  const half = nFft / 2;
  const nBins = half + 1;
  if (dimF > nBins) throw new Error(`dimF ${dimF} melebihi jumlah bin ${nBins}`);

  const fft: FftPlan = createFft(nFft);
  const window = hannPeriodic(nFft);
  const re = new Float64Array(nFft);
  const im = new Float64Array(nFft);

  // Buffer yang tumbuh sekali (bukan per frame): sinyal terpad dan hasil
  // overlap-add. Semua segmen produksi berukuran sama, jadi praktis tetap.
  let padLeft = new Float64Array(0);
  let padRight = new Float64Array(0);
  let olaLeft = new Float64Array(0);
  let olaRight = new Float64Array(0);
  let envelope = new Float64Array(0);

  const frameCount = (length: number): number => 1 + Math.floor(length / hop);
  const specSize = (frames: number): number => 4 * dimF * frames;

  function forward(left: Float32Array, right: Float32Array, out?: Float32Array): Float32Array {
    const length = left.length;
    if (right.length !== length) throw new Error(`Panjang channel berbeda: ${length} vs ${right.length}`);
    const frames = frameCount(length);
    const size = specSize(frames);
    const spec = out ?? new Float32Array(size);
    if (spec.length !== size) throw new Error(`Buffer spektrum ${spec.length} ≠ ${size}`);

    const padded = length + nFft;
    if (padLeft.length < padded) {
      padLeft = new Float64Array(padded);
      padRight = new Float64Array(padded);
    }
    reflectPad(left, length, half, padLeft);
    reflectPad(right, length, half, padRight);

    const planeL = 0;
    const planeLi = dimF * frames;
    const planeR = 2 * dimF * frames;
    const planeRi = 3 * dimF * frames;

    for (let t = 0; t < frames; t += 1) {
      const base = t * hop;
      for (let n = 0; n < nFft; n += 1) {
        const w = window[n]!;
        re[n] = padLeft[base + n]! * w;
        im[n] = padRight[base + n]! * w;
      }
      fftForward(fft, re, im);
      // z = l + i·r → L[k] = (Z[k] + conj Z[N−k]) / 2, R[k] = (Z[k] − conj Z[N−k]) / 2i.
      for (let k = 0; k < dimF; k += 1) {
        const mirror = k === 0 ? 0 : nFft - k;
        const zr = re[k]!;
        const zi = im[k]!;
        const mr = re[mirror]!;
        const mi = im[mirror]!;
        const column = k * frames + t;
        spec[planeL + column] = 0.5 * (zr + mr);
        spec[planeLi + column] = 0.5 * (zi - mi);
        spec[planeR + column] = 0.5 * (zi + mi);
        spec[planeRi + column] = 0.5 * (mr - zr);
      }
    }
    return spec;
  }

  function inverse(
    spec: Float32Array,
    frames: number,
    outLeft: Float32Array,
    outRight: Float32Array,
    length: number = hop * (frames - 1),
  ): void {
    if (frames < 1) throw new Error('iSTFT butuh minimal satu frame');
    if (spec.length !== specSize(frames)) throw new Error(`Buffer spektrum ${spec.length} ≠ ${specSize(frames)}`);
    if (outLeft.length < length || outRight.length < length) {
      throw new Error(`Buffer keluaran lebih pendek dari ${length}`);
    }
    const padded = (frames - 1) * hop + nFft;
    if (length + half > padded) {
      throw new Error(`Panjang ${length} melebihi cakupan ${frames} frame`);
    }
    if (olaLeft.length < padded) {
      olaLeft = new Float64Array(padded);
      olaRight = new Float64Array(padded);
      envelope = new Float64Array(padded);
    } else {
      olaLeft.fill(0, 0, padded);
      olaRight.fill(0, 0, padded);
      envelope.fill(0, 0, padded);
    }

    const planeL = 0;
    const planeLi = dimF * frames;
    const planeR = 2 * dimF * frames;
    const planeRi = 3 * dimF * frames;

    for (let t = 0; t < frames; t += 1) {
      // Z[k] = L[k] + i·R[k] untuk k ∈ [0, N/2]; sisanya lewat simetri
      // Hermitian masing-masing channel: Z[N−k] = conj L[k] + i·conj R[k].
      for (let k = 0; k < nBins; k += 1) {
        let lr = 0;
        let li = 0;
        let rr = 0;
        let ri = 0;
        if (k < dimF) {
          const column = k * frames + t;
          lr = spec[planeL + column]!;
          li = spec[planeLi + column]!;
          rr = spec[planeR + column]!;
          ri = spec[planeRi + column]!;
        }
        if (k === 0 || k === half) {
          li = 0;
          ri = 0;
        }
        re[k] = lr - ri;
        im[k] = li + rr;
        if (k > 0 && k < half) {
          re[nFft - k] = lr + ri;
          im[nFft - k] = rr - li;
        }
      }
      fftInverse(fft, re, im);
      const base = t * hop;
      for (let n = 0; n < nFft; n += 1) {
        const w = window[n]!;
        olaLeft[base + n] = olaLeft[base + n]! + re[n]! * w;
        olaRight[base + n] = olaRight[base + n]! + im[n]! * w;
        envelope[base + n] = envelope[base + n]! + w * w;
      }
    }

    // Normalisasi jumlah kuadrat window lalu potong padding center. torch
    // menolak (NOLA) bila envelope ≈ 0; di sini sampel itu dibiarkan 0.
    for (let n = 0; n < length; n += 1) {
      const e = envelope[n + half]!;
      if (e > 1e-11) {
        outLeft[n] = olaLeft[n + half]! / e;
        outRight[n] = olaRight[n + half]! / e;
      } else {
        outLeft[n] = 0;
        outRight[n] = 0;
      }
    }
  }

  return { nFft, hop, dimF, nBins, frameCount, specSize, forward, inverse };
}
