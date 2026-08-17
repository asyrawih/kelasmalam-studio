/**
 * Sumber data waveform untuk semua canvas.
 *
 * Bentuk datanya mengikuti peak pyramid di docs/06 §6c: bucket 64 / 512 / 4096
 * sample, masing-masing menyimpan pasangan (min,max) f32. Pemilihan level
 * dilakukan dari `samples_per_pixel`, persis seperti tabel di doc itu.
 *
 * DARI MANA DATANYA SEKARANG: `EngineClient` belum mengekspos view ke WASM
 * linear memory (tidak ada `memoryView`), dan pipeline import belum ada, jadi
 * asset dengan `peakPtr === 0` memakai generator DETERMINISTIK yang meniru
 * fungsi `wave()` di design file — hash sin yang sama, envelope yang sama.
 * Hasilnya: bentuk gelombang di layar identik dengan design, dan jalur kode
 * penggambarnya sudah jalur yang sebenarnya.
 *
 * Saat pyramid asli tersedia, satu-satunya yang berubah adalah `buildPyramid`:
 * ia membaca Float32Array dari WASM memory (divalidasi terhadap
 * `memGeneration`, docs/05 §WASM memory growth) alih-alih membangkitkan.
 */

import type { AudioAsset } from '../../state/model';

export const BUCKET_SIZES = [64, 512, 4096] as const;

export interface PeakPyramid {
  /** Per level: [min0, max0, min1, max1, …] dengan panjang 2 × jumlah bucket. */
  readonly levels: readonly Float32Array[];
  readonly lengthSamples: number;
}

/** Hash yang sama dengan `rnd(i)` di design file — supaya bentuknya cocok. */
function rnd(i: number): number {
  const x = Math.sin(i * 127.1 + 3.7) * 43758.5453;
  return x - Math.floor(x);
}

/** Envelope yang sama dengan `wave(n, seed, shape)` di design. */
function envelopeAt(t: number, shape: 'tone' | 'perc'): number {
  if (shape === 'perc') return Math.pow(1 - t, 1.6) * (t < 0.02 ? t / 0.02 : 1);
  return 0.35 + 0.65 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.05)), 0.55);
}

function buildSynthetic(lengthSamples: number, seed: number, shape: 'tone' | 'perc'): PeakPyramid {
  const levels: Float32Array[] = [];
  for (let li = 0; li < BUCKET_SIZES.length; li++) {
    const bucket = BUCKET_SIZES[li]!;
    const count = Math.max(1, Math.ceil(lengthSamples / bucket));
    const data = new Float32Array(count * 2);
    if (li === 0) {
      for (let i = 0; i < count; i++) {
        const t = count === 1 ? 0 : i / (count - 1);
        const amp = envelopeAt(t, shape) * (0.45 + 0.55 * rnd(i + seed * 91));
        data[i * 2] = -amp;
        data[i * 2 + 1] = amp;
      }
    } else {
      // Level di atas dibangun dari level di bawahnya (min dari min, max dari
      // max) — 1.14 × N kerja total, bukan 3 × N (docs/06 §6c).
      const prev = levels[li - 1]!;
      const ratio = BUCKET_SIZES[li]! / BUCKET_SIZES[li - 1]!;
      for (let i = 0; i < count; i++) {
        let lo = 0;
        let hi = 0;
        for (let k = 0; k < ratio; k++) {
          const j = i * ratio + k;
          if (j * 2 + 1 >= prev.length) break;
          lo = Math.min(lo, prev[j * 2]!);
          hi = Math.max(hi, prev[j * 2 + 1]!);
        }
        data[i * 2] = lo;
        data[i * 2 + 1] = hi;
      }
    }
    levels.push(data);
  }
  return { levels, lengthSamples };
}

const cache = new Map<number, PeakPyramid>();

export function getPeakPyramid(asset: AudioAsset): PeakPyramid {
  const hit = cache.get(asset.id);
  if (hit !== undefined && hit.lengthSamples === asset.lengthSamples) return hit;
  // `perc` untuk track drum/FX pendek, `tone` untuk sisanya — sama seperti
  // design memakai waveAlt (perc) untuk clip kecil dan waveMain untuk panel.
  const shape: 'tone' | 'perc' = asset.lengthSamples < asset.sampleRate * 4 ? 'perc' : 'tone';
  const built = buildSynthetic(asset.lengthSamples, asset.id + 2, shape);
  cache.set(asset.id, built);
  return built;
}

/** Level pyramid untuk `samplesPerPixel` — tabel dari docs/06 §6c. */
export function levelFor(samplesPerPixel: number): number {
  if (samplesPerPixel >= 4096) return 2;
  if (samplesPerPixel >= 512) return 1;
  return 0;
}

/**
 * Isi `out` (panjang `width * 2`, pasangan min/max ternormalisasi -1..1) untuk
 * rentang source [startSample, startSample + lenSamples).
 *
 * Tidak mengalokasi apa pun — pemanggil menyediakan buffer dan memakainya
 * ulang tiap redraw.
 */
export function readPeaks(
  pyramid: PeakPyramid,
  startSample: number,
  lenSamples: number,
  width: number,
  out: Float32Array,
): void {
  if (width <= 0) return;
  const spp = lenSamples / width;
  const level = levelFor(spp);
  const data = pyramid.levels[level]!;
  const bucket = BUCKET_SIZES[level]!;
  const buckets = data.length / 2;

  for (let px = 0; px < width; px++) {
    const s0 = startSample + (px * lenSamples) / width;
    const s1 = startSample + ((px + 1) * lenSamples) / width;
    const b0 = Math.max(0, Math.floor(s0 / bucket));
    const b1 = Math.min(buckets - 1, Math.max(b0, Math.ceil(s1 / bucket) - 1));
    let lo = 0;
    let hi = 0;
    for (let b = b0; b <= b1; b++) {
      const mn = data[b * 2]!;
      const mx = data[b * 2 + 1]!;
      if (mn < lo) lo = mn;
      if (mx > hi) hi = mx;
    }
    out[px * 2] = lo;
    out[px * 2 + 1] = hi;
  }
}

/** Peak absolut satu clip — dipakai NORMALIZE (docs/08: dihitung dari pyramid,
 *  bukan dari PCM, dan tidak memodifikasi PCM). */
export function peakOf(pyramid: PeakPyramid, startSample: number, lenSamples: number): number {
  const data = pyramid.levels[2] ?? pyramid.levels[0]!;
  const bucket = BUCKET_SIZES[data === pyramid.levels[2] ? 2 : 0]!;
  const b0 = Math.max(0, Math.floor(startSample / bucket));
  const b1 = Math.min(data.length / 2 - 1, Math.ceil((startSample + lenSamples) / bucket) - 1);
  let peak = 0;
  for (let b = b0; b <= b1; b++) {
    peak = Math.max(peak, Math.abs(data[b * 2]!), Math.abs(data[b * 2 + 1]!));
  }
  return peak;
}
