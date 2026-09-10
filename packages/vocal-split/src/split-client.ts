/**
 * Pembungkus main thread untuk `split.worker.ts` (docs/26 §5): protokol
 * pesan diubah jadi Promise supaya dialog SPLIT (P3) dan benchmark (P1)
 * tidak menulis `onmessage` masing-masing.
 *
 * Byte model: kalau host punya `modelBytes` (desktop), `init` mengambilnya di
 * sini lewat [`prefetchVocalModelBytes`] dan MEMINDAHKAN buffer-nya ke worker;
 * kalau tidak (web), worker mengunduh sendiri ke OPFS. Keputusan ini
 * berdasarkan kontrak host, bukan `kind` platform (docs/25 §1b).
 *
 * Satu client = satu worker = satu sesi ORT. `dispose()` mematikan worker;
 * client tidak bisa dipakai lagi sesudahnya.
 */

import { prefetchVocalModelBytes, type VocalExecutionProvider, type VocalModelDownloadProgress, type VocalModelInfo } from './mdx-model';
import type { VocalModelId } from './catalog';
import type { MdxOverlap } from './mdx-separate';
import type { SplitProgress, SplitRequest, SplitResponse, SplitResult } from './split-protocol';

export type { SplitProgress, SplitResult } from './split-protocol';

export interface SplitInitOptions {
  readonly maxThreads?: number;
  /** Default `'wasm'`; `'webgpu'` kalau sesi memilihnya (`split-session.ts`, docs/26 §4). */
  readonly executionProvider?: VocalExecutionProvider;
}

export interface SplitSeparateOptions {
  readonly overlap: MdxOverlap;
  readonly denoise: boolean;
  /** `false` → instrumental = `mix − vokal` tanpa pengali `compensate`. Default `true`. */
  readonly compensate?: boolean;
  /**
   * `true` → buffer `left`/`right` DIPINDAHKAN ke worker (nol salinan) dan
   * tidak bisa dipakai pemanggil lagi. Default `false`: disalin dulu, karena
   * PCM sumber biasanya masih dipakai (clip asal tetap ada di lane).
   */
  readonly transfer?: boolean;
}

export interface SplitClient {
  init(
    modelId: VocalModelId,
    onModelProgress?: (progress: VocalModelDownloadProgress) => void,
    options?: SplitInitOptions,
  ): Promise<VocalModelInfo>;
  separate(
    left: Float32Array,
    right: Float32Array,
    options: SplitSeparateOptions,
    onProgress?: (progress: SplitProgress) => void,
    signal?: AbortSignal,
  ): Promise<SplitResult>;
  dispose(): void;
}

interface PendingInit {
  readonly resolve: (info: VocalModelInfo) => void;
  readonly reject: (reason: unknown) => void;
  readonly onProgress: ((progress: VocalModelDownloadProgress) => void) | undefined;
}

interface PendingSeparate {
  readonly resolve: (result: SplitResult) => void;
  readonly reject: (reason: unknown) => void;
  readonly onProgress: ((progress: SplitProgress) => void) | undefined;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: () => void;
}

function abortError(): DOMException {
  return new DOMException('Vocal split dibatalkan', 'AbortError');
}

