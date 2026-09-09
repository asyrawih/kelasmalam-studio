/**
 * Entry point aplikasi DESKTOP (docs/25 P2).
 *
 * Bedanya dengan `apps/web/src/main.tsx` bukan `if (isTauri)` — app ini
 * SELALU desktop. Yang berbeda adalah apa yang DIDAFTARKAN sebelum render:
 * paket-paket halaman (studio, roblox, soundcloud, kepustakaan) menerima
 * kemampuan sebagai nilai lewat registry (docs/25 §1c), dan di sinilah semua
 * nilai itu diberikan, satu tempat:
 *
 *   - host platform desktop (`./platform`, terdaftar saat modul dimuat);
 *   - kepustakaan LOKAL (SQLite + folder, docs/21) sebagai `LibraryApi`;
 *   - importer YouTube untuk link yang di-drop/paste ke lane (docs/23);
 *   - penyimpanan antrean Roblox di SQLite lewat command Tauri (docs/21 §3b);
 *   - backend Roblox lokal: transport, Grant Access, target, berkas rahasia;
 *   - transport SoundCloud in-process (crate `soundclaude` di Rust).
 *
 * Tidak ada `<Analytics/>` Vercel: app ini dipasang di mesin orang, dan
 * telemetri dari sana bukan sesuatu yang diputuskan diam-diam lewat bundel.
 *
 * Engine, seperti di web: `AudioContext` baru dibuat di handler gesture user,
 * dan `engine-client` di-import DINAMIS supaya UI tetap tampil (mode
 * mirror-only) kalau artefak WASM belum ada.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './platform';
import { AppShell } from './app-shell/AppShell';
import { createLocalLibraryApi } from './library-local/local-api';
import { createDesktopRobloxBackend } from './roblox-local/backend';
import { createLocalQueuePersistence } from './roblox-local/queue-persistence';
import { desktopTransport } from './soundcloud/desktop-transport';
import { youtubeUrlImporter } from './youtube/import';
import { registerLibraryApi } from '@kelasmalam/library/library/registry';
import { registerRobloxBackend } from '@kelasmalam/roblox/roblox/backend/backend';
import { registerRobloxPersistence } from '@kelasmalam/roblox/roblox/store';
import { registerSoundCloudTransport } from '@kelasmalam/soundcloud/soundcloud/api';
import { registerUrlImporter } from '@kelasmalam/studio/studio/timeline/url-to-lane';
import type { UiEngine } from '@kelasmalam/engine/state';
import './index.css';
// Suffix `?worklet&url` WAJIB: ia melewati `audioWorkletPlugin()` yang mem-build
// worklet jadi IIFE tanpa `import` (lihat `packages/engine/vite/base.ts`).
import workletUrl from '@kelasmalam/engine/audio/worklet-processor.ts?worklet&url';

// ── Kemampuan desktop → modul bersama (sebelum render) ──────────────────────
registerLibraryApi(() => createLocalLibraryApi());
registerUrlImporter(youtubeUrlImporter);
registerRobloxPersistence(createLocalQueuePersistence);
registerRobloxBackend(createDesktopRobloxBackend());
registerSoundCloudTransport(desktopTransport);

async function createEngine(): Promise<UiEngine | null> {
  const mod = await import('@kelasmalam/engine/audio/engine-client');
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
