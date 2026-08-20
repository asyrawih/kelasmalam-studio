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
import type { LibraryApi } from './api';
import { libraryActions, libraryStore } from './store';

export type UploadOutcome =
  | { readonly ok: true; readonly skipped: false; readonly deduped: boolean }
  | { readonly ok: true; readonly skipped: true; readonly reason: string }
  | { readonly ok: false; readonly message: string };

export async function uploadImported(
  api: LibraryApi,
  imported: ImportedForLibrary,
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

export function createUploadQueue(api: LibraryApi): UploadQueue {
  const pending: ImportedForLibrary[] = [];
  let running: Promise<void> | null = null;

  const drain = async (): Promise<void> => {
    for (;;) {
      const next = pending.shift();
      if (next === undefined) return;
      // Hasilnya sudah tercatat ke store oleh `uploadImported`; di sini ia
      // sengaja diabaikan supaya satu kegagalan tidak menghentikan antrean.
      await uploadImported(api, next);
    }
  };

  return {
    push(imported) {
      // Sudah ada di kepustakaan sesi ini? Tidak perlu diunggah lagi. Ini
      // menangkap kasus "unduh dari kepustakaan lalu taruh ulang", yang kalau
      // tidak akan mengirim balik byte yang baru saja diunduh dari sana.
      if (libraryStore.getState().loaded[imported.contentHash] !== undefined) return;

      pending.push(imported);
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
