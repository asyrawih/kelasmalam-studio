/**
 * Pipa segmen MDX-Net — `demix` + `run_model` python-audio-separator,
 * docs/26 §1 dan §6 P0. Model DISUNTIK (`MdxModel`) supaya transform bisa
 * dibuktikan sendiri dengan model identitas sebelum ONNX disentuh: jangan
 * pernah men-debug model dan transform sekaligus.
 *
 * Urutan, semua angka dari `MdxParams` (Kim_Vocal_2 dalam kurung):
 *
 * 1. `segment = hop × (2^dimT − 1)` (261 120), `trim = nFft/2` (3840),
 *    `gen = segment − 2·trim`. Mix dipad `trim` nol di depan dan
 *    `gen + trim − (len mod gen)` nol di belakang.
 * 2. `step = floor((1 − overlap) × segment)`. Segmen diambil dari tiap
 *    kelipatan `step`; segmen terakhir yang lebih pendek dipad nol sampai
 *    `segment` sebelum STFT (bentuk tensor harus tetap `[1, 4, dimF, 256]`).
 * 3. Tiap segmen: STFT → nol-kan 3 bin terbawah → model → iSTFT. `denoise`:
 *    model dijalankan pada `x` dan `−x`, hasil `(y⁺ − y⁻)/2`.
 * 4. overlap 0: hasil ditambah apa adanya, `divider += 1`. overlap > 0:
 *    hasil dikalikan `np.hanning(panjang aktual)` (Hann SIMETRIS, nol di
 *    kedua ujung) dan `divider += window`. Hasil akhir = akumulasi / divider;
 *    di sampel yang divider-nya nol (ujung window) hasil 0 — sampel itu
 *    selalu berada di area trim/pad, jadi tidak pernah terlihat.
 * 5. Potong `trim` di depan, ambil `len` sampel: itu vokal. Instrumental =
 *    `mix − vokal × compensate` (1.009) di domain waktu.
 *
 * Progres dilaporkan per segmen; `signal` diperiksa sebelum tiap segmen dan
 * setelah model kembali, melempar `DOMException` `AbortError`. Setelah tiap
 * segmen ada `await` ke macrotask supaya event loop worker tidak terblokir
 * lebih dari satu segmen (model identitas di tes selesai secara sinkron).
 */

import { framesPerSegment, samplesPerSegment, segmentTrim, type MdxParams } from './catalog';
import { createMdxStft, zeroLowBins, type MdxDims } from './mdx-stft';

/**
 * Model MDX: tensor masuk `[1, 4, dimF, frames]` → tensor keluar dengan layout
 * yang sama. Implementasi ORT ada di `mdx-model.ts` (P1+); tes memakai
 * identitas.
 */
export type MdxModel = (input: Float32Array, dims: MdxDims) => Promise<Float32Array>;

export type MdxOverlap = 0 | 0.25 | 0.5;

export interface StereoPcm {
  readonly left: Float32Array;
  readonly right: Float32Array;
}

export interface MdxSeparateOptions {
  readonly overlap: MdxOverlap;
  readonly denoise: boolean;
  /** `false` → instrumental = `mix − vokal` tanpa pengali `params.compensate`. Default `true`. */
  readonly compensate?: boolean;
  readonly onProgress?: (done: number, total: number) => void;
  readonly signal?: AbortSignal;
}

export interface MdxSeparateResult {
  readonly vocals: StereoPcm;
  readonly instrumental: StereoPcm;
}

/** `np.hanning(n)`: Hann simetris `0.5 − 0.5·cos(2πk/(n−1))`; `n = 1` → `[1]`. */
export function hanningSymmetric(n: number): Float64Array {
  const w = new Float64Array(n);
  if (n === 1) {
    w[0] = 1;
    return w;
  }
  for (let k = 0; k < n; k += 1) w[k] = 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (n - 1));
  return w;
}

/** Panjang mix setelah pad depan `trim` dan pad belakang `gen + trim − (len mod gen)`. */
export function paddedLength(length: number, params: MdxParams): number {
  const segment = samplesPerSegment(params);
  const trim = segmentTrim(params);
  const gen = segment - 2 * trim;
  const pad = gen + trim - (length % gen);
  return trim + length + pad;
}

export function segmentStep(params: MdxParams, overlap: MdxOverlap): number {
  return Math.floor((1 - overlap) * samplesPerSegment(params));
}

