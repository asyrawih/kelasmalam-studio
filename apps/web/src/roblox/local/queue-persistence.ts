/**
 * `PersistenceAdapter` untuk DESKTOP: antrean adalah tabel `roblox_upload`
 * di SQLite, taksonomi dua tabel, katalog = baris `done`/`failed` — semuanya
 * lewat command Tauri dari kontrak `platform/local-commands.ts` (docs/21 §3b,
 * §3e). IndexedDB tidak dipakai sama sekali di sini.
 *
 * ## Byte draft TIDAK disimpan TS
 *
 * Di web, snapshot IndexedDB membawa Blob MP3-nya. Di desktop byte lagu ada di
 * kepustakaan (`tracks/<hash>`), dan baris antrean hanya menunjuk `hash`.
 * Karena itu berkas yang dijatuhkan user masuk kepustakaan DULU (`ingest`:
 * hash → `library_put_bytes` → `library_commit`), baru barisnya bisa ditulis
 * lewat `roblox_queue_put`. Sampai hash-nya ada, baris hanya hidup di memori.
 *
 * ## `save()` menulis yang BERUBAH, bukan seluruh snapshot
 *
 * Store memanggil `save` dengan snapshot penuh setiap ada perubahan (yang
 * sudah di-coalesce). Menulis semua baris tiap kali berarti N transaksi SQLite
 * untuk satu ketikan di kolom nama. Adapter mengingat bentuk terakhir tiap
 * baris yang ditulis dan hanya mengirim `roblox_queue_put` untuk yang beda.
 *
 * ## Id baris dibuat di TS
 *
 * Kontrak menyebut "id kosong = baris baru; Rust mengisi id". Adapter ini
 * SELALU mengirim `localId` yang sudah ada sejak baris lahir di store, dan
 * mengandalkan `roblox_queue_put` sebagai upsert untuk id yang belum dikenal.
 * Alasannya coalescing: kalau id datang dari Rust sesudah `put`, snapshot yang
 * sudah mengantre di belakangnya masih membawa baris tanpa id — dan `put`
 * kedua membuat baris duplikat. Id yang stabil sejak awal membuat setiap
 * `put` idempoten. Ini dicatat sebagai penyimpangan kecil dari kalimat
 * kontrak, bukan dari bentuknya.
 */

import type { RobloxUploadRow } from '../../platform/local-commands';
import { sha256Hex } from '../../studio/timeline/content-hash';
import { extOf, fromUploadRow, toUploadRow, type UploadStatus } from '../model';
import { isLocalError, type PersistedRobloxQueue, type PersistenceAdapter } from '../persistence';
import { localInvoke, localPutBytes } from './invoke';

/** Baris yang runner masih akan kirim, jadi byte-nya perlu ada di `fileOf`. */
const SENDABLE: ReadonlySet<UploadStatus> = new Set<UploadStatus>(['draft', 'queued', 'uploading', 'failed']);

const MIME_OF_EXT: Readonly<Record<string, string>> = {
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
};

type PutRow = Omit<RobloxUploadRow, 'createdAt' | 'updatedAt'>;

function stripTimes(row: RobloxUploadRow): PutRow {
  const { createdAt: _c, updatedAt: _u, ...rest } = row;
  return rest;
}

function keyOf(row: PutRow): string {
  return JSON.stringify(row);
}

