/**
 * Vite untuk `apps/desktop` (frontend Tauri, docs/25 P2).
 *
 * Semua yang membuat engine jalan di WebView — plugin worklet, header COOP/COEP
 * untuk dev, `optimizeDeps`, identitas build, alias workspace — datang dari
 * `packages/engine/vite/base.ts`, SAMA dengan `apps/web` (docs/25 §1f). Yang
 * khas di sini:
 *
 *   - `port: 5174` (strict): `devUrl` di `src-tauri/tauri.conf.json` menembak
 *     port ini, dan 5173 tetap milik `apps/web` supaya keduanya bisa hidup
 *     bersamaan. Kalau port berubah, `devUrl` dan `devCsp` harus ikut.
 *   - `envPrefix: ['VITE_', 'TAURI_']`: tauri-cli mengekspor `TAURI_ENV_*`
 *     (platform, arch, debug) saat `cargo tauri dev/build`; kode app boleh
 *     membacanya lewat `import.meta.env`.
 *   - `clearScreen: false`: log Vite tidak boleh menghapus log Rust yang
 *     berjalan di terminal yang sama.
 *
 * Build produksi (`vite build` → `dist/`) ditanam ke binari oleh tauri-build
 * (`frontendDist: ../dist`) dan disajikan server loopback di dalam aplikasi
 * yang memberi header COI-nya sendiri (docs/20 §1c).
 */
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

import { defineDawApp } from '../../packages/engine/vite/base';

export default defineConfig(
  defineDawApp({
    appDir: __dirname,
    repoRoot: resolve(__dirname, '../..'),
    port: 5174,
    envPrefix: ['VITE_', 'TAURI_'],
    clearScreen: false,
  }),
);
