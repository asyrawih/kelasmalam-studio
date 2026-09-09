/**
 * Entry point.
 *
 * Dua hal yang sengaja dilakukan di sini dan tidak di App:
 *
 * 1. `AudioContext` (dan karenanya `EngineClient`) baru dibuat di dalam handler
 *    gesture user — App memanggil `createEngine` dari onClick (docs/05 §Safari).
 *    Pemilihan halaman, keyboard, dan registry command ada di `AppShell`, bukan
 *    di sini: entry point tetap hanya soal bootstrapping.
 * 2. Modul `audio/engine-client` di-import DINAMIS. Ia bergantung pada artifak
 *    build WASM dan pada URL worklet yang dihasilkan plugin di vite.config.ts;
 *    keduanya di luar kepemilikan lapisan UI dan mungkin belum ada. Import
 *    statis akan membuat SELURUH aplikasi gagal dimuat kalau salah satunya
 *    belum siap. Dengan import dinamis + try/catch, UI tetap tampil dalam mode
 *    mirror-only dan alasannya terbaca di header.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Analytics } from '@vercel/analytics/react';
import { AppShell } from './app-shell';
import { libraryApiBaseFromEnv } from './platform/web';
import type { UiEngine } from '@kelasmalam/engine/state';
import { createLibraryApi, registerLibraryApi } from '@kelasmalam/library/library';
import './index.css';
// Suffix `?worklet&url` WAJIB: ia melewati `audioWorkletPlugin()` yang mem-build
// worklet jadi IIFE tanpa `import`. Memakai `new URL(...)` biasa membuat Vite
// menyalin file .ts MENTAH ke dist — dev tetap jalan (dev-server men-transform),
// produksi gagal dengan SyntaxError saat addModule().
import workletUrl from '@kelasmalam/engine/audio/worklet-processor.ts?worklet&url';

async function createEngine(): Promise<UiEngine | null> {
  const mod = await import('@kelasmalam/engine/audio/engine-client');
  return await mod.EngineClient.create({
    workletUrl,
    onFault: (message) => {
      void message;
    },
  });
}

// Kepustakaan app ini: klien Worker dari `VITE_LIBRARY_API`, atau tidak ada
// sama sekali kalau build ini memang tanpa backend (docs/16 §6) — dok tetap
// tampil dan mengatakan kenapa kosong. Didaftarkan di sini, bukan ditanya ke
// host platform: kepustakaan bukan soal platform (docs/25 P3, `registry.ts`).
registerLibraryApi(() => {
  const base = libraryApiBaseFromEnv();
  return base === '' ? null : createLibraryApi(base);
});

const container = document.getElementById('root');
if (container === null) throw new Error('#root tidak ditemukan di index.html');

createRoot(container).render(
  <StrictMode>
    <AppShell createEngine={createEngine} />
    {/*
      * Analytics Vercel TANPA syarat: app ini selalu web (docs/25 P2).
      * Desktop punya `main.tsx`-nya sendiri tanpa ini — mengirim telemetri
      * dari app yang dipasang di mesin orang bukan sesuatu yang diputuskan
      * diam-diam lewat bundel yang sama.
      */}
    <Analytics />
  </StrictMode>,
);
