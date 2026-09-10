/**
 * Sesi vocal split yang hidup selama app — SATU runtime (worker WASM + sesi
 * ORT, atau host native) dan keadaan yang dibaca dialog SPLIT serta tombolnya
 * (docs/26 §3b).
 *
 * Kenapa modul terpisah dari `split-job.ts`: memuat model itu mahal (66 MB
 * dibaca + sesi ORT dibangun), jadi klien TIDAK dibuat per job. Ia dibuat
 * sekali, dipakai job demi job, dan dibuang hanya kalau model/EP/thread yang
 * diminta berbeda dari yang sedang dimuat. Dialog perlu tahu "siap / sedang
 * mengunduh / belum" tanpa menjalankan job, dan tombol perlu tahu "ada job
 * jalan" tanpa membaca store studio — keduanya dilayani snapshot di sini.
 *
 * ## Dua runtime, dipilih oleh KONTRAK host (docs/26 P3b)
 *
 *   - host punya `vocalSplit` (desktop): model diunduh lewat
 *     `vocalSplit.ensureModel` — bytenya TIDAK pernah masuk JS — dan job
 *     dijalankan `vocalSplit.run` di Rust. Sesi di sini hanya mengingat "model
 *     sudah ada di disk" dan pilihan akselerasi (`accel`).
 *   - host tanpa `vocalSplit` (web): `SplitClient` (worker + ORT-web WASM)
 *     seperti semula; byte model lewat `modelBytes` atau fetch + OPFS.
 *
 * Keputusannya "host punya `vocalSplit`?", bukan "ini desktop?" (docs/25
 * §1b). Dialog dan job tidak tahu runtime mana yang jalan kecuali untuk badge
 * dan pilihan akselerasi.
 *
 * Store-nya kecil dan tanpa pustaka (pola `useSyncExternalStore` seperti
 * `studio/store.ts`): satu snapshot immutable, satu daftar pendengar.
 */

import { useSyncExternalStore } from 'react';

import { getPlatformHost, type VocalSplitAccel, type VocalSplitHost } from '@kelasmalam/platform';

import type { VocalModelId } from './catalog';
import type { VocalExecutionProvider, VocalModelDownloadProgress, VocalModelInfo } from './mdx-model';
import { createSplitClient, type SplitClient } from './split-client';

export type { VocalSplitAccel };

/** `native` = inferensi di host (Rust); `wasm` = worker ORT-web. */
export type VocalSplitRuntime = 'wasm' | 'native';

/**
 * Info sesi yang siap. Untuk `wasm` ada sesi ORT dengan nama tensornya; untuk
 * `native` yang siap hanyalah berkas model di disk host — sesi ORT-nya
 * dibangun Rust saat job pertama.
 */
export type VocalSessionInfo =
  | { readonly runtime: 'wasm'; readonly model: VocalModelInfo }
  | { readonly runtime: 'native'; readonly modelId: VocalModelId; readonly cacheHit: boolean; readonly loadMs: number };

/**
 * Keadaan model di sesi ini.
 *
 * `idle` TIDAK bisa membedakan "belum pernah diunduh" dari "sudah ada di cache
 * tapi belum dimuat": cache hanya diperiksa saat `init`/`ensureModel`. Dialog
 * menampilkan `idle` sebagai "belum diunduh (66,8 MB)" — kalau ternyata sudah
 * ada di cache, unduhan-nya selesai seketika dan labelnya langsung berganti
 * "siap".
 */
export type VocalModelStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly ratio: number | null; readonly cacheHit: boolean }
  | { readonly kind: 'ready'; readonly info: VocalSessionInfo }
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
  /** Runtime yang dipakai; `null` sebelum [`probeVocalSplitRuntime`] pertama. */
  readonly runtime: VocalSplitRuntime | null;
  /** Akselerasi yang ditawarkan host native; kosong untuk `wasm` atau sebelum probe. */
  readonly accels: readonly VocalSplitAccel[];
  /** Pilihan akselerasi job berikutnya. Default `coreml` kalau tersedia, selain itu `cpu`. */
  readonly accel: VocalSplitAccel;
}

export interface VocalModelLoadOptions {
  readonly maxThreads?: number;
  /** Default `'wasm'` (docs/26 §4). Hanya berarti untuk runtime worker. */
  readonly executionProvider?: VocalExecutionProvider;
}

