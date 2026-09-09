import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

import { dawAliases } from '../../packages/engine/vite/base';

const REPO_ROOT = resolve(__dirname, '../..');

/**
 * Satu konfigurasi vitest untuk app DAN paket-paket yang dikonsumsinya
 * (docs/25 P1).
 *
 * `root` dinaikkan ke akar repo, bukan `vitest.workspace.ts` terpisah: paket
 * dikonsumsi sebagai sumber (tanpa build), jadi tesnya butuh setup, plugin
 * React, dan alias yang SAMA dengan tes app — dua konfigurasi berarti dua
 * tempat yang harus dijaga sama, dan satu proyek vitest sudah cukup. Dengan
 * root di akar, `include` bisa menyebut `packages/*` tanpa `../..` yang
 * bergantung pada letak berkas ini. `process.cwd()` TIDAK berubah (tetap
 * `apps/web` saat `bun run --cwd apps/web test`); tes yang mencari akar repo
 * dari cwd (`sab-layout.test.ts`) naik direktori sendiri.
 */
export default defineConfig({
  plugins: [react()],
  // Sama dengan `vite.config.ts` (lewat `dawAliases`, satu sumber): modul yang
  // memakai `@ort-dist` atau alias paket harus bisa di-import oleh tes tanpa
  // konfigurasi berbeda dari build.
  resolve: { alias: dawAliases(REPO_ROOT) },
  test: {
    root: REPO_ROOT,
    environment: 'jsdom',
    globals: true,
    setupFiles: [resolve(__dirname, 'src/__tests__/setup.ts')],
    include: ['apps/web/src/**/*.test.{ts,tsx}', 'packages/*/src/**/*.test.{ts,tsx}'],
  },
});
