/**
 * @vitest-environment node
 *
 * Alias `@ort-dist` harus menunjuk ke folder yang benar-benar berisi runtime
 * WASM ORT yang dipakai `proof-stem/scnet-model.ts`.
 *
 * Tes ini lahir dari docs/25 P0: pemindahan `web/` → `apps/web` + hoisting
 * bun membuat path `../../node_modules/onnxruntime-web/dist` tidak ada lagi,
 * `vite build` tetap hijau, dan `ort-wasm-simd-threaded.{mjs,wasm}` lenyap
 * dari `dist/`. Kegagalan seperti itu hanya terlihat saat user menekan
 * "pisahkan stem" di produksi — di sini ia jatuh di CI.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ortDistDir } from '../../ort-dist';

describe('@ort-dist', () => {
  it.each(['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'])(
    'berisi %s yang dibutuhkan scnet-model',
    (file) => {
      const dir = ortDistDir();
      expect(dir.endsWith('dist'), `bukan folder dist: ${dir}`).toBe(true);
      expect(existsSync(join(dir, file)), `${file} tidak ada di ${dir}`).toBe(true);
    },
  );
});
