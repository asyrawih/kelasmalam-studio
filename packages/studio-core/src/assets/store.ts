/**
 * Registry aset — `useSyncExternalStore` dengan langganan ber-selector, pola
 * yang sama dengan `studioStore` (lihat kepala `studio/store.ts` untuk aturan
 * selector yang stabil secara referensi).
 *
 * KENAPA STORE SENDIRI, BUKAN FIELD DI STORE PROJECT (docs/25 P4). Sampai P3
 * `assets` duduk di dalam `StudioAppState` bersama lane, clip, transport, dan
 * mixer. Halaman `/dj` — yang tidak punya lane — karenanya harus mengimpor
 * seluruh store lane hanya untuk membaca daftar lagu, dan Studio FL (docs/24)
 * akan mewarisi keharusan yang sama. Registry ini adalah bagian yang benar-
 * benar dibagi tiga halaman: lagu yang diimpor di mana pun tampil di mana pun,
 * satu jalur decode, satu grid per lagu.
 *
 * Yang SENGAJA tidak ada di sini:
 *   - riwayat undo dan penanda kotor. Keduanya milik PROJECT: perubahan aset
 *     (daftar lagu, koreksi grid) ikut tersimpan dan ikut bisa di-undo, tapi
 *     yang memutuskan "ini satu langkah undo" dan "ini mengotori project"
 *     adalah store project yang berlangganan ke sini (`studio/store.ts`).
 *     `restoreAssets` ada untuk jalur itu.
 *   - pemakaian aset oleh clip/lane (`assets/usage.ts`) — core tidak tahu apa
 *     yang memakai aset; ia hanya menyediakan tempat mendaftar.
 */

import { useSyncExternalStore } from 'react';

import { clampGridBpm, MAX_BEAT_ANCHORS, type BeatAnchor } from '../analysis/beat-grid';
import type { AssetMap, AssetTempo, StudioAsset } from './model';

export interface AssetState {
  /** assetId → asset. Clip tanpa entri di sini digambar sebagai placeholder. */
  readonly assets: AssetMap;
}

// ── Inti store ───────────────────────────────────────────────────────────────

let state: AssetState = { assets: {} };

type Listener = () => void;
const listeners = new Set<Listener>();

function notify(): void {
  for (const fn of [...listeners]) fn();
}

function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function getState(): AssetState {
  return state;
}

/** Ganti peta aset, lalu beri tahu pelanggan. `null` = tidak ada perubahan. */
function set(patch: (assets: AssetMap) => AssetMap | null): void {
  const next = patch(state.assets);
  if (next === null || next === state.assets) return;
  state = { assets: next };
  notify();
}

/** Ubah SATU aset. Aset yang tidak ada, atau `fn` yang mengembalikan aset yang
 *  sama, tidak menghasilkan perubahan — pelanggan tidak dibangunkan. */
function update(id: number, fn: (asset: StudioAsset) => StudioAsset | null): void {
  set((assets) => {
    const asset = assets[id];
    if (asset === undefined) return null;
    const next = fn(asset);
    if (next === null || next === asset) return null;
    return { ...assets, [id]: next };
  });
}

/**
 * Berlangganan satu irisan registry. Selector harus stabil secara referensi —
 * lihat catatan di `studio/store.ts`.
 */
export function useAssets(): AssetState;
export function useAssets<T>(selector: (s: AssetState) => T): T;
export function useAssets<T>(selector?: (s: AssetState) => T): T | AssetState {
  const read = (): T | AssetState => (selector === undefined ? state : selector(state));
  return useSyncExternalStore(subscribe, read, read);
}

/** Akses langsung untuk kode non-React (handler pointer, worker client, tes). */
export const assetStore = { getState, subscribe };

/**
 * BPM manual → nilai yang sah, atau null untuk "kembali ke deteksi".
 *
 * Dibatasi DI STORE, bukan hanya di field input: nilai bisa datang dari project
 * lama atau dari kode lain, dan BPM 0 membuat `samplesPerBeat` jadi Infinity —
 * satu grid rusak sudah cukup untuk membekukan penggambarnya.
 */
function clampGridBpmOrNull(bpm: number | null | undefined): number | null {
  if (bpm === null || bpm === undefined || !Number.isFinite(bpm)) return null;
  return clampGridBpm(bpm);
}

let idCounter = 0;

// ── Aksi publik ──────────────────────────────────────────────────────────────

