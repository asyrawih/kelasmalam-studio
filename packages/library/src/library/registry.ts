/**
 * Dari mana kepustakaannya: DIDAFTARKAN app, bukan ditanya ke host (docs/25
 * §1c, P3).
 *
 * Sebelum P3 `PlatformHost.libraryApi()` yang menjawab, dan itu memaksa
 * kontrak platform mengimpor `LibraryApi` — paket halaman — padahal platform
 * harus tinggal di dasar graf (§1b). Kepustakaan juga bukan soal platform:
 * yang membedakan web dan desktop di sini adalah IMPLEMENTASI (klien Worker
 * vs SQLite lokal), dan itu persis jenis nilai yang app berikan lewat
 * registry, sama seperti backend Roblox dan transport SoundCloud.
 *
 *   - `apps/web/src/main.tsx`     : `registerLibraryApi(() => createLibraryApi(VITE_LIBRARY_API))`,
 *                                   atau `null` kalau build ini tanpa backend.
 *   - `apps/desktop/src/main.tsx` : `registerLibraryApi(() => createLocalLibraryApi())`.
 *
 * FACTORY, bukan instance, dan dibuat MALAS sekali: dok memakai objek yang
 * sama sebagai kunci effect-nya, dan klien baru tiap panggilan berarti boot
 * ulang tiap render. Tanpa pendaftaran, jawabannya `null` — dok tetap tampil
 * dan mengatakan kenapa kosong, seperti build tanpa `VITE_LIBRARY_API`.
 */

import type { LibraryApi } from './api';

let factory: (() => LibraryApi | null) | null = null;
let cached: LibraryApi | null | undefined;

/** Dipanggil app SEBELUM dok dirender. `null` = app ini tidak punya kepustakaan. */
export function registerLibraryApi(next: (() => LibraryApi | null) | null): void {
  factory = next;
  cached = undefined;
}

export function getLibraryApi(): LibraryApi | null {
  if (cached === undefined) cached = factory === null ? null : factory();
  return cached;
}
