import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

import { dawAliases } from '../../packages/engine/vite/base';

const REPO_ROOT = resolve(__dirname, '../..');

/**
 * Vitest untuk `apps/desktop` — bentuknya SAMA dengan `apps/web/vitest.config.ts`
 * (root = akar repo, setup, plugin, alias identik; docs/25 §1h), yang berbeda
 * hanya `include`: HANYA `apps/desktop/src/**`. Tes `packages/*` dan
 * `apps/web/src/**` tidak dijalankan dua kali — mereka milik `apps/web`.
 *
 * Yang hidup di sini: tes adapter desktop dengan `@tauri-apps/*` di-mock
 * (host, `callLocal`, jendela, menu native), kepustakaan lokal, Roblox lokal,
 * SoundCloud in-process, YouTube, dan penjaga `no-web-leak` +
 * `app-web-imports`.
 */
export default defineConfig({
  plugins: [react()],
  resolve: { alias: dawAliases(REPO_ROOT) },
  test: {
    root: REPO_ROOT,
    environment: 'jsdom',
    globals: true,
    setupFiles: [resolve(__dirname, 'src/__tests__/setup.ts')],
    include: ['apps/desktop/src/**/*.test.{ts,tsx}'],
  },
});
