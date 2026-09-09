/**
 * Pemilih adapter platform milik APP DESKTOP (docs/25 §1d) — dan tidak ada
 * yang dipilih: app ini SELALU desktop, jadi tidak ada `isTauri()` di sini.
 * Kalau modul ini dimuat di luar Tauri, itu kesalahan pemasangan, bukan
 * keadaan yang perlu ditebak.
 *
 * Resolver didaftarkan di level modul, bukan dari `main.tsx`, dengan alasan
 * yang sama seperti di web: worker tidak menjalankan `main.tsx`. Modul yang
 * butuh host di dalam worker (`proof-stem/scnet-model.ts` lewat
 * `stem/auto-stem.worker.ts`, keduanya masih di `apps/web/src`) mengimpor
 * `'../platform'` RELATIF ke dirinya — yaitu `apps/web/src/platform`, host
 * WEB. Itu memang yang benar untuk worker: tidak ada jembatan IPC di sana,
 * dan `prefetchModelBytes` di main thread (host desktop, modul ini) yang
 * mengirim byte model ke worker sebagai transferable. Jadi di desktop ada
 * dua resolver yang terdaftar di dua konteks berbeda, dan keduanya benar.
 *
 * Yang diekspor ulang sama dengan web supaya modul desktop yang dulu
 * mengimpor `'../platform'` tidak berubah bentuk impornya.
 */

import { registerPlatformHostResolver } from '@kelasmalam/platform';
import { createDesktopHost } from './desktop';

registerPlatformHostResolver(() => createDesktopHost());

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
