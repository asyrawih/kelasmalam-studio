/**
 * Backend halaman ROBLOX yang DISUNTIK app, bukan dipilih dari `isTauri`
 * (docs/25 §1c).
 *
 * Web tidak mendaftarkan apa pun: `RobloxRoute` memakai bawaannya —
 * `createHttpTransport(VITE_ROBLOX_API)` ke Worker unggah dan `createGrantApi`
 * ke Worker kepustakaan. Desktop (`apps/desktop/src/roblox-local/backend.ts`)
 * mendaftarkan transport command Tauri, Grant Access lokal, penyimpanan
 * target/API key ke SQLite + berkas rahasia, dan probe kesiapannya — lalu
 * `RobloxRoute` memakai itu tanpa tahu Tauri ada.
 *
 * Bentuknya dibaca dari apa yang dulu bercabang di `RobloxRoute`: lima hal
 * yang berbeda antara web dan desktop, tidak lebih. `runner.ts` sama untuk
 * keduanya, dan `RobloxPage` tetap UI murni.
 *
 * Registry modul, bukan prop, karena `AppShell` yang merender `RobloxRoute`
 * milik tiap app dan pendaftarannya lebih tepat di `main.tsx` bersama
 * pendaftaran host platform — satu tempat untuk semua yang "app ini
 * menyediakan apa".
 */

import type { PlatformKind } from '../../platform';
import type { RobloxTarget } from '../model';
import type { GrantApi } from '../grant/api';
import type { RunnerOptions } from './runner';
import type { Transport } from './transport';

export interface RobloxBackend {
  /** Label untuk teks UI (badge, kalimat bantuan). TODO(P3): pindah ke prop UI. */
  readonly platform: PlatformKind;
  /** Kabel unggah — `runner.ts` yang memakainya. */
  readonly transport: Transport;
  /** Grant Access; `null` = tab-nya berkata belum tersedia. */
  readonly grantApi: GrantApi | null;
  /**
   * SIMPAN di panel TUJUAN: creator + API key ke tempat yang dimiliki backend
   * ini. Boleh memutakhirkan store (mengosongkan kolom kunci, menandai
   * `apiKeyStored`).
   */
  saveTarget(target: RobloxTarget): Promise<void>;
  /**
   * Kesiapan unggah, diperiksa — bukan diasumsikan dari konfigurasi. Dipanggil
   * ulang tiap kali `saveTarget` selesai. Boleh memutakhirkan store.
   */
  probe(): Promise<boolean>;
  /**
   * Sesudah asset disetujui: web mencatatnya ke Worker kepustakaan; desktop
   * tidak perlu (baris `done` di tabel SUDAH katalog). `undefined` = tidak ada.
   */
  readonly onApproved?: RunnerOptions['onApproved'];
}

let registered: RobloxBackend | null = null;

/** Dipanggil app SEBELUM `RobloxRoute` dirender (desktop: `main.tsx`). */
export function registerRobloxBackend(backend: RobloxBackend | null): void {
  registered = backend;
}

export function getRobloxBackend(): RobloxBackend | null {
  return registered;
}
