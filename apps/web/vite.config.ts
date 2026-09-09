/**
 * Vite untuk `apps/web` (Vercel).
 *
 * Seluruh konfigurasi yang membuat engine jalan di browser — plugin worklet,
 * header COOP/COEP, `optimizeDeps`, identitas build, alias workspace — ada di
 * `packages/engine/vite/base.ts` dan dibagi dengan `apps/desktop` (docs/25 §1f).
 * Yang tersisa di sini hanya yang khas web, dan hari ini itu cuma port dev
 * (5173; desktop 5174): header produksi datang dari `public/_headers`, bukan
 * dari sini.
 *
 * `optimize-deps-exclude.test.ts` mengimpor berkas ini — konfigurasi yang
 * diuji adalah yang SUNGGUHAN dipakai `vite build`, bukan salinan.
 */
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

import { defineDawApp } from '../../packages/engine/vite/base';

export default defineConfig(defineDawApp({ appDir: __dirname, repoRoot: resolve(__dirname, '../..'), port: 5173 }));
