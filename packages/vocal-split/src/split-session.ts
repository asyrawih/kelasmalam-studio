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
 * ## Akselerasi di jalur WASM: `wasmAccel` (`wasm` | `webgpu`)
 *
 * Terpisah dari `accel` native. `webgpu` hanya ditawarkan kalau
 * `navigator.gpu.requestAdapter()` mengembalikan adapter (probe sekali,
 * di-cache — [`probeWebGpu`]); kalau ada, itu bawaannya. EP-nya diteruskan ke
 * `SplitClient.init` sebagai `executionProvider`. MDX-Net tidak punya LSTM,
 * jadi catatan docs/14 §WebGPU tidak berlaku (docs/26 §4).
 *
 * WebGPU boleh gagal di tengah jalan (adapter hilang, shader tidak
 * terkompilasi, op yang tidak didukung): `init` yang gagal DI SINI, dan
 * `separate` yang gagal di `split-job.ts`, dicoba ulang SEKALI dengan `wasm`
 * secara transparan ([`fallbackVocalSplitToWasm`]); alasannya dicatat di
 * `runtimeNote` supaya dialog bisa bilang "WebGPU gagal, memakai WASM".
 * AbortError bukan kegagalan runtime dan tidak memicu fallback.
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

/** Akselerasi di jalur worker ORT-web: EP `wasm` (CPU) atau `webgpu`. */
export type VocalSplitWasmAccel = VocalExecutionProvider;

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

/**
 * Kenapa job berakhir `{cancelled}` tanpa lane baru (docs/26 §3c):
 *   - `signal`: HENTIKAN ditekan (`cancelVocalSplit`);
 *   - `clip-hilang`: clip sumber dihapus saat job jalan;
 *   - `lane-berubah`: clip masih ada tapi sudah pindah lane;
 *   - `job-tidak-terdaftar`: proyek diganti (`hydrate` mengosongkan `importJobs`).
 */
export type VocalSplitCancelReason = 'signal' | 'clip-hilang' | 'lane-berubah' | 'job-tidak-terdaftar';

/** Teks alasan batal untuk dialog; kuncinya dipakai di log. */
export const CANCEL_REASON_TEXT: Record<VocalSplitCancelReason, string> = {
  signal: 'dihentikan',
  'clip-hilang': 'clip sumber hilang saat job berjalan',
  'lane-berubah': 'clip sumber pindah lane saat job berjalan',
  'job-tidak-terdaftar': 'proyek diganti saat job berjalan',
};

/**
 * Hasil job terakhir yang berakhir tanpa galat; dialog memakainya untuk
 * membedakan "batal" dari "gagal", dan untuk menampilkan waktu pemisahan
 * (`totalMs` seluruh `separate`, `inferenceMs` hanya di dalam ORT — null di
 * native yang tidak melaporkannya, `segments` jumlah segmen) supaya WASM vs
 * WebGPU bisa dibandingkan tanpa DevTools.
 */
export type VocalSplitLastOutcome =
  | {
      readonly laneIds: readonly string[];
      readonly totalMs: number;
      readonly inferenceMs: number | null;
      readonly segments: number;
    }
  | { readonly cancelled: true; readonly reason: VocalSplitCancelReason };