/** Jumlah segmen = jumlah laporan progres: `ceil(paddedLength / step)`. */
export function segmentCount(length: number, params: MdxParams, overlap: MdxOverlap): number {
  return Math.ceil(paddedLength(length, params) / segmentStep(params, overlap));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException('Vocal split dibatalkan', 'AbortError');
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export async function separateMdx(
  left: Float32Array,
  right: Float32Array,
  params: MdxParams,
  model: MdxModel,
  options: MdxSeparateOptions,
): Promise<MdxSeparateResult> {
  const length = left.length;
  if (right.length !== length) throw new Error(`Panjang channel berbeda: ${length} vs ${right.length}`);
  const { overlap, denoise, signal, onProgress } = options;
  const compensate = options.compensate === false ? 1 : params.compensate;

  const segment = samplesPerSegment(params);
  const frames = framesPerSegment(params);
  const trim = segmentTrim(params);
  const total = paddedLength(length, params);
  const step = segmentStep(params, overlap);
  const dims: MdxDims = [1, 4, params.dimF, frames];
  const stft = createMdxStft(params);

  throwIfAborted(signal);

  // Mix terpad: [nol × trim, mix, nol × pad].
  const mixLeft = new Float32Array(total);
  const mixRight = new Float32Array(total);
  mixLeft.set(left, trim);
  mixRight.set(right, trim);

  const accLeft = new Float64Array(total);
  const accRight = new Float64Array(total);
  const divider = new Float64Array(total);

  // Buffer per segmen, dialokasikan sekali.
  const segLeft = new Float32Array(segment);
  const segRight = new Float32Array(segment);
  const outLeft = new Float32Array(segment);
  const outRight = new Float32Array(segment);
  const spec = new Float32Array(stft.specSize(frames));
  const negated = denoise ? new Float32Array(spec.length) : null;
  let fullWindow: Float64Array | null = null;

  const segments = Math.ceil(total / step);
  let done = 0;
  for (let start = 0; start < total; start += step) {
    throwIfAborted(signal);
    const end = Math.min(start + segment, total);
    const actual = end - start;

    segLeft.fill(0);
    segRight.fill(0);
    segLeft.set(mixLeft.subarray(start, end));
    segRight.set(mixRight.subarray(start, end));

    stft.forward(segLeft, segRight, spec);
    zeroLowBins(spec, params.dimF, frames);

    let predicted: Float32Array;
    if (negated) {
      for (let i = 0; i < spec.length; i += 1) negated[i] = -spec[i]!;
      const positive = await model(spec, dims);
      throwIfAborted(signal);
      const negative = await model(negated, dims);
      predicted = positive;
      for (let i = 0; i < predicted.length; i += 1) {
        predicted[i] = 0.5 * predicted[i]! - 0.5 * negative[i]!;
      }
    } else {
      predicted = await model(spec, dims);
    }
    throwIfAborted(signal);
    if (predicted.length !== spec.length) {
      throw new Error(`Model mengembalikan ${predicted.length} elemen, diharapkan ${spec.length}`);
    }

    stft.inverse(predicted, frames, outLeft, outRight);

    if (overlap === 0) {
      for (let n = 0; n < actual; n += 1) {
        accLeft[start + n] = accLeft[start + n]! + outLeft[n]!;
        accRight[start + n] = accRight[start + n]! + outRight[n]!;
        divider[start + n] = divider[start + n]! + 1;
      }
    } else {
      let window: Float64Array;
      if (actual === segment) {
        fullWindow ??= hanningSymmetric(segment);
        window = fullWindow;
      } else {
        window = hanningSymmetric(actual);
      }
      for (let n = 0; n < actual; n += 1) {
        const w = window[n]!;
        accLeft[start + n] = accLeft[start + n]! + outLeft[n]! * w;
        accRight[start + n] = accRight[start + n]! + outRight[n]! * w;
        divider[start + n] = divider[start + n]! + w;
      }
    }

    done += 1;
    onProgress?.(done, segments);
    await yieldToEventLoop();
  }

  const vocalsLeft = new Float32Array(length);
  const vocalsRight = new Float32Array(length);
  const instLeft = new Float32Array(length);
  const instRight = new Float32Array(length);
  for (let n = 0; n < length; n += 1) {
    const d = divider[trim + n]!;
    const vl = d > 0 ? accLeft[trim + n]! / d : 0;
    const vr = d > 0 ? accRight[trim + n]! / d : 0;
    vocalsLeft[n] = vl;
    vocalsRight[n] = vr;
    instLeft[n] = left[n]! - vl * compensate;
    instRight[n] = right[n]! - vr * compensate;
  }

  return {
    vocals: { left: vocalsLeft, right: vocalsRight },
    instrumental: { left: instLeft, right: instRight },
  };
}
