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
 * Library Worker dapat menyimpannya terenkripsi di D1 per akun Google. Store
 * browser tetap hanya memegang salinan aktif selama halaman digunakan.
 *
 * ## Seam untuk lapisan unggah
 *
 * `markQueued`/`markUploading`/`markProgress`/`markProcessing`/`markDone`/
 * `markFailed` sudah lengkap dan tidak dipakai UI ini untuk apa pun selain
 * merender. Itu seluruh permukaan yang dibutuhkan pengunggah: ia membaca
 * `readyItems(state)`, mengambil byte lewat `fileOf`, lalu melapor balik.
 */

import { useSyncExternalStore } from 'react';

import {
  baseNameOf,
  createInitialRoblox,
  isAudioFile,
  type CreatorKind,
  type QueueItem,
  type RobloxState,
  type UploadStatus,
} from './model';
import { clearRobloxQueue, loadRobloxQueue, saveRobloxQueue } from './persistence';

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
  // Status koneksi, kuota, dan API key tidak termasuk dokumen antrean. Selain
  // menjaga kredensial agar tidak tersimpan, ini mencegah probe `/health`
  // menimpa snapshot IndexedDB dengan state kosong saat hydration masih jalan.
  if (
    state.items !== before.items ||
    state.selected !== before.selected ||
    state.target.creatorKind !== before.target.creatorKind ||
    state.target.creatorId !== before.target.creatorId
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

let persistChain = Promise.resolve();
function persist(): void {
  const snapshot = state;
  const value = {
    items: snapshot.items,
    selected: snapshot.selected,
    target: {
      creatorKind: snapshot.target.creatorKind,
      creatorId: snapshot.target.creatorId,
    },
    files: snapshot.items.flatMap((it) => {
      const file = files.get(it.id);
      return file === undefined ? [] : [{ id: it.id, file }];
    }),
  };
  persistChain = persistChain.then(() => saveRobloxQueue(value)).catch(() => {});
}

/** Pulihkan antrean sebelum route mulai melanjutkan polling moderasi. */
export async function restoreRobloxQueue(): Promise<void> {
  const saved = await loadRobloxQueue().catch(() => null);
  if (saved === null) return;
  files.clear();
  for (const entry of saved.files) files.set(entry.id, entry.file);
  const items = saved.items.map((it) => {
    // Request yang putus sebelum operationId diterima tidak aman diteruskan
    // otomatis. Biarkan user melihat penjelasannya dan memutuskan sendiri.
    if (it.status === 'queued' || it.status === 'uploading') {
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

/** Ubah status baris, kecuali kalau ia sudah persis begitu. */
function withStatus(it: QueueItem, status: UploadStatus, extra: Partial<QueueItem> = {}): QueueItem {
  return { ...it, status, ...extra };
}

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
      const id = nextId++;
      files.set(id, file);
      fresh.push({
        id,
        fileName: file.name,
        bytes: file.size,
        seconds: null,
        name: baseNameOf(file.name),
        description: '',
        status: 'draft',
        progress: 0,
        error: null,
        assetId: null,
        operationId: null,
      });
    }

    const first = fresh[0];
    if (first !== undefined) {
      set((s) => ({
        items: [...s.items, ...fresh],
        // Baris pertama yang masuk langsung terpilih supaya panel detail tidak
        // kosong setelah drop pertama.
        selected: s.selected ?? first.id,
      }));
    }
    return rejected;
  },

  remove(id: number): void {
    files.delete(id);
    set((s) => {
      const items = s.items.filter((it) => it.id !== id);
      if (items.length === s.items.length) return null;
      return { items, selected: s.selected === id ? (items[0]?.id ?? null) : s.selected };
    });
  },

  /** Bersihkan baris yang sudah selesai. Baris gagal SENGAJA ditinggal. */
  clearDone(): void {
    set((s) => {
      const items = s.items.filter((it) => it.status !== 'done');
      if (items.length === s.items.length) return null;
      for (const it of s.items) if (it.status === 'done') files.delete(it.id);
      return { items, selected: items.some((it) => it.id === s.selected) ? s.selected : null };
    });
  },

  clearAll(): void {
    files.clear();
    set((s) => (s.items.length === 0 ? null : { items: [], selected: null }));
    persistChain = persistChain.then(() => clearRobloxQueue()).catch(() => {});
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

  // ── Seam untuk lapisan unggah (belum ada pemanggilnya di UI ini) ──────────

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
  markProcessing(id: number, operationId: string | null = null): void {
    set((s) => patchItem(s, id, (it) => withStatus(it, 'processing', { progress: 100, operationId })));
  },

  markDone(id: number, assetId: string): void {
    set((s) => patchItem(s, id, (it) => withStatus(it, 'done', { progress: 100, assetId, operationId: null })));
  },

  /** Baris gagal kembali bisa dikirim ulang — `readyItems` ikut menerimanya. */
  markFailed(id: number, error: string): void {
    set((s) => patchItem(s, id, (it) => withStatus(it, 'failed', { error, operationId: null })));
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
    state = createInitialRoblox();
    for (const fn of [...listeners]) fn();
  },
};
