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
 * bukan resolver app: setup vitest app web (`__tests__/setup.ts`) memuat
 * modul ini untuk semua tes — termasuk tes `packages/*` dan, lewat impor
 * setup yang sama, tes `apps/desktop` — dan di sana resolver desktop yang
 * didaftarkan `apps/desktop/src/platform/index.ts` harus menang apa pun
 * urutan pemuatannya. Di app web tidak ada resolver lain, jadi bawaan =
 * satu-satunya. Sejak P3 tidak ada lagi modul bersama yang mengimpor ini
 * (paket tidak tahu host mana pun), jadi di worker tidak ada host sama
 * sekali — dan memang tidak dibutuhkan (lihat `modelBytes` di kontrak).
 *
 * Yang HILANG dari sini dibanding sebelum P2: `isTauri()` dan
 * `createDesktopHost()`. Keduanya kini milik `apps/desktop/src/platform/`,
 * yang mendaftarkan resolvernya sendiri. Bundel web tidak lagi membawa
 * `@tauri-apps/*` sama sekali — `__tests__/no-desktop-leak.test.ts` menjaga.
 *
 * Importer lama (`from '../platform'`) tidak berubah: semua yang dulu
 * diekspor dari sini diekspor ulang dari paket. Hook TIDAK ada di sini —
 * komponen mengimpor `@kelasmalam/platform/hooks` langsung (modul ini dimuat
 * pemilih yang juga dipakai worker, dan hook membawa React).
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
