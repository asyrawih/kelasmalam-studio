/**
 * Kontrak adapter platform (docs/20 §2c).
 *
 * Satu frontend, dua kulit: web (Vercel) dan desktop (Tauri 2). Semua yang
 * berbeda di antara keduanya — ke mana berkas export ditulis, bagaimana lagu
 * masuk, bagaimana login berjalan, dari mana byte model datang — masuk lewat
 * SATU objek ini. Pemanggil tidak pernah bertanya "ini Tauri?" sendiri; kalau
 * sebuah komponen butuh cabang web/desktop, cabang itu ditulis di sini, bukan
 * di komponennya. Itu yang membuat `web.ts` bisa dijamin "kode lama dipindah
 * apa adanya" dan `desktop.ts` bisa diuji dengan mock API Tauri tanpa
 * menyentuh satu pun komponen.
 */

import type { ExportSink } from './export-sink';

export type PlatformKind = 'web' | 'desktop';

/**
 * Id model SCNet yang bisa diminta lewat [`PlatformHost.modelBytes`].
 *
 * Tinggal di KONTRAK, bukan di katalog `proof-stem`: daftar id ini adalah
 * bagian dari apa yang dijanjikan host (desktop menjawab `model_download`
 * untuk id ini), dan platform tidak boleh mengimpor paket halaman (docs/25
 * §1b). Katalog `proof-stem/scnet-catalog.ts` mengekspornya ulang dan
 * `SCNET_MODELS: Record<ScnetModelId, …>` memaksa katalog menutupi semua id.
 */
export type ScnetModelId = 'base' | 'large';

export interface ScnetModelDownloadProgress {
  readonly loaded: number;
  readonly total: number;
  readonly cacheHit: boolean;
}

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
   * Unduh sebuah URL lewat mekanisme platform. OPSIONAL: host yang tidak punya
   * membiarkan `<a download>` bekerja — satu-satunya cara di browser, dan
   * cukup. Desktop punya: WebView tidak mengunduh dari anchor, jadi tautannya
   * dibuka di browser OS yang menangani unduhannya sendiri.
   */
  downloadUrl?(url: string): Promise<void>;

  /**
   * Header yang harus ikut di SETIAP fetch ke Worker kepustakaan. Web: `{}` —
   * sesinya cookie. Desktop: juga `{}` untuk sekarang; ini titik sambung
   * bearer token begitu alur login desktop ada (docs/20 §1d, ditunda).
   */
  authHeaders(): Promise<Record<string, string>>;

  /**
   * Mulai login Google. Web: NAVIGASI ke `/auth/google` (docs/16) — halaman
   * ini dibongkar, jadi promise-nya tidak pernah selesai.
   *
   * OPSIONAL, dan ketiadaannya BERARTI SESUATU: host tanpa `login` tidak punya
   * cara membangun sesi kepustakaan sama sekali, dan dok kepustakaan
   * menampilkan keadaan "belum tersedia" alih-alih tombol yang tidak bisa
   * berbuat apa-apa. Desktop hari ini begitu: alur login desktop ditunda
   * (dari origin `tauri://` cookie tidak pernah ikut), dan kode login yang
   * belum punya backend adalah kode mati yang tidak bisa diuji sungguhan.
   */
  login?(req: LoginRequest): Promise<void>;

  /**
   * Byte model ONNX, dengan laporan kemajuan unduhan.
   *
   * OPSIONAL, dan ketiadaannya BERARTI SESUATU: host yang tidak punya ini
   * membiarkan worker inferensi mengambil modelnya sendiri (fetch `/models/…`
   * + cache OPFS, `proof-stem/scnet-model.ts`) — jalur yang bekerja di
   * browser mana pun tanpa bantuan siapa pun. Host yang PUNYA ini (desktop:
   * unduhan sisi Rust ke `appDataDir()`) hanya bisa dipanggil dari main thread
   * (IPC tidak ada di worker), jadi main thread memanggilnya lebih dulu dan
   * mengirim byte-nya ke worker sebagai transferable. Pemanggil bertanya
   * "host ini punya `modelBytes`?", bukan "ini desktop?".
   */
  modelBytes?(
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

  /**
   * Path asli berkas yang baru dijatuhkan/dipilih, untuk jalur cepat
   * `library_import_path` (docs/21 §2c): Rust menyalin dan meng-hash berkasnya
   * sendiri, jadi byte-nya tidak perlu dikirim BALIK lewat IPC.
   *
   * Dicari lewat `(name, size)`, bukan lewat objek `File`: jalur import
   * (`readFileBytes` → `importBytesToAsset` → `notifyImported`) sudah melepas
   * `File`-nya sebelum kepustakaan mendengar kabarnya, dan yang sampai ke sana
   * hanya nama + byte. Satu entri dipakai SEKALI — drop berkas yang sama dua
   * kali memberi dua entri. Entri yang tidak pernah diklaim (import gagal
   * decode, zona lain yang tidak mengumumkan) kedaluwarsa sendiri.
   *
   * OPSIONAL: hanya host yang menerima berkas sebagai path yang punya ini.
   */
  droppedPathFor?(name: string, size: number): string | null;
}