export interface VocalSplitSnapshot {
  readonly model: VocalModelStatus;
  /** Model yang sedang/terakhir dimuat sesi; null sebelum `init` pertama. */
  readonly modelId: VocalModelId | null;
  readonly job: VocalSplitJob | null;
  /**
   * Galat job terakhir (pesan + kode host kalau ada), tetap ada sampai job
   * baru mulai atau user menutupnya di dialog. Hidup di sini, bukan di
   * komponen: dialog sudah tertutup saat galatnya datang, dan `window.alert`
   * di WKWebView (wry) tidak menampilkan apa pun.
   */
  readonly lastError: string | null;
  /** Hasil job terakhir; null selama job berjalan, setelah gagal, atau sebelum job pertama. */
  readonly lastOutcome: VocalSplitLastOutcome | null;
  /** Runtime yang dipakai; `null` sebelum [`probeVocalSplitRuntime`] pertama. */
  readonly runtime: VocalSplitRuntime | null;
  /** Akselerasi yang ditawarkan host native; kosong untuk `wasm` atau sebelum probe. */
  readonly accels: readonly VocalSplitAccel[];
  /** Pilihan akselerasi job berikutnya. Default `coreml` kalau tersedia, selain itu `cpu`. */
  readonly accel: VocalSplitAccel;
  /** Akselerasi jalur worker yang tersedia: `['wasm']` atau `['wasm', 'webgpu']`; hanya `['wasm']` sebelum probe. */
  readonly wasmAccels: readonly VocalSplitWasmAccel[];
  /** EP jalur worker untuk sesi berikutnya. Default `webgpu` kalau adapter ada, selain itu `wasm`. */
  readonly wasmAccel: VocalSplitWasmAccel;
  /** Catatan runtime untuk dialog, mis. "WebGPU gagal, memakai WASM"; null kalau tidak ada. */
  readonly runtimeNote: string | null;
}

export interface VocalModelLoadOptions {
  readonly maxThreads?: number;
  /** Default = `wasmAccel` sesi (docs/26 §4). Hanya berarti untuk runtime worker. */
  readonly executionProvider?: VocalExecutionProvider;
}

interface WasmSession {
  readonly kind: 'wasm';
  /** Bukan `readonly`: fallback WebGPU → WASM menukar klien dan EP di sesi yang sama. */
  client: SplitClient;
  readonly modelId: VocalModelId;
  executionProvider: VocalExecutionProvider;
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
  lastError: null,
  lastOutcome: null,
  runtime: null,
  accels: [],
  accel: 'cpu',
  wasmAccels: ['wasm'],
  wasmAccel: 'wasm',
  runtimeNote: null,
};

let snapshot: VocalSplitSnapshot = IDLE;
let session: Session | null = null;
let probe: Promise<VocalSplitRuntime> | null = null;
let webgpuProbe: Promise<boolean> | null = null;
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

/** Jumlah core yang dilaporkan browser; 2 kalau tidak ada. */
function cores(): number {
  return typeof navigator === 'undefined' ? 2 : navigator.hardwareConcurrency || 2;
}

/**
 * Jumlah thread bawaan dialog: `min(8, cores − 2)`, minimal 1. Batas 8, bukan
 * 4 seperti `loadScnetModel`: benchmark docs/26 §4 — 4 thread 5,2 s/segmen,
 * 8 thread 4,3 s. Dua core disisakan untuk main thread dan audio.
 */
export function defaultVocalSplitThreads(): number {
  return Math.max(1, Math.min(8, cores() - 2));
}

