/**
 * Store halaman ROBLOX — `useSyncExternalStore` dengan langganan ber-selector,
 * pola yang sama dengan `studio/store.ts` dan `dj/store.ts`. Tidak ada pustaka,
 * tidak ada Context.
 *
 * ## Berkasnya TIDAK tinggal di state
 *
 * `File` yang dijatuhkan user disimpan di `Map` di lingkup modul, dan state
 * hanya memegang `id`-nya. Alasannya bukan gaya: state disalin utuh (`{...s}`)
 * pada setiap ketikan di kolom nama, dan objek `File` yang ikut mengalir ke
 * dalam salinan itu membuat setiap perubahan kecil menyeret referensi ke
 * puluhan MB byte. Selain itu `File` tidak bisa dibandingkan dengan berarti,
 * jadi ia tidak punya urusan di dalam nilai yang dipakai untuk memutuskan
 * "apakah ada yang berubah".
 *
 * Pemasang backend mengambil byte-nya lewat `fileOf(id)`.
 *
 * ## API key di state hanya salinan aktif
 *
 * Web: Library Worker menyimpannya terenkripsi di D1 per akun Google; store
 * hanya memegang salinan aktif selama halaman digunakan. Desktop: kolomnya
 * dikosongkan begitu kunci pindah ke keychain OS (docs/21 §1f), dan
 * `apiKeyStored` yang menandai bahwa kuncinya ada.
 *
 * ## Satu adapter, dua platform (docs/21 §3b)
 *
 * Semua yang harus bertahan melewati refresh/restart — antrean, taksonomi,
 * katalog, target — lewat SATU `PersistenceAdapter`: IndexedDB di web,
 * command Tauri di desktop. Dipilih lazy dari `getPlatformHost().kind` saat
 * pertama dibutuhkan, bukan saat modul dimuat, supaya tes bisa menukar host
 * lebih dulu. Tidak ada satu pun komponen yang tahu adapter mana yang aktif.
 *
 * ## Seam untuk lapisan unggah
 *
 * `markQueued`/`markUploading`/`markProgress`/`markProcessing`/`markDone`/
 * `markFailed` sudah lengkap dan tidak dipakai UI ini untuk apa pun selain
 * merender. Itu seluruh permukaan yang dibutuhkan pengunggah: ia membaca
 * `readyItems(state)`, mengambil byte lewat `fileOf`, lalu melapor balik.
 */

import { useSyncExternalStore } from 'react';

import { getPlatformHost } from '../platform';
import type { RobloxGenre, RobloxTaxonomy, RobloxUploadRow } from '../platform/local-commands';
import {
  baseNameOf,
  createInitialRoblox,
  isAudioFile,
  type CatalogFilter,
  type CreatorKind,
  type QueueItem,
  type RobloxState,
  type UploadStatus,
} from './model';
import {
  createWebPersistence,
  messageOfLocalError,
  randomId,
  type PersistedRobloxQueue,
  type PersistenceAdapter,
} from './persistence';
import { createLocalQueuePersistence } from './local/queue-persistence';

// ── Inti store ───────────────────────────────────────────────────────────────

let state: RobloxState = createInitialRoblox();

type Listener = () => void;
const listeners = new Set<Listener>();

function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function getState(): RobloxState {
  return state;
}

/** `patch` boleh mengembalikan `null` untuk "tidak ada yang berubah". */
function set(patch: (s: RobloxState) => Partial<RobloxState> | null): void {
  const before = state;
  const next = patch(state);
  if (next === null) return;
  state = { ...state, ...next };
  for (const fn of [...listeners]) fn();
  // Status koneksi, kuota, penyaring katalog, dan API key tidak termasuk
  // dokumen yang disimpan. Selain menjaga kredensial agar tidak tersimpan, ini
  // mencegah probe `/health` menimpa snapshot IndexedDB dengan state kosong
  // saat hydration masih jalan.
  if (
    state.items !== before.items ||
    state.selected !== before.selected ||
    state.taxonomy !== before.taxonomy ||
    state.catalog !== before.catalog ||
    state.target.creatorKind !== before.target.creatorKind ||
    state.target.creatorId !== before.target.creatorId ||
    state.target.genreToDescription !== before.target.genreToDescription
  ) persist();
}