interface WasmSession {
  readonly kind: 'wasm';
  readonly client: SplitClient;
  readonly modelId: VocalModelId;
  readonly executionProvider: VocalExecutionProvider;
  readonly maxThreads: number | undefined;
  /** `init` yang sedang berjalan atau sudah selesai. */
  readonly ready: Promise<VocalSessionInfo>;
  info: VocalSessionInfo | null;
}

interface NativeSession {
  readonly kind: 'native';
  readonly modelId: VocalModelId;
  /** `ensureModel` yang sedang berjalan atau sudah selesai. */
  readonly ready: Promise<VocalSessionInfo>;
  info: VocalSessionInfo | null;
}

type Session = WasmSession | NativeSession;

const IDLE: VocalSplitSnapshot = {
  model: { kind: 'idle' },
  modelId: null,
  job: null,
  runtime: null,
  accels: [],
  accel: 'cpu',
};

let snapshot: VocalSplitSnapshot = IDLE;
let session: Session | null = null;
let probe: Promise<VocalSplitRuntime> | null = null;
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
 * Host native kalau ada. SATU-SATUNYA tempat kontrak `vocalSplit` dibaca;
 * `split-job.ts` dan dialog bertanya ke sini, bukan ke host langsung.
 */
export function nativeVocalSplitHost(): VocalSplitHost | undefined {
  return getPlatformHost().vocalSplit;
}

/**
 * Tentukan runtime dan, untuk native, akselerasi yang tersedia. Dipanggil
 * dialog saat dibuka dan `runVocalSplit` sebelum job; hasilnya di-cache —
 * `accels()` adalah IPC, dan jawabannya tidak berubah selama app hidup.
 *
 * Default `accel` = `coreml` kalau host menawarkannya (11× WASM, docs/26 §4),
 * selain itu `cpu`. Host yang gagal menjawab `accels()` dianggap hanya `cpu`:
 * job masih bisa jalan, dan yang hilang hanya tombol pilihan.
 */
export function probeVocalSplitRuntime(): Promise<VocalSplitRuntime> {
  if (probe !== null) return probe;
  const native = nativeVocalSplitHost();
  if (native === undefined) {
    set({ runtime: 'wasm', accels: [], accel: 'cpu' });
    probe = Promise.resolve<VocalSplitRuntime>('wasm');
    return probe;
  }
  probe = native.accels().then(
    (accels): VocalSplitRuntime => {
      const list: readonly VocalSplitAccel[] = accels.includes('cpu') ? accels : ['cpu', ...accels];
      set({ runtime: 'native', accels: list, accel: list.includes('coreml') ? 'coreml' : 'cpu' });
      return 'native';
    },
    (reason: unknown): VocalSplitRuntime => {
      console.warn('[vocal-split] accels() gagal; memakai cpu:', reason);
      set({ runtime: 'native', accels: ['cpu'], accel: 'cpu' });
      return 'native';
    },
  );
  return probe;
}

/** Pilih akselerasi job berikutnya; nilai yang tidak ditawarkan host diabaikan. */
export function setVocalSplitAccel(accel: VocalSplitAccel): void {
  if (!snapshot.accels.includes(accel) || snapshot.accel === accel) return;
  set({ accel });
}

/**
 * Pastikan model siap di sesi ini; mengembalikan info sesi yang siap.
 *
 * Dipanggil dua tempat: tombol UNDUH di dialog (tanpa job) dan awal
 * `runVocalSplit`. Keduanya berbagi satu `init`/`ensureModel`: menekan UNDUH
 * lalu PISAHKAN sebelum unduhan selesai TIDAK memulai unduhan kedua — job
 * menunggu yang sedang berjalan.
 *
 * Runtime worker: sesi diganti (klien lama `dispose`, worker-nya mati) kalau
 * model, EP, atau batas thread berbeda dari yang dimuat. Byte model sudah ada
 * di cache (`appDataDir()/models` di desktop, OPFS di web), jadi ganti thread
 * hanya membayar pembangunan ulang sesi ORT, bukan unduhan.
 *
 * Runtime native: tahap "model" HANYA unduhan (`ensureModel`, idempoten).
 * Thread dan akselerasi tidak mengikat sesi — keduanya dikirim per job.
 */
