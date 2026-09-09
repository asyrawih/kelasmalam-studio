/// <reference types="vite/client" />

/**
 * Variabel build yang di-inject `buildInfoDefines()` (`packages/engine/vite/
 * base.ts`) dan dibaca `build-info.ts`. Semuanya opsional dengan sengaja:
 * vitest tidak memuat `vite.config.ts`, jadi di tes nilainya memang tidak
 * ada — dan tipe yang berpura-pura selalu ada akan menyembunyikan itu.
 *
 * Tiap paket mendeklarasikan HANYA variabel yang dibacanya; augmentasi
 * `ImportMetaEnv` dari beberapa paket digabung TypeScript.
 */
interface ImportMetaEnv {
  readonly VITE_APP_VERSION?: string;
  readonly VITE_BUILD_COMMIT?: string;
  readonly VITE_BUILD_BRANCH?: string;
  readonly VITE_BUILD_TIME?: string;
}
