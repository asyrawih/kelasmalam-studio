/// <reference types="vite/client" />

/**
 * Variabel env yang dibaca APP ini (`AppShell.tsx`, `platform/web.ts`).
 * Variabel yang dibaca paket dideklarasikan paketnya sendiri
 * (`packages/{shell,roblox,soundcloud}/src/vite-env.d.ts`); augmentasi
 * `ImportMetaEnv` digabung TypeScript.
 */
interface ImportMetaEnv {
  /**
   * Basis URL Worker kepustakaan (`backend/`, `wrangler.library.toml`).
   *
   * Tanpa ini dok kepustakaan tetap tampil, tapi mengatakan bahwa ia belum
   * dipasang — bukan menghilang. Build tanpa backend adalah keadaan yang sah:
   * seluruh aplikasi berjalan penuh tanpa akun (docs/16 §6).
   */
  readonly VITE_LIBRARY_API?: string;
}
