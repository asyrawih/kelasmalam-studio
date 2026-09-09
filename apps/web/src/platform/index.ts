/**
 * Pemilih adapter platform milik APP WEB (docs/25 §1d) — dan sejak P2 tidak
 * ada yang perlu dipilih: app ini SELALU web.
 *
 * Kontrak `PlatformHost` dan `getPlatformHost()` hidup di `@kelasmalam/platform`.
 * Modul ini mendaftarkan `createWebHost()` sebagai RESOLVER di level modul,
 * bukan dari `main.tsx`, dan itu bukan kemalasan: worker tidak menjalankan
 * `main.tsx`. Modul yang butuh host di dalam worker
 * (`proof-stem/scnet-model.ts` lewat `stem/auto-stem.worker.ts`) mengimpor
 * `'../platform'` — modul ini — dan dengan begitu resolver ikut terdaftar di
 * worker.
 *
 * Didaftarkan sebagai resolver BAWAAN (`registerDefaultPlatformHostResolver`),
 * bukan resolver app: modul-modul di `apps/web/src` yang belum jadi paket
 * (studio, roblox, kepustakaan — TODO(P3)) juga dimuat app DESKTOP lewat
 * `@app-web/*`, dan mereka mengimpor modul ini. Bawaan tidak menimpa resolver
 * yang didaftarkan `apps/desktop/src/platform/index.ts`, apa pun urutan
 * pemuatannya; di worker desktop hanya bawaan ini yang ada, dan host web
 * memang yang benar di sana (tidak ada IPC di worker). Di app web tidak ada
 * resolver lain, jadi bawaan = satu-satunya.
 *
 * Yang HILANG dari sini dibanding sebelum P2: `isTauri()` dan
 * `createDesktopHost()`. Keduanya kini milik `apps/desktop/src/platform/`,
 * yang mendaftarkan resolvernya sendiri. Bundel web tidak lagi membawa
 * `@tauri-apps/*` sama sekali — `__tests__/no-desktop-leak.test.ts` menjaga.
 *
 * Importer lama (`from '../platform'`) tidak berubah: semua yang dulu
 * diekspor dari sini diekspor ulang dari paket. Hook ada di `./hooks`, bukan
 * di sini — modul ini dimuat worker, dan hook membawa React (lihat komentar
 * `@kelasmalam/platform`).
 */

import { registerDefaultPlatformHostResolver } from '@kelasmalam/platform';
import { createWebHost } from './web';

registerDefaultPlatformHostResolver(() => createWebHost());

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
