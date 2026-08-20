/// <reference types="vite/client" />

/**
 * Variabel build yang di-inject `buildInfoDefines()` di `web/vite.config.ts`.
 *
 * Semuanya opsional dengan sengaja: vitest tidak memuat `vite.config.ts`, jadi
 * di tes nilainya memang tidak ada — dan tipe yang berpura-pura selalu ada akan
 * menyembunyikan itu (lihat `src/build-info.ts`).
 */
interface ImportMetaEnv {
  readonly VITE_APP_VERSION?: string;
  readonly VITE_BUILD_COMMIT?: string;
  readonly VITE_BUILD_BRANCH?: string;
  readonly VITE_BUILD_TIME?: string;
  /**
   * Basis URL Worker unggah Roblox (`backend/`), mis.
   * `https://dawonweb-roblox.contoh.workers.dev`.
   *
   * TIDAK ada nilai bawaan, dengan sengaja: halaman `/roblox` hanya menyalakan
   * tombol UNGGAH kalau ini diisi DAN Worker-nya menjawab. Lihat
   * `roblox/RobloxRoute.tsx`.
   */
  readonly VITE_ROBLOX_API?: string;
  /**
   * Basis URL Worker kepustakaan (`backend/`, `wrangler.library.toml`).
   *
   * Tanpa ini dok kepustakaan tetap tampil, tapi mengatakan bahwa ia belum
   * dipasang — bukan menghilang. Build tanpa backend adalah keadaan yang sah:
   * seluruh aplikasi berjalan penuh tanpa akun (docs/16 §6).
   */
  readonly VITE_LIBRARY_API?: string;
}
