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

/** Puncak absolut lintas channel pada rentang sample tertentu. */
export function peakOf(buffer: AudioBuffer, from: number, len: number): number {
  const start = Math.max(0, Math.min(buffer.length, Math.floor(from)));
  const end = Math.max(start, Math.min(buffer.length, Math.floor(from + len)));
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

export function computeNormalizeGain(clip: StudioClip): NormalizeResult {
  const buffer = getBuffer(clip.assetId);
  if (buffer === undefined) {
    return { ok: false, reason: 'PCM clip ini tidak tersedia (clip demo tanpa audio asli)' };
  }
  const peak = peakOf(buffer, clip.sourceStart, clip.sourceLen);
  if (peak <= 0) {
    return { ok: false, reason: 'clip ini senyap — tidak ada yang bisa dinormalisasi' };
  }
  const gainDb = NORMALIZE_TARGET_DB - 20 * Math.log10(peak);
  // Bulatkan ke 0.1 dB: presisi lebih halus tidak terdengar dan hanya membuat
  // angka di UI terlihat berisik.
  return { ok: true, gainDb: Math.round(gainDb * 10) / 10 };
}