export const robloxStore = { getState, subscribe };

export function useRoblox(): RobloxState;
export function useRoblox<T>(selector: (s: RobloxState) => T): T;
export function useRoblox<T>(selector?: (s: RobloxState) => T): T | RobloxState {
  return useSyncExternalStore(
    subscribe,
    () => (selector === undefined ? state : selector(state)),
    () => (selector === undefined ? state : selector(state)),
  );
}

// ── Byte berkas, di luar state ───────────────────────────────────────────────

const files = new Map<number, File>();
let nextId = 1;

/**
 * Persistence coalescing: progress XHR bisa melapor puluhan kali per detik.
 * Menulis snapshot lengkap (termasuk Blob audio) untuk SETIAP persen membuat
 * status `done + assetId` mengantre di belakang puluhan transaksi besar. Kalau
 * halaman direfresh setelah UI berkata sukses, IndexedDB masih bisa berisi
 * snapshot `uploading` lama.
 *
 * Di sini hanya satu transaksi aktif dan satu snapshot TERBARU yang menunggu.
 * Snapshot tengah dibuang; status akhir tidak pernah harus mengejar backlog.
 * Aturan yang sama berlaku untuk desktop: `roblox_queue_put` per persen adalah
 * ratusan transaksi SQLite untuk satu baris.
 */
type PersistJob = () => Promise<void>;
interface CriticalPersist {
  readonly job: PersistJob;
  readonly done: () => void;
}
let persistence: PersistenceAdapter | null = null;
let pendingPersist: PersistJob | null = null;
const criticalPersists: CriticalPersist[] = [];
let activePersist: Promise<void> | null = null;

/** Adapter aktif, dipilih saat pertama dibutuhkan (lihat kepala berkas). */
function adapter(): PersistenceAdapter {
  persistence ??= getPlatformHost().kind === 'desktop' ? createLocalQueuePersistence() : createWebPersistence();
  return persistence;
}

function enqueuePersist(job: PersistJob): Promise<void> {
  pendingPersist = job;
  if (activePersist !== null) return activePersist;
  activePersist = (async () => {
    while (pendingPersist !== null || criticalPersists.length > 0) {
      const critical = criticalPersists.shift();
      if (critical !== undefined) {
        // Snapshot progress yang lebih tua tidak boleh menimpa commit status
        // penting. Update yang datang SAAT transaksi berjalan juga dibuang;
        // publish state sesudah commit akan menjadwalkan snapshot gabungan baru.
        pendingPersist = null;
        await critical.job().catch(() => {});
        pendingPersist = null;
        critical.done();
        continue;
      }
      const latest = pendingPersist;
      pendingPersist = null;
      // Storage yang tidak tersedia tidak boleh menggagalkan upload Roblox.
      if (latest !== null) await latest().catch(() => {});
    }
  })().finally(() => {
    activePersist = null;
    // Tidak ada `await` di antara pengecekan terakhir dan finally, tetapi jaga
    // juga pemanggil yang datang dari callback penyelesaian Promise.
    if (pendingPersist !== null || criticalPersists.length > 0) {
      void enqueuePersist(pendingPersist ?? (async () => {}));
    }
  });
  return activePersist;
}

/** Commit yang tidak boleh di-coalesce atau ditimpa snapshot progress. */
function persistCritical(job: PersistJob): Promise<void> {
  return new Promise<void>((resolve) => {
    criticalPersists.push({ job, done: resolve });
    // Menyalakan loop tanpa mengganti pending snapshot yang sudah ada.
    if (activePersist === null) void enqueuePersist(async () => {});
  });
}

function persistedValue(snapshot: RobloxState): PersistedRobloxQueue {
  return {
    items: snapshot.items,
    selected: snapshot.selected,
    target: {
      creatorKind: snapshot.target.creatorKind,
      creatorId: snapshot.target.creatorId,
      genreToDescription: snapshot.target.genreToDescription,
    },
    files: snapshot.items.flatMap((it) => {
      const file = files.get(it.id);
      return file === undefined ? [] : [{ id: it.id, file }];
    }),
    taxonomy: snapshot.taxonomy,
    catalog: snapshot.catalog,
  };
}

