/**
 * Sesi vocal split yang hidup selama app — SATU `SplitClient` (worker + sesi
 * ORT) dan keadaan yang dibaca dialog SPLIT serta tombolnya (docs/26 §3b).
 *
 * Kenapa modul terpisah dari `split-job.ts`: memuat model itu mahal (66 MB
 * dibaca + sesi ORT dibangun), jadi klien TIDAK dibuat per job. Ia dibuat
 * sekali, dipakai job demi job, dan dibuang hanya kalau model/EP/thread yang
 * diminta berbeda dari yang sedang dimuat. Dialog perlu tahu "siap / sedang
 * mengunduh / belum" tanpa menjalankan job, dan tombol perlu tahu "ada job
 * jalan" tanpa membaca store studio — keduanya dilayani snapshot di sini.
 *
 * Store-nya kecil dan tanpa pustaka (pola `useSyncExternalStore` seperti
 * `studio/store.ts`): satu snapshot immutable, satu daftar pendengar.
 */

import { useSyncExternalStore } from 'react';

import type { VocalModelId } from './catalog';
import type { VocalExecutionProvider, VocalModelDownloadProgress, VocalModelInfo } from './mdx-model';
import { createSplitClient, type SplitClient } from './split-client';

/**
 * Keadaan model di sesi ini.
 *
 * `idle` TIDAK bisa membedakan "belum pernah diunduh" dari "sudah ada di cache
 * tapi belum dimuat": cache hanya diperiksa saat `init`. Dialog menampilkan
 * `idle` sebagai "belum diunduh (66,8 MB)" — kalau ternyata sudah ada di
 * cache, unduhan-nya selesai seketika dan labelnya langsung berganti "siap".
 */
export type VocalModelStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly ratio: number | null; readonly cacheHit: boolean }
  | { readonly kind: 'ready'; readonly info: VocalModelInfo }
  | { readonly kind: 'error'; readonly message: string };

/** Job yang sedang berjalan; satu pada satu waktu (docs/26 §3c). */
export interface VocalSplitJob {
  readonly id: string;
  readonly clipId: string;
  readonly laneId: string;
}

export interface VocalSplitSnapshot {
  readonly model: VocalModelStatus;
  /** Model yang sedang/terakhir dimuat sesi; null sebelum `init` pertama. */
  readonly modelId: VocalModelId | null;
  readonly job: VocalSplitJob | null;
}

export interface VocalModelLoadOptions {
  readonly maxThreads?: number;
  /** Default `'wasm'` (docs/26 §4). */
  readonly executionProvider?: VocalExecutionProvider;
}

interface Session {
  readonly client: SplitClient;
  readonly modelId: VocalModelId;
  readonly executionProvider: VocalExecutionProvider;
  readonly maxThreads: number | undefined;
  /** `init` yang sedang berjalan atau sudah selesai. */
  readonly ready: Promise<VocalModelInfo>;
  info: VocalModelInfo | null;
}

const IDLE: VocalSplitSnapshot = { model: { kind: 'idle' }, modelId: null, job: null };

let snapshot: VocalSplitSnapshot = IDLE;
let session: Session | null = null;
const listeners = new Set<() => void>();

function set(patch: Partial<VocalSplitSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const l of listeners) l();
}

