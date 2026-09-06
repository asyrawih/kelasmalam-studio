/**
 * Kontrak adapter platform (docs/20 §2c).
 *
 * Satu frontend, dua kulit: web (Vercel) dan desktop (Tauri 2). Semua yang
 * berbeda di antara keduanya — ke mana berkas export ditulis, bagaimana lagu
 * masuk, bagaimana login berjalan, dari mana byte model datang — masuk lewat
 * SATU objek ini. Pemanggil tidak pernah bertanya `isTauri()` sendiri; kalau
 * sebuah komponen butuh cabang web/desktop, cabang itu ditulis di sini, bukan
 * di komponennya. Itu yang membuat `web.ts` bisa dijamin "kode lama dipindah
 * apa adanya" dan `desktop.ts` bisa diuji dengan mock `@tauri-apps/*` tanpa
 * menyentuh satu pun komponen.
 */

import type { ScnetModelDownloadProgress, ScnetModelId } from '../proof-stem/scnet-catalog';
import type { ExportSink } from '../studio/export/sinks';

export type PlatformKind = 'web' | 'desktop';

/**
 * Hasil "minta lokasi simpan" — diputuskan SEBELUM render dimulai, karena di
 * web picker-nya butuh gestur user yang hilang begitu kita menunggu batch
 * pertama (docs/03 §3d).
 *
 *   - `stream`    : ada tujuan yang menerima chunk satu per satu. Ukuran file
 *                   tidak lagi dibatasi RAM. Chromium (File System Access) dan
 *                   desktop (berkas lewat plugin-fs).
 *   - `blob`      : tidak ada tujuan streaming — Firefox/Safari, atau user
 *                   membatalkan picker di Chromium. Pemanggil menumpuk di
 *                   `BlobSink` lalu menyerahkan hasilnya ke `deliver`. Hanya
 *                   web yang pernah mengembalikan ini.
 *   - `cancelled` : user membatalkan dan TIDAK ada jalur cadangan. Hanya
 *                   desktop: dialog native yang dibatalkan berarti "jangan
 *                   simpan", bukan "simpan lewat cara lain".
 */
export type SaveTarget =
  | { readonly kind: 'stream'; readonly sink: ExportSink }
  | { readonly kind: 'blob'; readonly deliver: (blob: Blob) => void }
  | { readonly kind: 'cancelled' };

export interface OpenAudioFilesOptions {
  readonly multiple?: boolean;
  /** Ekstensi tanpa titik (`wav`, `mp3`) untuk penyaring dialog native. */
  readonly extensions?: readonly string[];
}

/** Titik jatuh dalam piksel CSS relatif viewport — satuan `clientX/clientY`. */
export interface DropPoint {
  readonly x: number;
  readonly y: number;
}

export interface LoginRequest {
  /** Base URL Worker kepustakaan, sudah tanpa slash penutup (`api.base`). */
  readonly apiBase: string;
  /** Path yang dititipkan supaya user kembali ke tempat ia menekan tombol. */
  readonly nextPath: string;
}

export interface ModelBytes {
  readonly bytes: Uint8Array;
  readonly cacheHit: boolean;
}

export interface PlatformHost {
  readonly kind: PlatformKind;

  /** Lihat [`SaveTarget`]. Dipanggil dari handler klik, sebelum render. */
  pickSaveTarget(fileName: string, mime: string, ext: string): Promise<SaveTarget>;

  /**
   * Buka tautan di LUAR aplikasi. Web: tab baru. Desktop: browser OS — tautan
   * yang dibuka di dalam WebView app tidak punya tombol "kembali".
   */
  openExternal(url: string): Promise<void>;

  /**
   * Mulai login Google.
   *
   * Web: NAVIGASI ke `/auth/google` (docs/16) — halaman ini dibongkar, jadi
   * promise-nya tidak pernah selesai. Desktop: browser OS + deep link + bearer
   * (docs/20 §1d); promise selesai saat token sudah tersimpan, dan melempar
   * kalau state tidak cocok atau penukaran kode ditolak.
   */
  login(req: LoginRequest): Promise<void>;

  /** Lupakan kredensial lokal. Web: tidak ada (cookie dicabut server). */
  logout(): Promise<void>;

  /**
   * Header yang harus ikut di SETIAP fetch ke Worker kepustakaan. Web: `{}` —
   * sesinya cookie. Desktop: `Authorization: Bearer`.
   */
  authHeaders(): Promise<Record<string, string>>;

  /** Byte model ONNX, dengan laporan kemajuan unduhan. */
  modelBytes(
    id: ScnetModelId,
    onProgress: (progress: ScnetModelDownloadProgress) => void,
  ): Promise<ModelBytes>;

  /**
   * Dialog pilih berkas native. OPSIONAL: host yang tidak punya (web) membiarkan
   * komponen memakai `<input type="file">` — satu-satunya cara membuka picker
   * yang bekerja di semua browser. `useAudioFilePicker` yang memilih.
   */
  openAudioFiles?(opts?: OpenAudioFilesOptions): Promise<readonly File[]>;

  /**
   * Berkas yang dijatuhkan dari luar aplikasi, sebagai `File` + titik jatuh.
   * OPSIONAL: di web, `drop` DOM sudah membawa `dataTransfer.files` dan
   * komponen menanganinya sendiri. Di desktop, WebView tidak menerima drop OS
   * sebagai event DOM — Tauri yang memberi PATH, dan host ini membacanya jadi
   * `File` supaya jalur import-nya tetap satu.
   */
  onFilesDropped?(cb: (files: readonly File[], point: DropPoint) => void): () => void;
}
