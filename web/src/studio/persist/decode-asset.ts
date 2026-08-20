/**
 * Byte tersimpan → asset terdaftar + PCM ter-cache.
 *
 * Sengaja TIDAK tahu byte-nya datang dari mana. Sebelumnya modul ini juga
 * memiliki pemuat kepustakaan yang membaca IndexedDB sendiri; IndexedDB sudah
 * dibuang, dan penggantinya — kepustakaan eksplisit lewat backend — akan
 * menyerahkan byte ke fungsi di bawah. Dengan begitu jalur "byte → asset"
 * tetap SATU, dari sumber mana pun.
 *
 * Envelope hasil pemulihan HARUS identik dari halaman mana pun — kalau tidak,
 * waveform lagu yang sama bisa berbeda bentuk tergantung halaman mana yang
 * dibuka lebih dulu, dan itu cacat yang mustahil dilacak dari layar (alasan
 * yang sama sudah ditulis di kepala `assetFromBuffer`).
 */

import { requestAssetTempo } from '../analysis/tempo-client';
import { ensureContext, registerBuffer } from '../preview/audio-preview';
import { studioActions } from '../store';
import { assetFromBuffer } from '../timeline/audio-import';

export async function decodeStoredAsset(
  id: number,
  name: string,
  bytes: ArrayBuffer,
  sampleRate: number,
): Promise<boolean> {
  const ctx = ensureContext(sampleRate);
  if (ctx === null) return false;
  try {
    // `decodeAudioData` MEMAKAN buffer-nya (detached) di sebagian browser,
    // jadi salin dulu — kalau tidak, percobaan berikutnya dapat buffer kosong.
    const buffer = await ctx.decodeAudioData(bytes.slice(0));
    registerBuffer(id, buffer);
    studioActions.registerAsset(assetFromBuffer(id, name, buffer));
    // Tempo dianalisis ulang di sini, tidak ikut disimpan bersama byte-nya:
    // hasil turunan yang ikut tersimpan adalah satu bentuk data lagi yang bisa
    // basi terhadap perbaikan algoritma, dan analisisnya hanya ratusan
    // milidetik di worker.
    requestAssetTempo(id, buffer);
    return true;
  } catch {
    return false;
  }
}