export function createLocalQueuePersistence(): PersistenceAdapter {
  /** Bentuk terakhir tiap baris yang sudah sampai ke tabel, per `localId`. */
  const written = new Map<string, string>();
  let lastTarget: string | null = null;

  async function blobOf(hash: string, fileName: string): Promise<File | null> {
    const buf = await localInvoke('library_blob', { hash });
    return new File([buf], fileName, { type: MIME_OF_EXT[extOf(fileName)] ?? '' });
  }

  return {
    async load(): Promise<PersistedRobloxQueue | null> {
      const [rows, taxonomy, catalog, target] = await Promise.all([
        localInvoke('roblox_queue_list', {}),
        localInvoke('roblox_taxonomy_list', {}),
        localInvoke('roblox_catalog_list', {}),
        localInvoke('roblox_target_get', {}),
      ]);
      const items = rows.map((row, i) => fromUploadRow(row, i + 1));
      for (const row of rows) written.set(row.id, keyOf(stripTimes(row)));
      lastTarget = JSON.stringify(target);

      // Runner membaca `fileOf(id)` dan MELEWATI baris tanpa File; probe durasi
      // juga butuh byte-nya. Byte diambil hanya untuk baris yang masih akan
      // dikirim — baris `processing` tinggal dipoll, tidak butuh byte. Satu
      // yang gagal dibaca tidak menggagalkan restore: barisnya tetap muncul,
      // hanya tidak bisa dikirim sampai user menjatuhkannya lagi.
      const files: { id: number; file: File }[] = [];
      for (const it of items) {
        if (!SENDABLE.has(it.status) || it.hash === null) continue;
        const file = await blobOf(it.hash, it.fileName).catch(() => null);
        if (file !== null) files.push({ id: it.id, file });
      }

      return {
        items,
        selected: items[0]?.id ?? null,
        target: {
          creatorKind: target.creatorKind,
          creatorId: target.creatorId,
          genreToDescription: target.genreToDescription,
        },
        files,
        taxonomy,
        catalog,
      };
    },

    async save(value): Promise<void> {
      const now = Date.now();
      for (const it of value.items) {
        // Belum masuk kepustakaan: tidak ada `tracks/<hash>` yang bisa dirujuk.
        if (it.hash === null) continue;
        const row = stripTimes(toUploadRow(it, value.target, now));
        const key = keyOf(row);
        if (written.get(it.localId) === key) continue;
        await localInvoke('roblox_queue_put', { row });
        written.set(it.localId, key);
      }
      const targetJson = JSON.stringify(value.target);
      if (targetJson !== lastTarget) {
        await localInvoke('roblox_target_set', value.target);
        lastTarget = targetJson;
      }
    },

    async clear(): Promise<void> {
      // KOSONGKAN sudah memanggil `remove` per baris. Tabel tidak punya
      // "dokumen" yang bisa dihapus sekaligus — dan tidak boleh: baris
      // katalog hidup di tabel yang sama.
    },

    async remove(localIds): Promise<void> {
      for (const id of localIds) {
        written.delete(id);
        try {
          await localInvoke('roblox_queue_remove', { id });
        } catch (e: unknown) {
          // Baris yang belum pernah sampai ke tabel (hash masih null) atau
          // sudah hilang: tidak ada yang perlu dihapus.
          if (!(isLocalError(e) && e.code === 'NOT_FOUND')) throw e;
        }
      }
    },

    upsertCategory: (input) => localInvoke('roblox_category_upsert', input),
    deleteCategory: async (id) => {
      await localInvoke('roblox_category_delete', { id });
    },
    upsertGenre: (input) => localInvoke('roblox_genre_upsert', input),
    deleteGenre: async (id) => {
      await localInvoke('roblox_genre_delete', { id });
    },

    catalog: () => localInvoke('roblox_catalog_list', {}),

    async ingest(file) {
      const buffer = await file.arrayBuffer();
      const hash = await sha256Hex(buffer);
      if (!(await localInvoke('library_has', { hash }))) {
        const ext = extOf(file.name).replace(/^\./, '') || 'mp3';
        await localPutBytes(new Uint8Array(buffer), hash, ext);
        await localInvoke('library_commit', {
          hash,
          name: file.name,
          bytes: file.size,
          mime: file.type || (MIME_OF_EXT[extOf(file.name)] ?? 'application/octet-stream'),
          // 0 = tidak diketahui (kontrak). Durasi tetap diprobe `<audio>` di
          // halaman; kepustakaan boleh mengisinya belakangan.
          frames: 0,
          sampleRate: 0,
        });
      }
      return { hash };
    },

    blobOf,
  };
}
