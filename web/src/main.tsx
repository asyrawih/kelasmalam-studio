/**
 * Entry point.
 *
 * Dua hal yang sengaja dilakukan di sini dan tidak di App:
 *
 * 1. `AudioContext` (dan karenanya `EngineClient`) baru dibuat di dalam handler
 *    gesture user — App memanggil `createEngine` dari onClick (docs/05 §Safari).
 * 2. Modul `audio/engine-client` di-import DINAMIS. Ia bergantung pada artifak
 *    build WASM dan pada URL worklet yang dihasilkan plugin di vite.config.ts;
 *    keduanya di luar kepemilikan lapisan UI dan mungkin belum ada. Import
 *    statis akan membuat SELURUH aplikasi gagal dimuat kalau salah satunya
 *    belum siap. Dengan import dinamis + try/catch, UI tetap tampil dalam mode
 *    mirror-only dan alasannya terbaca di header.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import type { UiEngine } from './state';
import './index.css';

async function createEngine(): Promise<UiEngine | null> {
  const mod = await import('./audio/engine-client');
  // URL worklet dihasilkan plugin `audioWorkletPlugin()` di vite.config.ts
  // (docs/04). Kalau plugin-nya belum terpasang, `new URL(...)` di bawah tetap
  // memberi URL modul mentah dan `addModule` akan gagal — kegagalan itu
  // ditangkap App dan ditampilkan, bukan menghentikan aplikasi.
  const workletUrl = new URL('./audio/worklet-processor.ts', import.meta.url).href;
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
    <App createEngine={createEngine} />
  </StrictMode>,
);
