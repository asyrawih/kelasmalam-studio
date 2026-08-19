/**
 * Byte tersimpan → asset terdaftar + PCM ter-cache.
 *
 * SATU jalur untuk `/studio` (pemulihan project) dan `/dj` (memuat kepustakaan
 * tanpa membuka project). Envelope hasil pemulihan HARUS identik dari halaman
 * mana pun — kalau tidak, waveform lagu yang sama bisa berbeda bentuk tergantung
 * halaman mana yang dibuka lebih dulu, dan itu cacat yang mustahil dilacak dari
 * layar (alasan yang sama sudah ditulis di kepala `assetFromBuffer`).
 */

import { requestAssetTempo } from '../analysis/tempo-client';
import { ensureContext, registerBuffer } from '../preview/audio-preview';
import { studioActions } from '../store';
import { assetFromBuffer } from '../timeline/audio-import';
import { loadAllAssets } from './db';

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
    // Tempo TIDAK ikut disimpan di IndexedDB, jadi dianalisis ulang di sini.
    // Yang disimpan hanya byte file asli (lihat persist/db.ts); menambah hasil
    // turunan ke sana berarti satu bentuk data lagi yang bisa basi terhadap
    // perbaikan algoritma, dan analisisnya hanya ratusan milidetik di worker.
    requestAssetTempo(id, buffer);
    return true;
  } catch {
    return false;
  }
}

export interface LibraryLoadResult {
  readonly loaded: number;
  readonly failed: number;
}

/**
 * Muat SELURUH kepustakaan ke store — tanpa menyentuh lane maupun project.
 *
 * Halaman `/dj` butuh daftar lagu, tapi TIDAK boleh memanggil `restoreProject`:
 * fungsi itu meng-hydrate seluruh state Studio, termasuk lane, dan memanggilnya
 * dari halaman yang tidak menampilkan timeline berarti menimpa pekerjaan user
 * dengan apa pun yang kebetulan tersimpan.
 */
export async function loadLibraryIntoStore(sampleRate: number): Promise<LibraryLoadResult> {
  const stored = await loadAllAssets();
  let loaded = 0;
  let failed = 0;
  for (const a of stored) {
    const ok = await decodeStoredAsset(a.id, a.name, a.bytes, sampleRate);
    if (ok) loaded += 1;
    else failed += 1;
  }
  return { loaded, failed };
}
