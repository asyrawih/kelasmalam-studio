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
import { AppShell } from './app-shell';
import type { UiEngine } from './state';
import './index.css';
// Suffix `?worklet&url` WAJIB: ia melewati `audioWorkletPlugin()` yang mem-build
// worklet jadi IIFE tanpa `import`. Memakai `new URL(...)` biasa membuat Vite
// menyalin file .ts MENTAH ke dist — dev tetap jalan (dev-server men-transform),
// produksi gagal dengan SyntaxError saat addModule().
import workletUrl from './audio/worklet-processor.ts?worklet&url';

async function createEngine(): Promise<UiEngine | null> {
  const mod = await import('./audio/engine-client');
  return await mod.EngineClient.create({
    workletUrl,
    onFault: (message) => {
      void message;
    },
  });
}

const container = document.getElementById('root');
if (container === null) throw new Error('#root tidak ditemukan di index.html');

createRoot(container).render(
  <StrictMode>
    <AppShell createEngine={createEngine} />
  </StrictMode>,
);