/** Batas atas pilihan thread di dialog: `cores − 1`, minimal 1 — satu core untuk main thread. */
export function maxVocalSplitThreads(): number {
  return Math.max(1, cores() - 1);
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
    probe = probeWebGpu().then((available): VocalSplitRuntime => {
      // Sesi yang sudah mulai (UNDUH ditekan sebelum probe selesai) tidak
      // diganggu: bawaan `webgpu` hanya dipasang kalau belum ada sesi.
      set({
        wasmAccels: available ? ['wasm', 'webgpu'] : ['wasm'],
        wasmAccel: available && session === null ? 'webgpu' : snapshot.wasmAccel,
      });
      return 'wasm';
    });
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

interface GpuNavigator {
  readonly gpu?: { requestAdapter(): Promise<unknown> };
}

/**
 * WebGPU tersedia untuk ORT-web? `navigator.gpu` ada DAN `requestAdapter()`
 * mengembalikan adapter (bukan null — browser yang punya API-nya tapi tidak
 * punya GPU yang diizinkan menjawab null). Probe sekali, di-cache; gagal
 * (exception) dihitung tidak tersedia.
 */
export function probeWebGpu(): Promise<boolean> {
  if (webgpuProbe !== null) return webgpuProbe;
  const nav = typeof navigator === 'undefined' ? undefined : (navigator as unknown as GpuNavigator);
  const gpu = nav !== undefined && 'gpu' in nav ? nav.gpu : undefined;
  if (gpu === undefined || typeof gpu.requestAdapter !== 'function') {
    webgpuProbe = Promise.resolve(false);
    return webgpuProbe;
  }
  webgpuProbe = Promise.resolve()
    .then(() => gpu.requestAdapter())
    .then(
      (adapter) => adapter !== null && adapter !== undefined,
      (reason: unknown) => {
        console.warn('[vocal-split] requestAdapter() gagal; WebGPU tidak ditawarkan:', reason);
        return false;
      },
    );
  return webgpuProbe;
}

/**
 * Pilih EP jalur worker untuk sesi berikutnya; nilai yang tidak tersedia
 * diabaikan. Sesi worker yang sudah ada dengan EP lain DIBUANG dan dimuat
 * ulang seketika (byte model sudah di OPFS/host, jadi yang dibayar hanya
 * pembangunan sesi ORT) — supaya status "siap" di dialog selalu milik EP
 * yang dipilih, bukan EP sebelumnya.
 */
export function setVocalSplitWasmAccel(accel: VocalSplitWasmAccel): void {
  if (!snapshot.wasmAccels.includes(accel) || snapshot.wasmAccel === accel) return;
  set({ wasmAccel: accel, runtimeNote: null });
  const current = session;
  if (current === null || current.kind !== 'wasm' || current.executionProvider === accel) return;
  const { modelId, maxThreads } = current;
  disposeVocalSplitSession();
  // Galatnya sudah masuk snapshot (`model.kind === 'error'`); tidak ada yang menunggu di sini.
  void ensureVocalModel(modelId, { maxThreads, executionProvider: accel }).catch(() => {});
}

/** EP sesi worker saat ini (`wasm`/`webgpu`), atau null tanpa sesi worker. */
export function vocalSplitSessionExecutionProvider(): VocalExecutionProvider | null {
  return session?.kind === 'wasm' ? session.executionProvider : null;
}

function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

/** Teks `runtimeNote` + `console.warn` untuk fallback; `where` = `init` atau `separate`. */
function noteWebGpuFallback(where: string, reason: unknown): string {
  const message = vocalSplitErrorMessage(reason);
  console.warn(`[vocal-split] webgpu gagal, jatuh ke wasm: ${where}: ${message}`);
  return `WebGPU gagal (${where}: ${message}), memakai WASM`;
}

/**
 * Jatuh dari WebGPU ke WASM setelah `separate` gagal (dipanggil
 * `split-job.ts`; kegagalan `init` ditangani di dalam [`ensureVocalModel`]):
 * catat alasannya, kunci `wasmAccel` ke `wasm` supaya sesi berikutnya tidak
 * mencoba WebGPU lagi diam-diam, buang sesi WebGPU, dan muat ulang dengan
 * `wasm`. Mengembalikan klien yang siap.
 *
 * Hanya SEKALI per kegagalan: sesudah ini EP sesinya `wasm`, jadi pemanggil
 * yang memeriksa [`vocalSplitSessionExecutionProvider`] tidak akan mencoba
 * fallback kedua.
 */
export async function fallbackVocalSplitToWasm(
  modelId: VocalModelId,
  options: { readonly maxThreads?: number },
  reason: unknown,
): Promise<SplitClient> {
  const note = noteWebGpuFallback('separate', reason);
  set({ wasmAccel: 'wasm' });
  disposeVocalSplitSession();
  const ready = ensureVocalModel(modelId, { maxThreads: options.maxThreads, executionProvider: 'wasm' });
  // Setelah `ensureVocalModel`: sesi baru selalu mulai dengan `runtimeNote` kosong.
  set({ runtimeNote: note });
  await ready;
  const client = readyVocalSplitClient(modelId);
  if (client === null) throw new Error('sesi model hilang setelah fallback ke wasm');
  return client;
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
  const executionProvider = options.executionProvider ?? snapshot.wasmAccel;
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
  set({ model: { kind: 'loading', ratio: null, cacheHit: false }, modelId, runtimeNote: null });

  const report = (p: VocalModelDownloadProgress): void => {
    if (session !== next) return;
    set({ model: { kind: 'loading', ratio: p.total > 0 ? Math.min(1, p.loaded / p.total) : null, cacheHit: p.cacheHit } });
    onProgress?.(p);
  };
  const started = performance.now();
  let cacheHit = false;
  const run: Promise<VocalSessionInfo> = next.kind === 'wasm'
    ? initWasmWithFallback(next, report, options.maxThreads)
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

/**
 * `init` worker dengan EP sesi; kalau EP-nya `webgpu` dan ORT melempar
 * (bukan AbortError), klien dibuang, klien BARU dibuat, dan `init` diulang
 * SEKALI dengan `wasm` di sesi yang sama — `wasmAccel` dikunci ke `wasm` dan
 * `runtimeNote` diisi. Kegagalan `wasm` (termasuk yang kedua) dilempar apa
 * adanya: tidak ada lagi tempat untuk jatuh.
 */
async function initWasmWithFallback(
  next: WasmSession,
  report: (p: VocalModelDownloadProgress) => void,
  maxThreads: number | undefined,
): Promise<VocalSessionInfo> {
  try {
    const model = await next.client.init(next.modelId, report, { maxThreads, executionProvider: next.executionProvider });
    return { runtime: 'wasm', model };
  } catch (reason: unknown) {
    if (next.executionProvider !== 'webgpu' || isAbortError(reason) || session !== next) throw reason;
    const note = noteWebGpuFallback('init', reason);
    next.client.dispose();
    next.client = createSplitClient();
    next.executionProvider = 'wasm';
    set({ wasmAccel: 'wasm', runtimeNote: note, model: { kind: 'loading', ratio: null, cacheHit: false } });
    const model = await next.client.init(next.modelId, report, { maxThreads, executionProvider: 'wasm' });
    return { runtime: 'wasm', model };
  }
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

/**
 * Catat (atau hapus, `null`) galat job terakhir. `split-job.ts` mengisinya di
 * `catch`, dialog menghapusnya lewat TUTUP; job baru selalu mulai dengan
 * `null` supaya galat lama tidak tampak seperti galat job yang sedang jalan.
 */
export function setVocalSplitError(message: string | null): void {
  if (snapshot.lastError === message) return;
  set({ lastError: message });
}

/** Catat hasil job terakhir (`null` = belum ada / sedang berjalan / gagal). */
export function setVocalSplitOutcome(outcome: VocalSplitLastOutcome | null): void {
  if (snapshot.lastOutcome === outcome) return;
  set({ lastOutcome: outcome });
}

/**
 * Pesan galat untuk `lastError`/log: `KODE: pesan` kalau galatnya membawa
 * `code` string (galat command Rust — `VocalSplitCommandError` di host
 * desktop, atau `{code, message}` mentah dari IPC), selain itu pesannya saja.
 * Kodenya penting: `MODEL_MISSING`, `BUSY`, `INFERENCE` menunjuk ke penyebab
 * yang berbeda meski pesannya sama-sama "gagal".
 */
export function vocalSplitErrorMessage(err: unknown): string {
  const code = typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string'
    ? (err as { code: string }).code
    : null;
  const message = err instanceof Error
    ? err.message
    : typeof err === 'object' && err !== null && typeof (err as { message?: unknown }).message === 'string'
      ? (err as { message: string }).message
      : String(err);
  return code === null || message.startsWith(`${code}:`) ? message : `${code}: ${message}`;
}

/** Sesi, probe runtime, dan snapshot kembali kosong. Hanya untuk tes. */
export function __resetVocalSplitSessionForTest(): void {
  const current = session;
  session = null;
  probe = null;
  webgpuProbe = null;
  if (current?.kind === 'wasm') current.client.dispose();
  snapshot = IDLE;
  for (const l of listeners) l();
}
