/**
 * Satu lagu kepustakaan → asset sesi ini.
 *
 * Ini fase L4 docs/16 dalam bentuk terkecilnya: **unduh sesuai permintaan,
 * bukan seluruh kepustakaan saat boot.** `loadLibraryIntoStore` yang lama
 * mengunduh dan men-decode semuanya saat mount, dan dengan kepustakaan berisi
 * belasan lagu itu berarti puluhan MB serta belasan detik sebelum satu tombol
 * pun bisa ditekan. Daftar datang dari metadata; audionya menyusul saat lagunya
 * benar-benar dipakai.
 *
 * ## Jalurnya SAMA dengan drop berkas lokal
 *
 * Byte-nya diserahkan ke `importBytesToAsset` — fungsi yang sama persis yang
 * dipakai saat user menjatuhkan file ke timeline. Itu bukan kebetulan: satu
 * jalur decode berarti waveform, envelope, dan BPM lagu yang sama tidak bisa
 * berbeda tergantung dari mana ia datang. Ia juga sudah menyusun kalimat galat
 * yang layak dipajang ("bukan berkas audio — terbaca sebagai …"), jadi tidak
 * ada yang perlu diterjemahkan ulang di sini.
 *
 * ## Yang BELUM dilakukan modul ini
 *
 * Menaruhnya di lane. Asset yang sudah terdaftar dipakai lewat jalur yang sudah
 * ada; menaruh clip dari sini berarti menyalin logika pembuatan clip
 * (`len`/`sourceLen`/`speedRatio`) yang sudah hidup di `importBytesToLane`, dan
 * salinan itu akan salah diam-diam begitu salah satunya berubah.
 */

import { importBytesToAsset } from '../studio/timeline/audio-import';
import { studioStore } from '../studio/store';
import type { LibraryApi } from './api';
import { libraryActions, libraryStore } from './store';
import type { LibraryTrack } from './model';

export type LoadOutcome =
  | { readonly ok: true; readonly assetId: number; readonly cached: boolean }
  | { readonly ok: false; readonly message: string };

export async function loadTrack(api: LibraryApi, track: LibraryTrack): Promise<LoadOutcome> {
  const already = libraryStore.getState().loaded[track.hash];
  if (already !== undefined) {
    // Sudah ada di sesi ini. Mengunduh ulang 25 MB untuk sesuatu yang sudah
    // duduk di memori adalah cara termudah membuat klik kedua terasa rusak.
    return { ok: true, assetId: already, cached: true };
  }

  libraryActions.setProgress(track.hash, 0);
  try {
    const bytes = await api.blob(track.hash, (percent) => {
      libraryActions.setProgress(track.hash, percent);
    });

    const got = await importBytesToAsset(bytes, track.name, studioStore.getState().sampleRate);
    if (!got.ok) {
      libraryActions.clearProgress(track.hash);
      return { ok: false, message: got.reason };
    }

    libraryActions.markLoaded(track.hash, got.assetId);
    return { ok: true, assetId: got.assetId, cached: false };
  } catch (err: unknown) {
    libraryActions.clearProgress(track.hash);
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
