/**
 * Penyimpanan halaman ROBLOX di WEB: satu dokumen di IndexedDB.
 *
 * Berkas ini punya dua isi. Yang pertama `PersistenceAdapter` — permukaan yang
 * dipakai `store.ts` untuk SEMUA yang harus bertahan melewati refresh/restart:
 * antrean, taksonomi, katalog, dan target. Yang kedua implementasi web-nya:
 * IndexedDB, kode lama yang dipindah apa adanya, ditambah taksonomi dan
 * katalog yang ikut di dokumen yang sama.
 *
 * Desktop mengimplementasikan adapter yang sama di atas command Tauri
 * (`local/queue-persistence.ts`, docs/21 §3b): di sana antrean adalah TABEL
 * dan byte draft tidak pernah lewat TS. Store memilih salah satunya lewat
 * `getPlatformHost().kind`, dan tidak ada satu pun komponen yang tahu bedanya
 * — itulah yang membuat tab KATALOG dan TAKSONOMI satu UI untuk dua platform.
 */

import type {
  LocalError,
  RobloxCategory,
  RobloxGenre,
  RobloxTaxonomy,
  RobloxUploadRow,
} from '../platform/local-commands';
import { toUploadRow, type QueueItem, type RobloxTarget } from './model';

const DB_NAME = 'dawonweb-roblox-upload';
const STORE = 'queue';
const KEY = 'current';

export interface PersistedRobloxQueue {
  readonly items: readonly QueueItem[];
  readonly selected: number | null;
  readonly target: Omit<RobloxTarget, 'apiKey'>;
  readonly files: readonly { readonly id: number; readonly file: File }[];
  /** Opsional karena dokumen IndexedDB lama belum punya keduanya. */
  readonly taxonomy?: RobloxTaxonomy;
  readonly catalog?: readonly RobloxUploadRow[];
}

/** Hasil memasukkan satu berkas ke kepustakaan lokal (desktop). */
export interface IngestedFile {
  readonly hash: string;
}

/** Penggunaan yang menahan penghapusan — angka yang disebut di pesan `IN_USE`. */
export interface CategoryUsage {
  readonly genres: number;
  readonly uploads: number;
}

export interface CategoryInput {
  readonly id?: string;
  readonly name: string;
  readonly sort?: number;
}

export interface GenreInput {
  readonly id?: string;
  readonly categoryId: string;
  readonly name: string;
  readonly sort?: number;
}

export interface PersistenceAdapter {
  /** `null` = belum pernah ada yang disimpan. */
  load(): Promise<PersistedRobloxQueue | null>;
  save(value: PersistedRobloxQueue): Promise<void>;
  clear(): Promise<void>;

  // ── Taksonomi (docs/21 §1d) ─────────────────────────────────────────────
  //
  // Desktop: Rust yang memutuskan (termasuk menolak hapus dengan `IN_USE`).
  // Web: adapter ini yang memutuskan dari angka penggunaan yang dihitung
  // store — supaya pesan yang dilihat user sama bentuknya di dua platform.
  upsertCategory(input: CategoryInput): Promise<RobloxCategory>;
  deleteCategory(id: string, usage: CategoryUsage): Promise<void>;
  upsertGenre(input: GenreInput): Promise<RobloxGenre>;
  deleteGenre(id: string, usedBy: number): Promise<void>;

  // ── Antrean & katalog ───────────────────────────────────────────────────

  /**
   * Hapus baris secara EKSPLISIT. `save()` sengaja tidak menyimpulkan
   * penghapusan dari baris yang hilang di snapshot: BERSIHKAN SELESAI membuang
   * baris `done` dari antrean di layar, tapi baris itu justru harus tetap ada
   * di tabel — ia isi katalog. Hanya HAPUS dan KOSONGKAN yang sampai ke sini.
   */
  remove(localIds: readonly string[]): Promise<void>;
  /**
   * Katalog terkini. Desktop: `roblox_catalog_list`. Web: baris `done`/`failed`
   * dari snapshot digabung (upsert per `localId`) ke katalog yang tersimpan.
   */
  catalog(snapshot: PersistedRobloxQueue): Promise<readonly RobloxUploadRow[]>;
  /**
   * OPSIONAL — hanya desktop: masukkan byte berkas ke kepustakaan dan
   * kembalikan hash-nya (docs/21 §3b: baris draft merujuk `tracks/<hash>`,
   * byte TIDAK disimpan TS). Ketiadaannya berarti byte tinggal di adapter
   * (IndexedDB) dan `hash` baris tetap `null`.
   */
  ingest?(file: File): Promise<IngestedFile>;
  /** OPSIONAL — hanya desktop: byte lagu kepustakaan sebagai `File`, untuk "coba lagi" dari katalog. */
  blobOf?(hash: string, fileName: string): Promise<File | null>;
}

