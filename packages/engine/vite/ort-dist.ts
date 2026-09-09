/**
 * Letak `onnxruntime-web/dist/` — dipakai `base.ts` (Vite kedua app) dan
 * `vitest.config.ts` sebagai alias `@ort-dist`. Tinggal di `packages/engine/vite`
 * sejak docs/25 P2 karena dua app memakainya; `apps/web/ort-dist.ts` hanya
 * mengekspor ulang supaya `ort-dist.test.ts` tetap membaca yang sungguhan.
 *
 * KENAPA BUKAN PATH RELATIF `../../node_modules/onnxruntime-web/dist`.
 * Sejak workspace bun (docs/25 P0), dependensi di-hoist ke `node_modules` di
 * ROOT repo, bukan `apps/web/node_modules`. Path relatif yang lama masih lolos
 * `vite build` — Vite diam-diam membiarkan `new URL(...)` yang tidak ketemu
 * apa adanya — tapi `ort-wasm-simd-threaded.{mjs,wasm}` tidak lagi diterbitkan
 * ke `dist/`, dan pemisahan stem gagal di produksi tanpa satu pun tes merah.
 *
 * `require.resolve('onnxruntime-web')` mengikuti `exports["."]` paket itu
 * (`dist/ort.node.min.js` di Node), jadi `dirname`-nya adalah `dist/` di mana
 * pun pengelola paket menaruhnya: hoisted ke root, isolated di `.bun/`, atau
 * lokal per paket. `exports` paket TIDAK mengekspos `./dist/*`, sehingga
 * `new URL('onnxruntime-web/dist/…')` tanpa alias juga tidak bisa dipakai.
 *
 * `ort-dist.test.ts` memastikan kedua berkas yang dibutuhkan runtime ada di
 * folder ini.
 */

import { createRequire } from 'node:module';
import { dirname } from 'node:path';

export const ORT_DIST_ALIAS = '@ort-dist';

export function ortDistDir(): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve('onnxruntime-web'));
}