export function createSplitClient(): SplitClient {
  const worker = new Worker(new URL('./split.worker.ts', import.meta.url), { type: 'module' });
  let ready = false;
  let disposed = false;
  let pendingInit: PendingInit | null = null;
  let pendingSeparate: PendingSeparate | null = null;

  function send(request: SplitRequest, transfer: Transferable[] = []): void {
    worker.postMessage(request, transfer);
  }

  function settleSeparate(): PendingSeparate | null {
    const pending = pendingSeparate;
    pendingSeparate = null;
    pending?.signal?.removeEventListener('abort', pending.onAbort);
    return pending;
  }

  function fail(reason: unknown): void {
    const init = pendingInit;
    pendingInit = null;
    init?.reject(reason);
    settleSeparate()?.reject(reason);
  }

  worker.onmessage = (event: MessageEvent<SplitResponse>): void => {
    const message = event.data;
    switch (message.type) {
      case 'model-progress':
        pendingInit?.onProgress?.({ loaded: message.loaded, total: message.total, cacheHit: message.cacheHit });
        return;
      case 'ready': {
        const init = pendingInit;
        pendingInit = null;
        ready = true;
        const { type: _type, ...info } = message;
        init?.resolve(info);
        return;
      }
      case 'progress':
        pendingSeparate?.onProgress?.({ done: message.done, total: message.total, segmentMs: message.segmentMs });
        return;
      case 'done': {
        const pending = settleSeparate();
        if (pending === null) return;
        // Pembatalan yang kalah cepat dari segmen terakhir: pemanggil sudah
        // tidak menunggu hasilnya, jadi tetap dijawab AbortError.
        if (pending.signal?.aborted) {
          pending.reject(abortError());
          return;
        }
        const { type: _type, ...result } = message;
        pending.resolve(result);
        return;
      }
      case 'cancelled':
        settleSeparate()?.reject(abortError());
        return;
      case 'error':
        // Galat saat `init` milik init; sesudahnya milik job yang berjalan.
        // Galat tanpa penunggu (mis. `separate` sebelum `init`) tidak ada
        // yang bisa diberi tahu — sudah dilaporkan sebagai reject di bawah.
        fail(new Error(message.message));
        return;
    }
  };

  worker.onerror = (event: ErrorEvent): void => {
    fail(event.error instanceof Error ? event.error : new Error(event.message || 'Worker vocal split gagal'));
  };

  return {
    init(modelId, onModelProgress, options = {}) {
      if (disposed) return Promise.reject(new Error('SplitClient sudah dibuang'));
      if (pendingInit !== null) return Promise.reject(new Error('init masih berjalan'));
      return new Promise<VocalModelInfo>((resolve, reject) => {
        pendingInit = { resolve, reject, onProgress: onModelProgress };
        // Host dengan `modelBytes`: unduh/baca di main thread (progres ikut
        // `onModelProgress`), lalu pindahkan ke worker. Tanpa itu: `null`,
        // worker mengunduh sendiri dan progresnya datang lewat `model-progress`.
        prefetchVocalModelBytes(modelId, (progress) => onModelProgress?.(progress))
          .then((bytes) => {
            if (disposed || pendingInit === null) return;
            const base = { type: 'init' as const, modelId, maxThreads: options.maxThreads, executionProvider: options.executionProvider };
            if (bytes === null) send(base);
            else send({ ...base, bytes }, [bytes.buffer]);
          })
          .catch((reason: unknown) => {
            if (pendingInit !== null && pendingInit.reject === reject) pendingInit = null;
            reject(reason);
          });
      });
    },

    separate(left, right, options, onProgress, signal) {
      if (disposed) return Promise.reject(new Error('SplitClient sudah dibuang'));
      if (!ready) return Promise.reject(new Error('Model belum dimuat: panggil init dulu'));
      if (pendingSeparate !== null) return Promise.reject(new Error('Vocal split masih berjalan'));
      if (signal?.aborted) return Promise.reject(abortError());
      return new Promise<SplitResult>((resolve, reject) => {
        const onAbort = (): void => send({ type: 'cancel' });
        pendingSeparate = { resolve, reject, onProgress, signal, onAbort };
        signal?.addEventListener('abort', onAbort, { once: true });
        const l = options.transfer ? left : left.slice();
        const r = options.transfer ? right : right.slice();
        send({
          type: 'separate',
          left: l,
          right: r,
          overlap: options.overlap,
          denoise: options.denoise,
          compensate: options.compensate,
        }, [l.buffer, r.buffer]);
      });
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      ready = false;
      worker.terminate();
      fail(new Error('SplitClient dibuang'));
    },
  };
}
