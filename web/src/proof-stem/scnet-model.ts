import type { InferenceSession } from 'onnxruntime-common';
import { getPlatformHost } from '../platform';
import {
  assertModelSize,
  SCNET_MODELS,
  type ScnetModelDownloadProgress,
  type ScnetModelId,
} from './scnet-catalog';

export {
  SCNET_MODELS,
  type ScnetModelDefinition,
  type ScnetModelDownloadProgress,
  type ScnetModelId,
} from './scnet-catalog';

let session: InferenceSession | null = null;
let runtime: typeof import('onnxruntime-web/wasm') | null = null;

export interface ScnetModelInfo {
  readonly loadMs: number;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly threads: number;
  readonly modelId: ScnetModelId;
  readonly modelBytes: number;
  readonly cacheHit: boolean;
}

export interface ScnetModelOptions {
  readonly maxThreads?: number;
  /**
   * Byte model yang sudah disiapkan main thread (lihat [`prefetchModelBytes`]).
   * Kalau ada, tidak ada unduhan di sini — dipakai di worker desktop, yang
   * tidak punya jembatan IPC untuk mengambilnya sendiri.
   */
  readonly bytes?: Uint8Array;
}

/**
 * Byte model untuk worker, atau `null` kalau worker bisa mengambilnya sendiri.
 *
 * Web: `null`. Worker memanggil `loadScnetModel` dan host web (fetch + cache
 * OPFS) bekerja di dalam worker; menariknya di main thread hanya menambah satu
 * salinan 170 MB yang harus dipindah.
 *
 * Desktop: byte lewat `model_download`/`model_read` — command Tauri hanya bisa
 * dipanggil dari WebView utama, `isTauri()` di worker selalu `false`. Hasilnya
 * dikirim ke worker sebagai transferable (`{type:'init', bytes}`), bukan
 * disalin.
 *
 * Ini satu-satunya cabang `kind` di luar `platform/`, dan alasannya bukan
 * selera: batasnya ada di Tauri (tidak ada IPC di worker), bukan di adapter.
 */
export async function prefetchModelBytes(
  modelId: ScnetModelId,
  onProgress: (progress: ScnetModelDownloadProgress) => void,
): Promise<Uint8Array | null> {
  const host = getPlatformHost();
  if (host.kind !== 'desktop') return null;
  const { bytes } = await host.modelBytes(modelId, onProgress);
  return bytes;
}

export async function loadScnetModel(
  modelId: ScnetModelId = 'base',
  onProgress: (progress: ScnetModelDownloadProgress) => void = () => {},
  options: ScnetModelOptions = {},
): Promise<ScnetModelInfo> {
  const ort = await import('onnxruntime-web/wasm');
  runtime = ort;
  const model = SCNET_MODELS[modelId];
  const threadLimit = options.maxThreads ?? 4;
  const threads = Math.max(1, Math.min(threadLimit, (navigator.hardwareConcurrency || 2) - 2));
  // Wrapper `.mjs` di-dynamic-import oleh ORT, jadi ia tidak boleh berada di
  // Vite `public/`. `new URL(..., import.meta.url)` membuat Vite menerbitkan
  // keduanya sebagai asset ber-hash dan memberi URL dev/build yang valid.
  const mjs = new URL(
    '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs',
    import.meta.url,
  ).href;
  const wasm = new URL(
    '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
    import.meta.url,
  ).href;
  ort.env.wasm.wasmPaths = {
    mjs,
    wasm,
  };
  ort.env.wasm.numThreads = threads;
  ort.env.wasm.simd = true;
  const cached = await loadModelBytes(modelId, onProgress, options.bytes);
  const started = performance.now();
  session ??= await ort.InferenceSession.create(cached.bytes, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
    executionMode: 'sequential',
  });
  return {
    loadMs: performance.now() - started,
    inputs: session.inputNames,
    outputs: session.outputNames,
    threads,
    modelId,
    modelBytes: model.bytes,
    cacheHit: cached.cacheHit,
  };
}

/**
 * Dari byte yang sudah disiapkan, atau dari platform. Jalur web (cache OPFS +
 * fetch `/models/...`) dan desktop (unduh sisi Rust ke `appDataDir()`) ada di
 * `platform/`; di sini yang tersisa hanya memilih dan memeriksa ukuran.
 */
async function loadModelBytes(
  modelId: ScnetModelId,
  onProgress: (progress: ScnetModelDownloadProgress) => void,
  prepared: Uint8Array | undefined,
): Promise<{ readonly bytes: Uint8Array; readonly cacheHit: boolean }> {
  const model = SCNET_MODELS[modelId];
  if (prepared !== undefined) {
    assertModelSize(model, prepared.byteLength);
    // Byte-nya sudah ada di tangan; dari sudut pandang worker ini cache hit.
    onProgress({ loaded: prepared.byteLength, total: model.bytes, cacheHit: true });
    return { bytes: prepared, cacheHit: true };
  }
  return getPlatformHost().modelBytes(modelId, onProgress);
}

export async function runScnet(input: Float32Array, dims: readonly number[]): Promise<Float32Array> {
  if (session === null || runtime === null) await loadScnetModel();
  if (session === null || runtime === null) throw new Error('SCNet session gagal diinisialisasi');
  const tensor = new runtime.Tensor('float32', input, [...dims]);
  try {
    const output = await session.run({ spectrogram: tensor });
    const separated = output.separated;
    if (separated === undefined || !(separated.data instanceof Float32Array)) {
      throw new Error('Output ONNX `separated` tidak ditemukan atau bukan Float32Array');
    }
    return separated.data;
  } finally {
    tensor.dispose();
  }
}

export function hasScnetSession(): boolean {
  return session !== null;
}
