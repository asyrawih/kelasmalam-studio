/**
 * Pemilih adapter platform (docs/20 §1a).
 *
 * `isTauri()` membaca `globalThis.isTauri` yang disuntik Tauri ke WebView
 * utama. Di dalam Web Worker nilai itu TIDAK ada, jadi worker selalu mendapat
 * host web — dan memang tidak ada jembatan IPC di sana. Apa pun yang butuh
 * Tauri harus dilakukan di main thread lalu dikirim ke worker
 * (lihat `prefetchModelBytes` di `proof-stem/scnet-model.ts`).
 */

import { isTauri } from '@tauri-apps/api/core';
import { createDesktopHost } from './desktop';
import type { PlatformHost } from './host';
import { createWebHost } from './web';

export type {
  DropPoint,
  LoginRequest,
  ModelBytes,
  OpenAudioFilesOptions,
  PlatformHost,
  PlatformKind,
  SaveTarget,
} from './host';

let host: PlatformHost | null = null;

export function getPlatformHost(): PlatformHost {
  host ??= isTauri() ? createDesktopHost() : createWebHost();
  return host;
}

/** `null` mengembalikan pemilihan otomatis. */
export function setPlatformHostForTests(next: PlatformHost | null): void {
  host = next;
}
