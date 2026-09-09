/**
 * Import → kepustakaan. Fase L3 docs/16.
 *
 * Tiga langkah, dan yang pertama yang membuat seluruhnya sepadan:
 *
 *   1. `POST /tracks/init` — "hash ini sudah ada di R2?"
 *      └─ ya  → **tidak ada satu byte pun yang naik**
 *      └─ tidak → dapat URL bertanda tangan
 *   2. `PUT` langsung ke R2 (bukan lewat Worker — docs/16 §5c)
 *   3. `POST /tracks/commit` — catat klaim
 *
 * Langkah 3 tetap dijalankan pada KEDUA cabang: `exists` berarti byte-nya
 * sudah ada, bukan bahwa user ini sudah memilikinya. Objek R2 dipakai bersama
 * antar user; yang membuat lagu masuk kepustakaan seseorang adalah barisnya,
 * bukan objeknya.
 *
 * ## Antre, satu per satu
 *
 * Menjatuhkan lima lagu sekaligus berarti lima unggahan puluhan MB berebut
 * bandwidth yang sama: semuanya jadi lambat, dan bar progresnya berkedip
 * bergantian tanpa satu pun yang selesai lebih dulu. Berurutan membuat yang
 * pertama benar-benar selesai lebih dulu — dan kalau kuota habis di tengah
 * jalan, yang gagal hanya sisanya, bukan semuanya.
 */

import { MIME_OF_FORMAT } from '../studio/timeline/content-hash';
import type { ImportedForLibrary } from '../studio/timeline/import-sink';
import type { LibraryApi, TrackMeta } from './api';
import { libraryActions, libraryStore } from './store';

export type UploadOutcome =
  | { readonly ok: true; readonly skipped: false; readonly deduped: boolean }
  | { readonly ok: true; readonly skipped: true; readonly reason: string }
  | { readonly ok: false; readonly message: string };

/**
 * Jalur cepat kepustakaan LOKAL (docs/21 §1c, §2c): berkas yang dijatuhkan
 * dari Finder sudah ada di disk, jadi Rust menyalin + meng-hash-nya sendiri
 * lewat `library_import_path`. Yang dihindari adalah `library_put_bytes` —
 * mengirim balik lewat IPC byte yang baru saja dibaca dari berkas yang sama.
 *
 * Hasilnya `null` kalau jalur ini tidak berlaku, dan pemanggil jatuh ke
 * init/put/commit biasa. Itu terjadi kalau:
 *   - hash yang dihitung Rust ≠ hash sesi — berkas gzip yang dibuka WebView
 *     (yang di-hash adalah isi sesudah gunzip), atau berkas di disk berubah
 *     di antara baca dan import. Baris yang Rust tulis untuk hash lain itu
 *     dibiarkan: ia lagu yang sah di kepustakaan, cuma bukan yang ini.
 *   - Rust menolak (path sudah hilang, disk penuh): jalur biasa mencoba lagi
 *     dengan byte yang sudah ada di memori, dan kalau ITU juga gagal, barulah
 *     bar unggahan memerah — satu kegagalan yang bisa diperbaiki jalur lain
 *     bukan kegagalan yang perlu diumumkan.
 */
async function importViaPath(
  api: LibraryApi,
  path: string,
  imported: ImportedForLibrary,
  meta: TrackMeta,
): Promise<UploadOutcome | null> {
  if (api.importPath === undefined) return null;
  libraryActions.setUploadPhase(imported.contentHash, 'mencatat');
  let got;
  try {
    got = await api.importPath(path);
  } catch {
    return null;
  }
  if (got.hash !== imported.contentHash) return null;
  if (got.frames === 0 && meta.frames > 0) {
    // Rust belum tentu bisa membaca durasi dari header (docs/21 §5); sesi ini
    // sudah men-decode-nya, jadi barisnya dilengkapi lewat commit biasa.
    await api.commitTrack(meta);
  }
  libraryActions.endUpload(imported.contentHash);
  return { ok: true, skipped: false, deduped: got.existed };
}

