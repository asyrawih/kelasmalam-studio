/**
 * NORMALIZE — hitung gain agar puncak clip menyentuh target headroom.
 *
 * Non-destruktif: PCM tidak disentuh sama sekali. Yang berubah hanya
 * `clip.gainDb`, jadi normalize bisa dibatalkan dengan mengembalikan gain ke 0
 * dan tidak pernah menurunkan kualitas (tidak ada kuantisasi ulang).
 *
 * Peak diukur pada REGION clip saja (`sourceStart..sourceStart+sourceLen`),
 * bukan seluruh file — clip hasil split harus dinormalisasi berdasarkan bagian
 * yang benar-benar dipakai, bukan puncak di bagian lain yang sudah dipotong.
 */

import type { StudioClip } from '../model';
import { getBuffer } from '../preview/audio-preview';
import { studioStore } from '../store';
import type { Envelope } from './envelope';

/**
 * Target puncak. Bukan 0 dBFS: sinyal yang tepat 0 dBFS bisa melewati batas
 * setelah konversi sample-rate atau encoding lossy (intersample peak). -0.3 dB
 * adalah kompromi yang lazim dipakai.
 */
export const NORMALIZE_TARGET_DB = -0.3;

export interface NormalizeResult {
  readonly ok: boolean;
  readonly gainDb?: number;
  readonly reason?: string;
}

/** Puncak absolut lintas channel pada rentang sample mentah. */
function rawPeak(buffer: AudioBuffer, start: number, end: number): number {
  let peak = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch += 1) {
    const data = buffer.getChannelData(ch);
    for (let i = start; i < end; i += 1) {
      const v = Math.abs(data[i] ?? 0);
      if (v > peak) peak = v;
    }
  }
  return peak;
}

/**
 * Puncak absolut lintas channel pada rentang sample tertentu.
 *
 * `env` opsional, dan memberikannya mengubah ONGKOS-nya saja, bukan hasilnya.
 * Tanpa envelope, fungsi ini membaca setiap sample: untuk clip sepanjang lagu
 * 27 menit itu 155 juta iterasi di main thread, dan tombol NORMALIZE membeku
 * bersamanya. Dengan envelope, bucket level 0 (64 sample) sudah menyimpan
 * min/max yang EKSAK — `max` sebuah bucket adalah `max` dari sample-sample di
 * dalamnya, bukan aproksimasi — jadi bagian tengah rentang cukup dibaca dari
 * situ, ~64× lebih sedikit pembacaan.
 *
 * Yang tidak boleh dipotong adalah TEPI-nya. Rentang clip hampir tidak pernah
 * jatuh tepat di batas bucket, dan memakai bucket yang hanya tersentuh sebagian
 * berarti memasukkan sample DI LUAR clip ke dalam perhitungan — clip hasil
 * split akan dinormalisasi memakai puncak dari bagian yang sudah dipotong.
 * Karena itu kedua bucket tepi tetap dibaca sample demi sample: maksimum 64
 * sample per channel di tiap ujung, dan hasilnya identik dengan pemindaian
 * penuh.
 */
export function peakOf(
  buffer: AudioBuffer,
  from: number,
  len: number,
  env: Envelope | null = null,
): number {
  const start = Math.max(0, Math.min(buffer.length, Math.floor(from)));
  const end = Math.max(start, Math.min(buffer.length, Math.floor(from + len)));
  if (end <= start) return 0;

  const level = env === null ? undefined : env.levels[0];
  // Envelope yang tidak sepadan dengan buffer-nya (asset tertukar, atau PCM
  // di-decode ulang dengan sample rate lain) tidak boleh dipercaya diam-diam.
  if (level === undefined || env === null || env.frames !== buffer.length) {
    return rawPeak(buffer, start, end);
  }

  const bucket = level.bucket;
  const firstWhole = Math.ceil(start / bucket);
  const afterWhole = Math.floor(end / bucket);
  // Rentang yang lebih pendek dari satu bucket utuh: tidak ada yang bisa
  // dihemat, dan jalur di bawah akan membaca ke belakang.
  if (afterWhole <= firstWhole) return rawPeak(buffer, start, end);

  let peak = 0;
  const buckets = Math.min(afterWhole, level.min.length);
  for (let b = firstWhole; b < buckets; b += 1) {
    const lo = -level.min[b]!;
    if (lo > peak) peak = lo;
    const hi = level.max[b]!;
    if (hi > peak) peak = hi;
  }

  // Dua ekor yang tidak tercakup bucket utuh.
  const head = rawPeak(buffer, start, firstWhole * bucket);
  if (head > peak) peak = head;
  const tail = rawPeak(buffer, afterWhole * bucket, end);
  if (tail > peak) peak = tail;

  return peak;
}

export function computeNormalizeGain(clip: StudioClip): NormalizeResult {
  const buffer = getBuffer(clip.assetId);
  if (buffer === undefined) {
    return { ok: false, reason: 'PCM clip ini tidak tersedia (clip demo tanpa audio asli)' };
  }
  // Envelope diambil dari store, bukan diminta lewat parameter: pemanggilnya
  // adalah satu tombol di panel, dan menambah parameter di sana hanya
  // memindahkan pencarian yang sama ke tempat yang lebih mudah dilupakan.
  const env = studioStore.getState().assets[clip.assetId]?.envelope ?? null;
  const peak = peakOf(buffer, clip.sourceStart, clip.sourceLen, env);
  if (peak <= 0) {
    return { ok: false, reason: 'clip ini senyap — tidak ada yang bisa dinormalisasi' };
  }
  const gainDb = NORMALIZE_TARGET_DB - 20 * Math.log10(peak);
  // Bulatkan ke 0.1 dB: presisi lebih halus tidak terdengar dan hanya membuat
  // angka di UI terlihat berisik.
  return { ok: true, gainDb: Math.round(gainDb * 10) / 10 };
}
