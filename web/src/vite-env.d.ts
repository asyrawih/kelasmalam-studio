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
}