export function subscribeVocalSplit(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function vocalSplitSnapshot(): VocalSplitSnapshot {
  return snapshot;
}

export function useVocalSplit(): VocalSplitSnapshot;
export function useVocalSplit<T>(selector: (s: VocalSplitSnapshot) => T): T;
export function useVocalSplit<T>(selector?: (s: VocalSplitSnapshot) => T): T | VocalSplitSnapshot {
  return useSyncExternalStore(
    subscribeVocalSplit,
    () => (selector === undefined ? snapshot : selector(snapshot)),
    () => (selector === undefined ? snapshot : selector(snapshot)),
  );
}

/** Jumlah thread bawaan dialog: `min(4, cores − 2)`, minimal 1 — sama dengan `loadScnetModel`. */
export function defaultVocalSplitThreads(): number {
  const cores = typeof navigator === 'undefined' ? 2 : navigator.hardwareConcurrency || 2;
  return Math.max(1, Math.min(4, cores - 2));
}

/**
 * Pastikan model dimuat di sesi ini; mengembalikan info sesi yang siap.
 *
 * Dipanggil dua tempat: tombol UNDUH di dialog (tanpa job) dan awal
 * `runVocalSplit`. Keduanya berbagi satu `init`: menekan UNDUH lalu PISAHKAN
 * sebelum unduhan selesai TIDAK memulai unduhan kedua — job menunggu yang
 * sedang berjalan.
 *
 * Sesi diganti (klien lama `dispose`, worker-nya mati) kalau model, EP, atau
 * batas thread berbeda dari yang dimuat. Byte model sudah ada di cache
 * (`appDataDir()/models` di desktop, OPFS di web), jadi ganti thread hanya
 * membayar pembangunan ulang sesi ORT, bukan unduhan.
 */
export function ensureVocalModel(
  modelId: VocalModelId,
  options: VocalModelLoadOptions = {},
  onProgress?: (progress: VocalModelDownloadProgress) => void,
): Promise<VocalModelInfo> {
  const executionProvider = options.executionProvider ?? 'wasm';
  const current = session;
  if (current !== null) {
    const same = current.modelId === modelId && current.executionProvider === executionProvider;
    // Batas thread hanya dibandingkan kalau pemanggil menyebutkannya; `init`
    // yang masih berjalan tidak diganggu — perubahan thread berlaku setelahnya.
    const threadsOk = options.maxThreads === undefined || current.info === null || current.maxThreads === options.maxThreads;
    if (same && threadsOk) {
      if (current.info === null) {
        // `init` masih berjalan: progresnya sudah masuk snapshot, pemanggil
        // kedua cukup ikut menunggu.
        return current.ready;
      }
      return Promise.resolve(current.info);
    }
    disposeVocalSplitSession();
  }

  const client = createSplitClient();
  const report = (p: VocalModelDownloadProgress): void => {
    if (session?.client !== client) return;
    set({ model: { kind: 'loading', ratio: p.total > 0 ? Math.min(1, p.loaded / p.total) : null, cacheHit: p.cacheHit } });
    onProgress?.(p);
  };
  const ready = client.init(modelId, report, { maxThreads: options.maxThreads, executionProvider });
  const next: Session = { client, modelId, executionProvider, maxThreads: options.maxThreads, ready, info: null };
  session = next;
  set({ model: { kind: 'loading', ratio: null, cacheHit: false }, modelId });

  ready.then(
    (info) => {
      if (session !== next) return;
      next.info = info;
      set({ model: { kind: 'ready', info } });
    },
    (reason: unknown) => {
      if (session !== next) return;
      // Sesi yang gagal `init` tidak berguna; buang supaya UNDUH berikutnya
      // mulai dari klien baru, bukan dari klien yang menolak `init` kedua.
      session = null;
      client.dispose();
      set({ model: { kind: 'error', message: reason instanceof Error ? reason.message : String(reason) } });
    },
  );
  return ready;
}

/** Klien yang SIAP untuk model ini, atau null. `runVocalSplit` memakai ini setelah `ensureVocalModel`. */
export function readyVocalSplitClient(modelId: VocalModelId): SplitClient | null {
  if (session === null || session.info === null || session.modelId !== modelId) return null;
  return session.client;
}

/** Model sudah dimuat di sesi ini (ada sesi ORT yang siap dipakai). */
export function isVocalModelReady(modelId: VocalModelId): boolean {
  return readyVocalSplitClient(modelId) !== null;
}

/** Matikan worker dan lupakan modelnya. Job yang menunggu ditolak oleh klien. */
export function disposeVocalSplitSession(): void {
  const current = session;
  session = null;
  current?.client.dispose();
  set({ model: { kind: 'idle' }, modelId: null });
}

/** Dipakai `split-job.ts`: umumkan job yang mulai/selesai supaya tombol dan dialog ikut berubah. */
export function markVocalSplitJob(job: VocalSplitJob | null): void {
  if (snapshot.job === job) return;
  set({ job });
}

/** Sesi dan snapshot kembali kosong. Hanya untuk tes. */
export function __resetVocalSplitSessionForTest(): void {
  const current = session;
  session = null;
  current?.client.dispose();
  snapshot = IDLE;
  for (const l of listeners) l();
}
