/**
 * Store kepustakaan — `useSyncExternalStore`, pola yang sama dengan
 * `studio/store.ts`, `dj/store.ts`, dan `roblox/store.ts`.
 *
 * Yang TIDAK ada di sini, dan itu disengaja: **byte lagu dan PCM-nya.** Begitu
 * satu lagu diunduh, ia diserahkan ke `decodeStoredAsset` dan hidup di
 * `studioStore.assets` seperti lagu yang diimpor dari berkas lokal. Satu
 * registry, satu jalur decode — kepustakaan hanya menyimpan DAFTARNYA dan peta
 * `hash → assetId`.
 *
 * Kalau daftar ini punya salinan audionya sendiri, akan ada dua tempat yang
 * bisa berbeda tentang lagu yang sama, dan yang satu pasti basi.
 */

import { useSyncExternalStore } from 'react';

import {
  createInitialLibrary,
  type LibraryState,
  type LibraryStatus,
  type LibraryTrack,
  type LibraryUser,
  type OpenProject,
  type ProjectRow,
  type UploadState,
} from './model';

let state: LibraryState = createInitialLibrary();

type Listener = () => void;
const listeners = new Set<Listener>();

function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function set(patch: (s: LibraryState) => Partial<LibraryState> | null): void {
  const next = patch(state);
  if (next === null) return;
  state = { ...state, ...next };
  for (const fn of [...listeners]) fn();
}

export const libraryStore = { getState: () => state, subscribe };

export function useLibrary(): LibraryState;
export function useLibrary<T>(selector: (s: LibraryState) => T): T;
export function useLibrary<T>(selector?: (s: LibraryState) => T): T | LibraryState {
  return useSyncExternalStore(
    subscribe,
    () => (selector === undefined ? state : selector(state)),
    () => (selector === undefined ? state : selector(state)),
  );
}

export const libraryActions = {
  toggleCollapsed(): void {
    set((s) => ({ collapsed: !s.collapsed }));
  },

  setCollapsed(collapsed: boolean): void {
    set((s) => (s.collapsed === collapsed ? null : { collapsed }));
  },

  setStatus(status: LibraryStatus, user: LibraryUser | null = null): void {
    set((s) =>
      s.status === status && s.user === user ? null : { status, user, error: null },
    );
  },

  fail(message: string): void {
    set(() => ({ status: 'gagal', error: message, listing: false }));
  },

  setListing(listing: boolean): void {
    set((s) => (s.listing === listing ? null : { listing }));
  },

  setTracks(tracks: readonly LibraryTrack[]): void {
    set(() => ({ tracks, listing: false, error: null }));
  },

  /**
   * Lagu ini sedang diunduh, `percent` sekian.
   *
   * Kemajuannya disimpan per-hash alih-alih satu angka global: dua lagu bisa
   * diminta hampir bersamaan, dan satu bar yang melompat-lompat di antara
   * keduanya lebih membingungkan daripada tidak ada bar sama sekali.
   */
  setProgress(hash: string, percent: number): void {
    set((s) => {
      const clamped = Math.max(0, Math.min(100, Math.round(percent)));
      if (s.loading[hash] === clamped) return null;
      return { loading: { ...s.loading, [hash]: clamped } };
    });
  },

  /** Lagunya sudah jadi asset sesi ini. */
  markLoaded(hash: string, assetId: number): void {
    set((s) => {
      const loading = { ...s.loading };
      delete loading[hash];
      return { loaded: { ...s.loaded, [hash]: assetId }, loading };
    });
  },

  clearProgress(hash: string): void {
    set((s) => {
      if (!(hash in s.loading)) return null;
      const loading = { ...s.loading };
      delete loading[hash];
      return { loading };
    });
  },

  // ── Project ───────────────────────────────────────────────────────────────

  setTab(tab: LibraryState['tab']): void {
    set((s) => (s.tab === tab ? null : { tab }));
  },

  setProjects(projects: readonly ProjectRow[]): void {
    set(() => ({ projects }));
  },

  /**
   * Project yang sedang dipegang tab ini, berikut versinya.
   *
   * Versinya WAJIB ikut: ia yang dikirim sebagai `If-Match` saat menyimpan, dan
   * tanpanya simpan berikutnya berarti "timpa apa pun yang ada di sana" — persis
   * yang docs/16 §8c ingin cegah.
   */
  setOpenProject(project: OpenProject | null): void {
    set(() => ({ openProject: project }));
  },

  /** Kabar sekali pakai untuk dipajang di dok. `null` menghapusnya. */
  setNotice(notice: string | null): void {
    set((s) => (s.notice === notice ? null : { notice }));
  },

  // ── Unggah ────────────────────────────────────────────────────────────────

  beginUpload(hash: string, name: string): void {
    set((s) => ({
      uploads: { ...s.uploads, [hash]: { name, phase: 'memeriksa', percent: 0, error: null } },
    }));
  },

  setUploadPhase(hash: string, phase: UploadState['phase']): void {
    set((s) => {
      const cur = s.uploads[hash];
      if (cur === undefined || cur.phase === phase) return null;
      return { uploads: { ...s.uploads, [hash]: { ...cur, phase } } };
    });
  },

  setUploadProgress(hash: string, percent: number): void {
    set((s) => {
      const cur = s.uploads[hash];
      const clamped = Math.max(0, Math.min(100, Math.round(percent)));
      if (cur === undefined || cur.percent === clamped) return null;
      return { uploads: { ...s.uploads, [hash]: { ...cur, percent: clamped } } };
    });
  },

  /**
   * Selesai — barisnya HILANG dari daftar unggahan.
   *
   * Yang berhasil tidak perlu diumumkan: lagunya akan muncul di daftar
   * kepustakaan, dan itu bukti yang lebih baik daripada baris "selesai" yang
   * menumpuk sampai halaman dimuat ulang.
   */
  endUpload(hash: string): void {
    set((s) => {
      if (!(hash in s.uploads)) return null;
      const uploads = { ...s.uploads };
      delete uploads[hash];
      return { uploads };
    });
  },

  /** Gagal — barisnya TETAP ADA, dengan sebabnya. */
  failUpload(hash: string, error: string): void {
    set((s) => {
      const cur = s.uploads[hash];
      const name = cur?.name ?? hash.slice(0, 8);
      return { uploads: { ...s.uploads, [hash]: { name, phase: 'gagal', percent: 0, error } } };
    });
  },

  /** Buang baris gagal dari layar. Tidak mencoba ulang apa pun. */
  dismissUpload(hash: string): void {
    set((s) => {
      if (!(hash in s.uploads)) return null;
      const uploads = { ...s.uploads };
      delete uploads[hash];
      return { uploads };
    });
  },

  /**
   * Lupakan sesi.
   *
   * `loaded` SENGAJA tidak ikut dibersihkan: lagu yang sudah mendarat di
   * `studioStore.assets` tetap ada di sana sesudah logout — ia sudah jadi
   * bagian dari sesi kerja, dan menariknya kembali berarti timeline user
   * kehilangan audio karena ia menekan tombol keluar.
   */
  signedOut(): void {
    set(() => ({ status: 'anonim', user: null, tracks: [], error: null, listing: false }));
  },

  __resetForTest(): void {
    state = createInitialLibrary();
    for (const fn of [...listeners]) fn();
  },
};