function persist(): Promise<void> {
  const value = persistedValue(state);
  return enqueuePersist(() => adapter().save(value));
}

/**
 * Dokumen IndexedDB dari versi sebelum taksonomi tidak punya kolom-kolom
 * baru. `undefined` di `categoryId` akan lolos `=== null` dan membuat baris
 * lama tampak sudah berkategori — jadi setiap kolom dinormalkan di sini.
 */
function normalizeItem(it: QueueItem): QueueItem {
  return {
    ...it,
    categoryId: it.categoryId ?? null,
    genreId: it.genreId ?? null,
    localId: typeof it.localId === 'string' && it.localId !== '' ? it.localId : randomId('rbx'),
    hash: it.hash ?? null,
    operationId: it.operationId ?? null,
  };
}

/** Pulihkan antrean sebelum route mulai melanjutkan polling moderasi. */
export async function restoreRobloxQueue(): Promise<void> {
  const saved = await adapter().load().catch(() => null);
  if (saved === null) return;
  files.clear();
  for (const entry of saved.files) files.set(entry.id, entry.file);
  const items = saved.items.map(normalizeItem).map((it) => {
    // Request yang putus sebelum operationId diterima tidak aman diteruskan
    // otomatis. Biarkan user melihat penjelasannya dan memutuskan sendiri.
    if (it.status === 'queued' || it.status === 'uploading') {
      // Versi baru menyimpan assetId provisional segera setelah server upload
      // menjawab. Kalau snapshot lama punya cukup konteks untuk polling, pulih
      // sebagai processing alih-alih menyuruh user mengunggah duplikat.
      if (it.assetId !== null && it.operationId !== null) {
        return withStatus(it, 'processing', { progress: 100, error: null });
      }
      return withStatus(it, 'failed', {
        error: 'Halaman dimuat ulang saat unggah berjalan — periksa Creator Hub sebelum mengulang',
      });
    }
    return it;
  });
  nextId = Math.max(1, ...items.map((it) => it.id + 1));
  state = {
    ...state,
    items,
    selected: items.some((it) => it.id === saved.selected) ? saved.selected : (items[0]?.id ?? null),
    target: { ...state.target, ...saved.target },
    taxonomy: saved.taxonomy ?? state.taxonomy,
    catalog: saved.catalog ?? state.catalog,
  };
  for (const fn of [...listeners]) fn();
}

/** Byte berkas satu baris. `undefined` kalau barisnya sudah dihapus. */
export function fileOf(id: number): File | undefined {
  return files.get(id);
}

// ── Helper mutasi ────────────────────────────────────────────────────────────

/**
 * Ganti SATU baris. Baris yang tidak disentuh mengembalikan objek yang SAMA,
 * jadi `QueueRow` yang di-memo tidak ikut render saat tetangganya berubah.
 */
function patchItem(
  s: RobloxState,
  id: number,
  fn: (it: QueueItem) => QueueItem,
): Partial<RobloxState> | null {
  const idx = s.items.findIndex((it) => it.id === id);
  const before = s.items[idx];
  // `idx < 0` DAN `before === undefined` adalah pertanyaan yang sama, tapi hanya
  // yang kedua yang menyempitkan tipenya. Aksi untuk baris yang sudah dihapus
  // (laporan pengunggah yang datang terlambat) berakhir di sini, diam-diam.
  if (before === undefined) return null;
  const after = fn(before);
  if (after === before) return null;
  const items = s.items.slice();
  items[idx] = after;
  return { items };
}

/** Ganti BEBERAPA baris sekaligus; yang tidak berubah tetap objek yang sama. */
function patchItems(
  s: RobloxState,
  ids: readonly number[],
  fn: (it: QueueItem) => QueueItem,
): Partial<RobloxState> | null {
  const wanted = new Set(ids);
  let changed = false;
  const items = s.items.map((it) => {
    if (!wanted.has(it.id)) return it;
    const after = fn(it);
    if (after !== it) changed = true;
    return after;
  });
  return changed ? { items } : null;
}