export async function uploadImported(
  api: LibraryApi,
  imported: ImportedForLibrary,
  /** Path asli di disk kalau host tahu (`PlatformHost.droppedPathFor`). */
  localPath: string | null = null,
): Promise<UploadOutcome> {
  const { contentHash, name, bytes, format, frames, sampleRate } = imported;

  if (contentHash === '') {
    // Hasil bake: tidak punya berkas asal, jadi tidak ada yang bisa diunggah
    // sebagai dirinya sendiri. Keputusan soal ini sengaja masih terbuka (§8e).
    return { ok: true, skipped: true, reason: 'tidak punya berkas asal' };
  }

  const mime = MIME_OF_FORMAT[format];
  if (mime === undefined) {
    // Diimpor dan dipakai penuh di sesi ini — yang tidak bisa cuma diunggah.
    return { ok: true, skipped: true, reason: `format ${format} belum didukung kepustakaan` };
  }

  const meta = {
    hash: contentHash,
    name,
    bytes: bytes.byteLength,
    mime,
    frames,
    sampleRate,
  };

  libraryActions.beginUpload(contentHash, name);
  try {
    if (localPath !== null) {
      const fast = await importViaPath(api, localPath, imported, meta);
      if (fast !== null) return fast;
      libraryActions.setUploadPhase(contentHash, 'memeriksa');
    }

    const init = await api.initTrack(meta);

    if (!init.exists) {
      if (init.uploadUrl === null) {
        return {
          ok: false,
          message: 'server tidak memberi alamat unggah',
        };
      }
      libraryActions.setUploadPhase(contentHash, 'mengunggah');
      await api.putUpload(init.uploadUrl, bytes, mime, (percent) => {
        libraryActions.setUploadProgress(contentHash, percent);
      });
    }

    libraryActions.setUploadPhase(contentHash, 'mencatat');
    await api.commitTrack(meta);

    libraryActions.endUpload(contentHash);
    return { ok: true, skipped: false, deduped: init.exists };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    libraryActions.failUpload(contentHash, message);
    return { ok: false, message };
  }
}

/**
 * Antrean unggah — satu jalur, dipakai bersama semua import.
 *
 * Dibuat sebagai closure, bukan modul global dengan state: dok bisa dibongkar
 * pasang (route berganti, tes berjalan berkali-kali), dan antrean yang hidup
 * di lingkup modul akan membawa sisa pekerjaan dari kehidupan sebelumnya.
 */
export interface UploadQueue {
  push(imported: ImportedForLibrary): void;
  /** Untuk tes: selesai saat antrean berhenti berjalan. */
  idle(): Promise<void>;
}

export interface UploadQueueOptions {
  /**
   * Path asli berkas yang baru diimpor, kalau host tahu. Ditanya SAAT `push`,
   * bukan saat gilirannya tiba: entri path di host dipakai sekali dan
   * kedaluwarsa, dan antrean yang panjang tidak boleh membuat berkas kelima
   * kehilangan jalur cepatnya.
   */
  readonly pathOf?: (imported: ImportedForLibrary) => string | null;
}

export function createUploadQueue(api: LibraryApi, opts: UploadQueueOptions = {}): UploadQueue {
  const pending: { imported: ImportedForLibrary; path: string | null }[] = [];
  let running: Promise<void> | null = null;

  const drain = async (): Promise<void> => {
    for (;;) {
      const next = pending.shift();
      if (next === undefined) return;
      // Hasilnya sudah tercatat ke store oleh `uploadImported`; di sini ia
      // sengaja diabaikan supaya satu kegagalan tidak menghentikan antrean.
      await uploadImported(api, next.imported, next.path);
    }
  };

  return {
    push(imported) {
      // Sudah ada di kepustakaan sesi ini? Tidak perlu diunggah lagi. Ini
      // menangkap kasus "unduh dari kepustakaan lalu taruh ulang", yang kalau
      // tidak akan mengirim balik byte yang baru saja diunduh dari sana.
      if (libraryStore.getState().loaded[imported.contentHash] !== undefined) return;

      pending.push({ imported, path: opts.pathOf?.(imported) ?? null });
      if (running !== null) return;
      running = drain().finally(() => {
        running = null;
      });
    },
    idle: async () => {
      await running;
    },
  };
}