export const assetActions = {
  registerAsset(asset: StudioAsset): void {
    set((assets) => ({ ...assets, [asset.id]: asset }));
  },
  /**
   * Buang asset dari registry.
   *
   * Sengaja TIDAK memeriksa apakah ada clip yang memakainya: penjaganya hidup
   * di pemanggil (`assetUsage`, `assets/usage.ts`), karena hanya pemanggil
   * yang tahu apa yang harus terjadi kalau ternyata dipakai — menolak, atau
   * menghapus clip-nya lebih dulu. Aksi store yang diam-diam menolak akan
   * terlihat seperti tidak melakukan apa-apa.
   */
  removeAsset(id: number): void {
    set((assets) => {
      if (assets[id] === undefined) return null;
      const next = { ...assets };
      delete next[id];
      return next;
    });
  },
  /**
   * Hasil dari worker tempo. `tempo === null` berarti sudah dianalisis dan
   * memang tidak ada jawabannya — `tempoPending` tetap dimatikan supaya UI
   * berhenti menampilkan "menganalisis".
   */
  setAssetTempo(id: number, tempo: AssetTempo | null): void {
    update(id, (asset) => ({ ...asset, tempo, tempoPending: false }));
  },
  /** Tandai bahwa analisis sedang berjalan (dipanggil saat worker di-post). */
  markAssetTempoPending(id: number): void {
    // Lagu terkunci dilewati analisis batch: hasilnya tidak akan dipakai
    // (`bpmOverride` menang) dan `tempoPending` hanya membuat UI menulis
    // "ANALISIS…" pada grid yang justru sudah final.
    update(id, (asset) =>
      asset.tempoPending || asset.analysisLock ? null : { ...asset, tempoPending: true },
    );
  },
  /** ×2 (`+1`) atau ÷2 (`-1`) pada BPM asset. Dibatasi ±2 oktaf. */
  shiftAssetTempoOctave(id: number, delta: number): void {
    update(id, (asset) => {
      const next = Math.max(-2, Math.min(2, asset.tempoOctave + delta));
      return next === asset.tempoOctave ? null : { ...asset, tempoOctave: next };
    });
  },
  /**
   * Koreksi grid manual. Field yang tidak disebut TIDAK diubah, sehingga
   * mengetik BPM tidak diam-diam membuang offset yang sudah disetel dengan
   * susah payah (dan sebaliknya).
   */
  setAssetBeatGrid(id: number, patch: { bpm?: number | null; offsetSec?: number | null }): void {
    update(id, (asset) => {
      if (asset.analysisLock) return null;
      const bpmOverride = 'bpm' in patch ? clampGridBpmOrNull(patch.bpm) : asset.bpmOverride;
      const nextOffset = patch.offsetSec ?? null;
      const beatOffsetOverride =
        'offsetSec' in patch
          ? nextOffset !== null && Number.isFinite(nextOffset)
            ? nextOffset
            : null
          : asset.beatOffsetOverride;
      if (bpmOverride === asset.bpmOverride && beatOffsetOverride === asset.beatOffsetOverride) {
        return null;
      }
      return { ...asset, bpmOverride, beatOffsetOverride };
    });
  },
  /**
   * Pasang (atau ganti) satu anchor tempo di `atSec` — `[Dynamic]` rekordbox.
   *
   * Anchor yang jatuh di detik yang sama dengan yang sudah ada DIGANTI, bukan
   * ditumpuk: dua anchor di satu titik berarti ruas selebar nol, dan yang
   * terlihat user adalah tombol yang tidak melakukan apa-apa pada tekanan
   * kedua. `EPS_SEC` sengaja sekasar 1 ms — itu langkah terkecil yang bisa
   * dihasilkan panel grid, jadi tidak ada anchor sah yang lebih rapat.
   */
  setAssetBeatAnchor(id: number, at: BeatAnchor): void {
    update(id, (asset) => {
      if (asset.analysisLock) return null;
      if (!Number.isFinite(at.atSec) || !Number.isFinite(at.bpm) || at.bpm <= 0) return null;
      const bpm = clampGridBpm(at.bpm);
      const EPS_SEC = 0.001;
      const kept = (asset.beatAnchors ?? []).filter((a) => Math.abs(a.atSec - at.atSec) > EPS_SEC);
      if (kept.length >= MAX_BEAT_ANCHORS) return null;
      const beatAnchors = [...kept, { atSec: at.atSec, bpm }].sort((a, b) => a.atSec - b.atSec);
      return { ...asset, beatAnchors };
    });
  },
  /**
   * Ganti SELURUH daftar anchor sekaligus.
   *
   * Ada demi undo/redo, yang harus bisa mengembalikan keadaan apa pun dalam
   * satu langkah — memulihkannya lewat `setAssetBeatAnchor` satu per satu
   * berarti keadaan setengah jadi yang sempat terlihat dan sempat terdengar.
   */
  setAssetBeatAnchors(id: number, anchors: readonly BeatAnchor[] | null): void {
    update(id, (asset) => {
      if (asset.analysisLock) return null;
      const next =
        anchors === null || anchors.length === 0
          ? null
          : anchors
              .filter((a) => Number.isFinite(a.atSec) && Number.isFinite(a.bpm) && a.bpm > 0)
              .slice(0, MAX_BEAT_ANCHORS)
              .map((a) => ({ atSec: a.atSec, bpm: clampGridBpm(a.bpm) }))
              .sort((a, b) => a.atSec - b.atSec);
      return { ...asset, beatAnchors: next };
    });
  },
  /** Buang anchor ruas TERDEKAT dari `atSec`, kalau ada yang cukup dekat. */
  removeAssetBeatAnchorNear(id: number, atSec: number, withinSec: number): void {
    update(id, (asset) => {
      if (asset.analysisLock) return null;
      const anchors = asset.beatAnchors ?? null;
      if (anchors === null || anchors.length === 0) return null;
      let bestI = -1;
      let bestD = Infinity;
      anchors.forEach((a, i) => {
        const d = Math.abs(a.atSec - atSec);
        if (d < bestD) {
          bestD = d;
          bestI = i;
        }
      });
      if (bestI < 0 || bestD > withinSec) return null;
      const rest = anchors.filter((_, i) => i !== bestI);
      return { ...asset, beatAnchors: rest.length === 0 ? null : rest };
    });
  },
  /**
   * Buang SEMUA koreksi manual dan kembali ke hasil deteksi — termasuk
   * `tempoOctave`.
   *
   * Oktafnya dulu TIDAK ikut, dan itu adalah cacat: ada dua jalan menuju
   * "BPM-nya separuh" (`tempoOctave` lewat tombol ×2/÷2, dan `bpmOverride`
   * lewat angka yang diketik), keduanya terlihat sama di layar, dan AUTO hanya
   * membersihkan salah satunya. Akibatnya user menekan AUTO, BPM-nya tetap
   * salah oktaf, dan tidak ada satu kontrol pun yang terlihat menjelaskan
   * kenapa. Tombol yang bernama AUTO harus mengembalikan SEMUA yang manual.
   */
  resetAssetBeatGrid(id: number): void {
    update(id, (asset) => {
      if (asset.analysisLock) return null;
      if (
        asset.bpmOverride === null &&
        asset.beatOffsetOverride === null &&
        (asset.beatAnchors ?? null) === null &&
        asset.tempoOctave === 0
      ) {
        return null;
      }
      return {
        ...asset,
        bpmOverride: null,
        beatOffsetOverride: null,
        beatAnchors: null,
        tempoOctave: 0,
      };
    });
  },
  /**
   * Kunci/buka `[Analysis Lock]`. Sengaja TIDAK ikut terkunci oleh dirinya
   * sendiri — kunci yang tidak bisa dibuka bukan kunci, melainkan kerusakan.
   */
  setAnalysisLock(id: number, locked: boolean): void {
    update(id, (asset) => (asset.analysisLock === locked ? null : { ...asset, analysisLock: locked }));
  },
  /**
   * Id asset baru. WAJIB muat di `u32`: engine memakainya sebagai index tabel
   * asset (`AssetId = u32`), dan id berbasis timestamp (~1.7e15) ditolak saat
   * snapshot dideserialisasi.
   *
   * Di-seed dari id terbesar yang sudah ada supaya tidak bentrok dengan project
   * yang dipulihkan; id lama yang terlalu besar diabaikan saat menghitung seed,
   * jadi rentangnya tidak pernah bertabrakan.
   */
  newAssetId(): number {
    const existing = Object.keys(state.assets)
      .map(Number)
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 0xffff_ffff);
    const floor = existing.length > 0 ? Math.max(...existing) : 0;
    idCounter = Math.max(idCounter + 1, floor + 1);
    return idCounter;
  },
  /**
   * Ganti SELURUH peta aset dalam satu langkah.
   *
   * Untuk undo/redo project (`studio/store.ts`) — bukan jalur biasa. Memulihkan
   * lewat `registerAsset`/`removeAsset` satu per satu berarti sederet
   * pemberitahuan yang masing-masing terlihat seperti edit baru oleh pelanggan
   * yang merekam riwayat.
   */
  restoreAssets(assets: AssetMap): void {
    set(() => assets);
  },
  /** Hanya untuk tes: registry kosong, penghitung id kembali ke awal. */
  __resetForTest(): void {
    idCounter = 0;
    state = { assets: {} };
    notify();
  },
};
