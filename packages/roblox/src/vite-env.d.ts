/// <reference types="vite/client" />

/** Variabel env yang dibaca paket ini (`RobloxRoute.tsx`); lihat `packages/shell/src/vite-env.d.ts`. */
interface ImportMetaEnv {
  /**
   * Basis URL Worker unggah Roblox (`backend/`), mis.
   * `https://dawonweb-roblox.contoh.workers.dev`.
   *
   * TIDAK ada nilai bawaan, dengan sengaja: halaman `/roblox` hanya menyalakan
   * tombol UNGGAH kalau ini diisi DAN Worker-nya menjawab.
   */
  readonly VITE_ROBLOX_API?: string;
  /** Basis URL Worker kepustakaan — katalog dan grant Roblox disimpan di D1 yang sama. */
  readonly VITE_LIBRARY_API?: string;
}