/** Ubah status baris, kecuali kalau ia sudah persis begitu. */
function withStatus(it: QueueItem, status: UploadStatus, extra: Partial<QueueItem> = {}): QueueItem {
  return { ...it, status, ...extra };
}

/** Berapa baris (antrean + katalog) yang memakai satu genre / kategori. */
function usageOfGenre(s: RobloxState, genreId: string): number {
  return s.items.filter((it) => it.genreId === genreId).length + s.catalog.filter((r) => r.genreId === genreId).length;
}
function usageOfCategory(s: RobloxState, categoryId: string): { genres: number; uploads: number } {
  return {
    genres: s.taxonomy.genres.filter((g) => g.categoryId === categoryId).length,
    uploads:
      s.items.filter((it) => it.categoryId === categoryId).length +
      s.catalog.filter((r) => r.categoryId === categoryId).length,
  };
}

/** Hasil aksi taksonomi: id baris yang disentuh, atau kalimat untuk user. */
export type TaxonomyResult = { readonly ok: true; readonly id: string } | { readonly ok: false; readonly message: string };

function failure(e: unknown): TaxonomyResult {
  return { ok: false, message: messageOfLocalError(e) };
}

function newQueueItem(fileName: string, bytes: number, extra: Partial<QueueItem> = {}): QueueItem {
  return {
    id: nextId++,
    localId: randomId('rbx'),
    hash: null,
    fileName,
    bytes,
    seconds: null,
    name: baseNameOf(fileName),
    description: '',
    status: 'draft',
    progress: 0,
    error: null,
    assetId: null,
    operationId: null,
    categoryId: null,
    genreId: null,
    ...extra,
  };
}

/**
 * Desktop: byte masuk kepustakaan dulu (`tracks/<hash>`), baru barisnya bisa
 * ditulis ke tabel. Berjalan di latar per berkas; kegagalannya mendarat di
 * baris yang bersangkutan sebagai GAGAL dengan alasannya, bukan menjatuhkan
 * seluruh drop.
 */
function ingestInBackground(id: number, file: File): void {
  const ingest = adapter().ingest;
  if (ingest === undefined) return;
  void ingest(file)
    .then(({ hash }) => {
      set((s) => patchItem(s, id, (it) => (it.hash === hash ? it : { ...it, hash })));
    })
    .catch((e: unknown) => {
      set((s) =>
        patchItem(s, id, (it) =>
          withStatus(it, 'failed', { error: `tidak bisa masuk kepustakaan: ${messageOfLocalError(e)}` }),
        ),
      );
    });
}