export function ensureVocalModel(
  modelId: VocalModelId,
  options: VocalModelLoadOptions = {},
  onProgress?: (progress: VocalModelDownloadProgress) => void,
): Promise<VocalSessionInfo> {
  const native = nativeVocalSplitHost();
  const executionProvider = options.executionProvider ?? 'wasm';
  const current = session;
  if (current !== null) {
    if (reusable(current, native, modelId, executionProvider, options.maxThreads)) {
      // `init` masih berjalan: progresnya sudah masuk snapshot, pemanggil
      // kedua cukup ikut menunggu.
      return current.info === null ? current.ready : Promise.resolve(current.info);
    }
    disposeVocalSplitSession();
  }
  // Sesi didaftarkan SEBELUM `init`/`ensureModel` dipanggil: keduanya boleh
  // melaporkan progres secara sinkron (cache hit), dan laporan itu hanya
  // diterima kalau sesinya sudah menjadi `session`.
  const ready = deferred<VocalSessionInfo>();
  const next: Session = native === undefined
    ? { kind: 'wasm', client: createSplitClient(), modelId, executionProvider, maxThreads: options.maxThreads, ready: ready.promise, info: null }
    : { kind: 'native', modelId, ready: ready.promise, info: null };
  session = next;
  set({ model: { kind: 'loading', ratio: null, cacheHit: false }, modelId });

  const report = (p: VocalModelDownloadProgress): void => {
    if (session !== next) return;
    set({ model: { kind: 'loading', ratio: p.total > 0 ? Math.min(1, p.loaded / p.total) : null, cacheHit: p.cacheHit } });
    onProgress?.(p);
  };
  const started = performance.now();
  let cacheHit = false;
  const run: Promise<VocalSessionInfo> = next.kind === 'wasm'
    ? next.client
        .init(modelId, report, { maxThreads: options.maxThreads, executionProvider })
        .then((model) => ({ runtime: 'wasm', model }))
    : native!
        .ensureModel(modelId, (p) => {
          cacheHit = p.cacheHit;
          report(p);
        })
        .then(() => ({ runtime: 'native', modelId, cacheHit, loadMs: performance.now() - started }));
  run.then(ready.resolve, ready.reject);

  ready.promise.then(
    (info) => {
      if (session !== next) return;
      next.info = info;
      set({ model: { kind: 'ready', info } });
    },
    (reason: unknown) => {
      if (session !== next) return;
      // Sesi yang gagal tidak berguna; buang supaya UNDUH berikutnya mulai
      // dari klien baru, bukan dari klien yang menolak `init` kedua.
      session = null;
      if (next.kind === 'wasm') next.client.dispose();
      set({ model: { kind: 'error', message: reason instanceof Error ? reason.message : String(reason) } });
    },
  );
  return ready.promise;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function reusable(
  current: Session,
  native: VocalSplitHost | undefined,
  modelId: VocalModelId,
  executionProvider: VocalExecutionProvider,
  maxThreads: number | undefined,
): boolean {
  if (current.modelId !== modelId) return false;
  if (current.kind === 'native') return native !== undefined;
  if (native !== undefined) return false;
  if (current.executionProvider !== executionProvider) return false;
  // Batas thread hanya dibandingkan kalau pemanggil menyebutkannya; `init`
  // yang masih berjalan tidak diganggu — perubahan thread berlaku setelahnya.
  return maxThreads === undefined || current.info === null || current.maxThreads === maxThreads;
}

/**
 * Klien worker yang SIAP untuk model ini, atau null — juga null di runtime
 * native, yang tidak punya klien. `runVocalSplit` memakai ini setelah
 * `ensureVocalModel` pada jalur worker.
 */
export function readyVocalSplitClient(modelId: VocalModelId): SplitClient | null {
  if (session === null || session.kind !== 'wasm' || session.info === null || session.modelId !== modelId) return null;
  return session.client;
}

/** Model sudah siap di sesi ini (sesi ORT worker siap, atau berkas model ada di host native). */
export function isVocalModelReady(modelId: VocalModelId): boolean {
  return session !== null && session.info !== null && session.modelId === modelId;
}

/** Matikan worker (kalau ada) dan lupakan modelnya. Job yang menunggu ditolak oleh klien. */
export function disposeVocalSplitSession(): void {
  const current = session;
  session = null;
  if (current?.kind === 'wasm') current.client.dispose();
  set({ model: { kind: 'idle' }, modelId: null });
}

/** Dipakai `split-job.ts`: umumkan job yang mulai/selesai supaya tombol dan dialog ikut berubah. */
export function markVocalSplitJob(job: VocalSplitJob | null): void {
  if (snapshot.job === job) return;
  set({ job });
}

/** Sesi, probe runtime, dan snapshot kembali kosong. Hanya untuk tes. */
export function __resetVocalSplitSessionForTest(): void {
  const current = session;
  session = null;
  probe = null;
  if (current?.kind === 'wasm') current.client.dispose();
  snapshot = IDLE;
  for (const l of listeners) l();
}