/**
 * Galat berbentuk `LocalError` (kontrak `platform/local-commands.ts`) yang
 * bisa dilempar dari TS. `invoke` di desktop menolak dengan objek polos
 * `{ code, message }`; class ini memberi web bentuk yang sama, jadi pemanggil
 * cukup memeriksa `isLocalError` tanpa peduli dari mana galatnya datang.
 */
export class LocalCommandError extends Error implements LocalError {
  readonly code: LocalError['code'];
  readonly count?: number;
  constructor(code: LocalError['code'], message: string, count?: number) {
    super(message);
    this.name = 'LocalCommandError';
    this.code = code;
    if (count !== undefined) this.count = count;
  }
}

export function isLocalError(e: unknown): e is LocalError {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as { code?: unknown }).code === 'string' &&
    typeof (e as { message?: unknown }).message === 'string'
  );
}

/** Pesan yang layak dibaca user, dari apa pun yang ditolak `invoke`. */
export function messageOfLocalError(e: unknown): string {
  if (isLocalError(e)) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Id acak untuk baris taksonomi buatan user di web (desktop: Rust). */
export function randomId(prefix: string): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return `${prefix}:${c.randomUUID()}`;
  return `${prefix}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ── IndexedDB ──────────────────────────────────────────────────────────────

function database(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadRobloxQueue(): Promise<PersistedRobloxQueue | null> {
  const db = await database();
  if (db === null) return null;
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve((req.result as PersistedRobloxQueue | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function saveRobloxQueue(value: PersistedRobloxQueue): Promise<void> {
  const db = await database();
  if (db === null) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function clearRobloxQueue(): Promise<void> {
  const db = await database();
  if (db === null) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

// ── Adapter web ────────────────────────────────────────────────────────────

export function createWebPersistence(): PersistenceAdapter {
  return {
    load: loadRobloxQueue,
    save: saveRobloxQueue,
    clear: clearRobloxQueue,

    async upsertCategory(input): Promise<RobloxCategory> {
      const name = input.name.trim();
      if (name === '') throw new LocalCommandError('INVALID', 'nama kategori tidak boleh kosong');
      return { id: input.id ?? randomId('kat'), name, sort: input.sort ?? 0 };
    },

    async deleteCategory(_id, usage): Promise<void> {
      const parts: string[] = [];
      if (usage.genres > 0) parts.push(`${usage.genres} genre`);
      if (usage.uploads > 0) parts.push(`${usage.uploads} lagu`);
      if (parts.length > 0) {
        throw new LocalCommandError(
          'IN_USE',
          `kategori masih dipakai ${parts.join(' dan ')} — pindahkan atau hapus dulu`,
          usage.genres + usage.uploads,
        );
      }
    },

    async upsertGenre(input): Promise<RobloxGenre> {
      const name = input.name.trim();
      if (name === '') throw new LocalCommandError('INVALID', 'nama genre tidak boleh kosong');
      return { id: input.id ?? randomId('gen'), categoryId: input.categoryId, name, sort: input.sort ?? 0 };
    },

    async deleteGenre(_id, usedBy): Promise<void> {
      if (usedBy > 0) {
        throw new LocalCommandError(
          'IN_USE',
          `genre masih dipakai ${usedBy} lagu — ganti genre lagunya dulu`,
          usedBy,
        );
      }
    },

    async remove(): Promise<void> {
      // Baris web hidup di dokumen antrean; `save()` berikutnya sudah tidak
      // memuatnya. Tidak ada tabel yang harus dibersihkan.
    },

    async catalog(snapshot): Promise<readonly RobloxUploadRow[]> {
      return mergeCatalog(snapshot);
    },
  };
}

/**
 * Katalog web = katalog tersimpan + baris `done`/`failed` di antrean, upsert
 * per `localId`. Baris yang di-ULANGI lalu disetujui menimpa catatan gagalnya
 * sendiri, bukan menambah baris kedua. Urutan: terbaru di atas.
 */
export function mergeCatalog(snapshot: PersistedRobloxQueue): readonly RobloxUploadRow[] {
  const now = Date.now();
  const byId = new Map<string, RobloxUploadRow>();
  for (const row of snapshot.catalog ?? []) byId.set(row.id, row);
  for (const it of snapshot.items) {
    if (it.status !== 'done' && it.status !== 'failed') continue;
    const before = byId.get(it.localId);
    const row = toUploadRow(it, snapshot.target, now);
    byId.set(it.localId, before === undefined ? row : { ...row, createdAt: before.createdAt });
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}
