/**
 * Pemilih adapter platform (docs/20 §1a) — milik APP, bukan paket.
 *
 * Kontrak `PlatformHost` dan `getPlatformHost()` hidup di `@kelasmalam/platform`
 * (docs/25 §1d). Modul ini yang memutuskan implementasinya: `isTauri()`
 * membaca `globalThis.isTauri` yang disuntik Tauri ke WebView utama, dan
 * pilihannya didaftarkan sebagai RESOLVER di level modul, bukan dipasang dari
 * `main.tsx`.
 *
 * Kenapa di level modul: worker tidak menjalankan `main.tsx`. Modul yang butuh
 * host di dalam worker (`proof-stem/scnet-model.ts` lewat
 * `stem/auto-stem.worker.ts`) mengimpor `'../platform'` — modul ini — dan
 * dengan begitu resolver ikut terdaftar di worker. Di sana `globalThis.isTauri`
 * TIDAK ada, jadi worker selalu mendapat host web, persis seperti sebelumnya;
 * memang tidak ada jembatan IPC di worker. Apa pun yang butuh Tauri harus
 * dilakukan di main thread lalu dikirim ke worker (lihat `prefetchModelBytes`
 * di `proof-stem/scnet-model.ts`).
 *
 * Importer lama (`from '../platform'`) tidak berubah: semua yang dulu
 * diekspor dari sini diekspor ulang dari paket. Hook ada di `./hooks`, bukan
 * di sini — modul ini dimuat worker, dan hook membawa React (lihat komentar
 * `@kelasmalam/platform`).
 */

import { isTauri } from '@tauri-apps/api/core';
import { registerPlatformHostResolver } from '@kelasmalam/platform';
import { createDesktopHost } from './desktop';
import { createWebHost } from './web';

registerPlatformHostResolver(() => (isTauri() ? createDesktopHost() : createWebHost()));

export {
  getPlatformHost,
  setPlatformHostForTests,
  type DropPoint,
  type LoginRequest,
  type ModelBytes,
  type OpenAudioFilesOptions,
  type PlatformHost,
  type PlatformKind,
  type SaveTarget,
} from '@kelasmalam/platform';