// Method di bawah saling memanggil lewat `robloxActions.x`, BUKAN `this`:
// komponen meneruskannya lepas (`onRetry={robloxActions.retry}`), dan `this`
// pada fungsi yang dilepas adalah `undefined`.
export const robloxActions = {
  // ── Antrean ───────────────────────────────────────────────────────────────

  /**
   * Terima berkas dari drop maupun dari dialog `<input type=file>`.
   *
   * Mengembalikan berkas yang DITOLAK, bukan `void`: user yang menjatuhkan satu
   * folder campur perlu tahu apa yang tidak masuk. Halaman memakai nilai ini
   * untuk satu baris peringatan, bukan untuk membuat baris antrean palsu.
   */
  addFiles(incoming: readonly File[]): readonly string[] {
    const rejected: string[] = [];
    const fresh: QueueItem[] = [];

    for (const file of incoming) {
      if (!isAudioFile(file.name, file.type)) {
        rejected.push(file.name);
        continue;
      }
      const item = newQueueItem(file.name, file.size);
      files.set(item.id, file);
      fresh.push(item);
    }

    const first = fresh[0];
    if (first !== undefined) {
      set((s) => ({
        items: [...s.items, ...fresh],
        // Baris pertama yang masuk langsung terpilih supaya panel detail tidak
        // kosong setelah drop pertama.
        selected: s.selected ?? first.id,
      }));
      for (const it of fresh) {
        const file = files.get(it.id);
        if (file !== undefined) ingestInBackground(it.id, file);
      }
    }
    return rejected;
  },

  remove(id: number): void {
    files.delete(id);
    let removed: QueueItem | undefined;
    set((s) => {
      removed = s.items.find((it) => it.id === id);
      const items = s.items.filter((it) => it.id !== id);
      if (items.length === s.items.length) return null;
      return { items, selected: s.selected === id ? (items[0]?.id ?? null) : s.selected };
    });
    if (removed !== undefined) {
      const localId = removed.localId;
      void persistCritical(() => adapter().remove([localId]));
    }
  },

  /** Bersihkan baris yang sudah selesai. Baris gagal SENGAJA ditinggal. */
  clearDone(): void {
    set((s) => {
      const items = s.items.filter((it) => it.status !== 'done');
      if (items.length === s.items.length) return null;
      for (const it of s.items) if (it.status === 'done') files.delete(it.id);
      return { items, selected: items.some((it) => it.id === s.selected) ? s.selected : null };
    });
    // Tidak ada `remove` ke adapter: baris `done` justru harus tetap ada di
    // tabel — ia isi katalog. Yang dibersihkan hanya tampilan antrean.
  },

  clearAll(): void {
    files.clear();
    const localIds = state.items.map((it) => it.localId);
    set((s) => (s.items.length === 0 ? null : { items: [], selected: null }));
    if (localIds.length > 0) void persistCritical(() => adapter().remove(localIds));
    void enqueuePersist(() => adapter().clear());
  },

  select(id: number | null): void {
    set((s) => (s.selected === id ? null : { selected: id }));
  },

  // ── Sunting metadata ──────────────────────────────────────────────────────

  /**
   * Nama TIDAK dipangkas di sini meski `MAX_NAME_LEN` ada.
   *
   * Memangkas diam-diam saat mengetik adalah cara tercepat membuat user
   * kehilangan huruf tanpa tahu kenapa. Kelebihannya ditandai sebagai
   * pelanggaran oleh `violationsOf`, terlihat, dan bisa diperbaiki sendiri.
   */
  setName(id: number, name: string): void {
    set((s) => patchItem(s, id, (it) => (it.name === name ? it : { ...it, name })));
  },

  setDescription(id: number, description: string): void {
    set((s) =>
      patchItem(s, id, (it) => (it.description === description ? it : { ...it, description })),
    );
  },

  /** Hasil probe `<audio>`. Dipanggil sekali per baris oleh halaman. */
  setDuration(id: number, seconds: number | null): void {
    set((s) => patchItem(s, id, (it) => (it.seconds === seconds ? it : { ...it, seconds })));
  },

  /**
   * Kategori untuk SATU atau BANYAK baris — pilihan massal (docs/21 §1d)
   * memakai aksi yang sama dengan kolom per baris. Mengganti kategori
   * mengosongkan genre yang tidak lagi berada di bawahnya: genre `Lo-fi` di
   * bawah kategori `Efek suara` adalah data yang tidak pernah benar.
   */
  setCategory(ids: readonly number[], categoryId: string | null): void {
    set((s) =>
      patchItems(s, ids, (it) => {
        if (it.categoryId === categoryId) return it;
        const genre = s.taxonomy.genres.find((g) => g.id === it.genreId);
        const keepGenre = genre !== undefined && genre.categoryId === categoryId;
        return { ...it, categoryId, genreId: keepGenre ? it.genreId : null };
      }),
    );
  },

  /** Genre untuk satu/banyak baris; kategorinya mengikuti genre supaya tidak pernah saling bertentangan. */
  setGenre(ids: readonly number[], genreId: string | null): void {
    set((s) => {
      const genre = genreId === null ? null : (s.taxonomy.genres.find((g) => g.id === genreId) ?? null);
      if (genreId !== null && genre === null) return null;
      return patchItems(s, ids, (it) => {
        const categoryId = genre === null ? it.categoryId : genre.categoryId;
        if (it.genreId === genreId && it.categoryId === categoryId) return it;
        return { ...it, genreId, categoryId };
      });
    });
  },

  // ── Target ────────────────────────────────────────────────────────────────

  setCreatorKind(creatorKind: CreatorKind): void {
    set((s) =>
      s.target.creatorKind === creatorKind ? null : { target: { ...s.target, creatorKind } },
    );
  },

  setCreatorId(creatorId: string): void {
    set((s) => (s.target.creatorId === creatorId ? null : { target: { ...s.target, creatorId } }));
  },

  setApiKey(apiKey: string): void {
    set((s) => (s.target.apiKey === apiKey ? null : { target: { ...s.target, apiKey } }));
  },

  setGenreToDescription(genreToDescription: boolean): void {
    set((s) =>
      s.target.genreToDescription === genreToDescription
        ? null
        : { target: { ...s.target, genreToDescription } },
    );
  },

  /** Desktop: kunci ada/tidak di keychain. Bukan kuncinya — hanya kenyataannya. */
  setApiKeyStored(apiKeyStored: boolean): void {
    set((s) => (s.apiKeyStored === apiKeyStored ? null : { apiKeyStored }));
  },

  // ── Taksonomi (docs/21 §1d) ───────────────────────────────────────────────

  setTaxonomy(taxonomy: RobloxTaxonomy): void {
    set((s) => (s.taxonomy === taxonomy ? null : { taxonomy }));
  },

  async addCategory(name: string): Promise<TaxonomyResult> {
    try {
      const sort = Math.max(-1, ...state.taxonomy.categories.map((c) => c.sort)) + 1;
      const category = await adapter().upsertCategory({ name, sort });
      set((s) => ({ taxonomy: { ...s.taxonomy, categories: [...s.taxonomy.categories, category] } }));
      return { ok: true, id: category.id };
    } catch (e: unknown) {
      return failure(e);
    }
  },

  async renameCategory(id: string, name: string): Promise<TaxonomyResult> {
    const current = state.taxonomy.categories.find((c) => c.id === id);
    if (current === undefined) return { ok: false, message: 'kategori sudah tidak ada' };
    try {
      const category = await adapter().upsertCategory({ id, name, sort: current.sort });
      set((s) => ({
        taxonomy: { ...s.taxonomy, categories: s.taxonomy.categories.map((c) => (c.id === id ? category : c)) },
      }));
      return { ok: true, id };
    } catch (e: unknown) {
      return failure(e);
    }
  },

  /** Ditolak (`IN_USE`, pesannya menyebut jumlah) selama masih ada genre atau lagu di bawahnya. */
  async deleteCategory(id: string): Promise<TaxonomyResult> {
    try {
      await adapter().deleteCategory(id, usageOfCategory(state, id));
      set((s) => ({
        taxonomy: {
          categories: s.taxonomy.categories.filter((c) => c.id !== id),
          genres: s.taxonomy.genres.filter((g) => g.categoryId !== id),
        },
      }));
      return { ok: true, id };
    } catch (e: unknown) {
      return failure(e);
    }
  },

  async addGenre(categoryId: string, name: string): Promise<TaxonomyResult> {
    if (!state.taxonomy.categories.some((c) => c.id === categoryId)) {
      return { ok: false, message: 'pilih kategori dulu' };
    }
    try {
      const sort = Math.max(-1, ...state.taxonomy.genres.filter((g) => g.categoryId === categoryId).map((g) => g.sort)) + 1;
      const genre = await adapter().upsertGenre({ categoryId, name, sort });
      set((s) => ({ taxonomy: { ...s.taxonomy, genres: [...s.taxonomy.genres, genre] } }));
      return { ok: true, id: genre.id };
    } catch (e: unknown) {
      return failure(e);
    }
  },

  async renameGenre(id: string, name: string): Promise<TaxonomyResult> {
    return robloxActions.upsertGenre(id, { name });
  },

  /** Pindah ke kategori lain. Baris yang memakainya ikut pindah kategorinya — mereka tetap konsisten. */
  async moveGenre(id: string, categoryId: string): Promise<TaxonomyResult> {
    const result = await robloxActions.upsertGenre(id, { categoryId });
    if (result.ok) {
      set((s) => {
        const ids = s.items.filter((it) => it.genreId === id && it.categoryId !== categoryId).map((it) => it.id);
        return patchItems(s, ids, (it) => ({ ...it, categoryId }));
      });
    }
    return result;
  },

  async upsertGenre(id: string, patch: Partial<Pick<RobloxGenre, 'name' | 'categoryId'>>): Promise<TaxonomyResult> {
    const current = state.taxonomy.genres.find((g) => g.id === id);
    if (current === undefined) return { ok: false, message: 'genre sudah tidak ada' };
    try {
      const genre = await adapter().upsertGenre({
        id,
        categoryId: patch.categoryId ?? current.categoryId,
        name: patch.name ?? current.name,
        sort: current.sort,
      });
      set((s) => ({
        taxonomy: { ...s.taxonomy, genres: s.taxonomy.genres.map((g) => (g.id === id ? genre : g)) },
      }));
      return { ok: true, id };
    } catch (e: unknown) {
      return failure(e);
    }
  },

  async deleteGenre(id: string): Promise<TaxonomyResult> {
    try {
      await adapter().deleteGenre(id, usageOfGenre(state, id));
      set((s) => ({ taxonomy: { ...s.taxonomy, genres: s.taxonomy.genres.filter((g) => g.id !== id) } }));
      return { ok: true, id };
    } catch (e: unknown) {
      return failure(e);
    }
  },

  // ── Katalog (docs/21 §3a) ─────────────────────────────────────────────────

  setCatalog(catalog: readonly RobloxUploadRow[]): void {
    set((s) => (s.catalog === catalog ? null : { catalog }));
  },

  setCatalogFilter(patch: Partial<CatalogFilter>): void {
    set((s) => {
      const next = { ...s.catalogFilter, ...patch };
      // Genre yang tidak berada di bawah kategori terpilih tidak pernah
      // menghasilkan apa-apa — daripada daftar kosong yang membingungkan,
      // genre-nya dilepas.
      if (next.categoryId !== null && next.genreId !== null) {
        const genre = s.taxonomy.genres.find((g) => g.id === next.genreId);
        if (genre === undefined || genre.categoryId !== next.categoryId) next.genreId = null;
      }
      return next.categoryId === s.catalogFilter.categoryId &&
        next.genreId === s.catalogFilter.genreId &&
        next.query === s.catalogFilter.query
        ? null
        : { catalogFilter: next };
    });
  },

  /** Muat ulang katalog dari adapter (desktop: tabel; web: gabungan dokumen). */
  async refreshCatalog(): Promise<void> {
    try {
      const catalog = await adapter().catalog(persistedValue(state));
      set(() => ({ catalog }));
    } catch {
      // Katalog yang gagal dimuat bukan alasan menahan unggahan; tab KATALOG
      // menampilkan isi terakhir yang diketahui.
    }
  },

  /**
   * "Coba lagi" dari katalog: baris draft BARU dari hash yang sama. Kalau
   * barisnya masih ada di antrean (web: `failed` yang belum dibersihkan),
   * cukup ULANGI baris itu. Mengembalikan kalimat kalau byte-nya tidak bisa
   * didapat — web tanpa berkas di IndexedDB tidak punya apa-apa untuk dikirim.
   */
  async retryFromCatalog(row: RobloxUploadRow): Promise<string | null> {
    const existing = state.items.find((it) => it.localId === row.id);
    if (existing !== undefined) {
      if (existing.status === 'failed') robloxActions.retry(existing.id);
      robloxActions.select(existing.id);
      return null;
    }
    const blobOf = adapter().blobOf;
    const file = row.hash === '' || blobOf === undefined ? null : await blobOf(row.hash, row.fileName).catch(() => null);
    if (file === null) {
      return 'berkasnya sudah tidak ada di halaman ini — jatuhkan lagi berkas yang sama untuk mencoba ulang';
    }
    const item = newQueueItem(row.fileName, row.bytes, {
      hash: row.hash,
      seconds: row.seconds,
      name: row.name,
      description: row.description,
      categoryId: row.categoryId,
      genreId: row.genreId,
    });
    files.set(item.id, file);
    set((s) => ({ items: [...s.items, item], selected: item.id }));
    return null;
  },

  // ── Seam untuk lapisan unggah ─────────────────────────────────────────────

  /** Lapisan unggah melapor bahwa ia hidup. Selama `false`, UI mengatakannya. */
  setBackendReady(ready: boolean, quotaLeft: number | null = null): void {
    set((s) =>
      s.backendReady === ready && s.quotaLeft === quotaLeft
        ? null
        : { backendReady: ready, quotaLeft },
    );
  },

  markQueued(ids: readonly number[]): void {
    const wanted = new Set(ids);
    set((s) => ({
      items: s.items.map((it) =>
        wanted.has(it.id) ? withStatus(it, 'queued', { progress: 0, error: null }) : it,
      ),
    }));
  },

  markUploading(id: number): void {
    set((s) => patchItem(s, id, (it) => withStatus(it, 'uploading', { progress: 0, error: null })));
  },

  markProgress(id: number, progress: number): void {
    const pct = Math.max(0, Math.min(100, progress));
    set((s) => patchItem(s, id, (it) => (it.progress === pct ? it : { ...it, progress: pct })));
  },

  /** Byte-nya sudah sampai; Roblox masih memoderasinya. */
  async markProcessing(
    id: number,
    operationId: string | null = null,
    assetId: string | null = null,
  ): Promise<void> {
    const update = (s: RobloxState): Partial<RobloxState> | null =>
      patchItem(s, id, (it) =>
        withStatus(it, 'processing', {
          progress: 100,
          operationId,
          // Jangan membuang ID yang sudah diberikan Roblox hanya karena
          // moderasinya belum approved.
          assetId: assetId ?? it.assetId,
        }),
      );
    // Persist bentuk akhirnya SEBELUM status terlihat di UI.
    await persistCritical(async () => {
      const patch = update(state);
      if (patch !== null) await adapter().save(persistedValue({ ...state, ...patch }));
    });
    set(update);
  },

  async markDone(id: number, assetId: string): Promise<void> {
    const update = (s: RobloxState): Partial<RobloxState> | null =>
      patchItem(s, id, (it) =>
        withStatus(it, 'done', { progress: 100, assetId, operationId: null }),
      );
    // UI boleh berkata sukses hanya setelah assetId durable. Ini menutup celah
    // refresh tepat sesudah response approved tetapi sebelum transaksi IDB.
    await persistCritical(async () => {
      const patch = update(state);
      if (patch !== null) await adapter().save(persistedValue({ ...state, ...patch }));
    });
    set(update);
    // Baris `done` adalah isi katalog; muat ulang supaya tab KATALOG tidak
    // menunggu kunjungan berikutnya.
    await robloxActions.refreshCatalog();
  },

  /** Baris gagal kembali bisa dikirim ulang — `readyItems` ikut menerimanya. */
  markFailed(id: number, error: string): void {
    set((s) => patchItem(s, id, (it) => withStatus(it, 'failed', { error, operationId: null })));
    void robloxActions.refreshCatalog();
  },

  /** Kembalikan baris gagal ke draft supaya bisa disunting lalu dikirim lagi. */
  retry(id: number): void {
    set((s) =>
      patchItem(s, id, (it) =>
        it.status === 'failed' ? withStatus(it, 'draft', { error: null, progress: 0 }) : it,
      ),
    );
  },

  __resetForTest(): void {
    files.clear();
    nextId = 1;
    persistence = null;
    pendingPersist = null;
    criticalPersists.length = 0;
    state = createInitialRoblox();
    for (const fn of [...listeners]) fn();
  },

  /**
   * Suntikan storage untuk tes: yang tidak diberikan diambil dari adapter web,
   * jadi tes refresh-race lama cukup memberi `save`/`clear`.
   */
  __setPersistenceForTest(adapterPatch: Partial<PersistenceAdapter>): void {
    persistence = { ...createWebPersistence(), ...adapterPatch };
  },
};

