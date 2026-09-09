import type { InferenceSession } from 'onnxruntime-common';
import { getPlatformHost, type ModelBytes } from '@kelasmalam/platform';
import {
  assertModelSize,
  SCNET_MODELS,
  type ScnetModelDefinition,
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
 * Yang ditanya adalah KONTRAK host, bukan platformnya: host yang punya
 * `modelBytes` (desktop: `model_download`/`model_read` lewat command Tauri)
 * hanya bisa dipanggil dari WebView utama — IPC tidak ada di worker — jadi
 * main thread mengambilnya di sini dan mengirimnya ke worker sebagai
 * transferable (`{type:'init', bytes}`), bukan disalin. Host tanpa
 * `modelBytes` (web) membiarkan worker memanggil `loadScnetModel` dan
 * [`fetchModelBytesInBrowser`] bekerja di dalam worker; menariknya di main
 * thread hanya menambah satu salinan 170 MB yang harus dipindah.
 */
export async function prefetchModelBytes(
  modelId: ScnetModelId,
  onProgress: (progress: ScnetModelDownloadProgress) => void,
): Promise<Uint8Array | null> {
  const host = getPlatformHost();
  if (host.modelBytes === undefined) return null;
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
  //
  // `@ort-dist` adalah alias Vite (`apps/web/ort-dist.ts`) ke
  // `onnxruntime-web/dist/` — BUKAN path relatif ke `node_modules`, karena
  // letak folder itu bergantung pada pengelola paket (workspace bun meng-hoist
  // ke root repo) dan Vite tidak menganggap `new URL` yang tidak ketemu sebagai
  // galat. `__tests__/ort-dist.test.ts` menjaga berkasnya benar-benar ada.
  const mjs = new URL('@ort-dist/ort-wasm-simd-threaded.mjs', import.meta.url).href;
  const wasm = new URL('@ort-dist/ort-wasm-simd-threaded.wasm', import.meta.url).href;
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
 * Dari byte yang sudah disiapkan main thread, atau diambil sendiri.
 *
 * Fungsi ini berjalan di WORKER, dan di sana tidak ada host platform: app
 * mendaftarkan resolver host di modul platform miliknya, yang tidak pernah
 * dimuat worker (docs/25 §1d). Jadi worker tidak bertanya ke host sama
 * sekali — kalau host punya `modelBytes`, main thread sudah memanggilnya
 * ([`prefetchModelBytes`]) dan byte-nya ada di `prepared`; kalau tidak,
 * jalur browser umum di bawah yang bekerja.
 */
async function loadModelBytes(
  modelId: ScnetModelId,
  onProgress: (progress: ScnetModelDownloadProgress) => void,
  prepared: Uint8Array | undefined,
): Promise<ModelBytes> {
  const model = SCNET_MODELS[modelId];
  if (prepared !== undefined) {
    assertModelSize(model, prepared.byteLength);
    // Byte-nya sudah ada di tangan; dari sudut pandang worker ini cache hit.
    onProgress({ loaded: prepared.byteLength, total: model.bytes, cacheHit: true });
    return { bytes: prepared, cacheHit: true };
  }
  return fetchModelBytesInBrowser(model, onProgress);
}

/**
 * Jalur browser umum: cache di OPFS kalau ada, supaya 44–170 MB tidak diunduh
 * ulang tiap kunjungan. Tanpa OPFS (Safari lama, konteks tertentu) jalurnya
 * fetch langsung ke memori — tetap jalan, hanya tidak diingat.
 *
 * Bukan bagian host web: ini yang dilakukan browser MANA PUN yang tidak punya
 * cara lain, termasuk worker di desktop yang byte-nya belum disiapkan. Host
 * yang punya cara lain (desktop) menyediakan `modelBytes`.
 */
export async function fetchModelBytesInBrowser(
  model: ScnetModelDefinition,
  onProgress: (progress: ScnetModelDownloadProgress) => void,
): Promise<ModelBytes> {
  if (typeof navigator.storage?.getDirectory !== 'function') {
    const response = await fetchModel(model);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assertModelSize(model, bytes.byteLength);
    onProgress({ loaded: bytes.byteLength, total: model.bytes, cacheHit: false });
    return { bytes, cacheHit: false };
  }

  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle('scnet-models', { create: true });
  const fileName = `scnet-${model.id}-${model.sha256.slice(0, 12)}.onnx`;
  try {
    const existing = await directory.getFileHandle(fileName);
    const file = await existing.getFile();
    if (file.size === model.bytes) {
      onProgress({ loaded: file.size, total: model.bytes, cacheHit: true });
      return { bytes: new Uint8Array(await file.arrayBuffer()), cacheHit: true };
    }
    await directory.removeEntry(fileName);
  } catch {
    // Cache miss normal.
  }

  void navigator.storage.persist?.();
  const response = await fetchModel(model);
  const handle = await directory.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  const reader = response.body?.getReader();
  let loaded = 0;
  try {
    if (reader === undefined) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      await writable.write(bytes);
      loaded = bytes.byteLength;
      onProgress({ loaded, total: model.bytes, cacheHit: false });
    } else {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writable.write(value);
        loaded += value.byteLength;
        onProgress({ loaded, total: model.bytes, cacheHit: false });
      }
    }
    await writable.close();
  } catch (reason) {
    await writable.abort(reason).catch(() => {});
    await directory.removeEntry(fileName).catch(() => {});
    throw reason;
  }

  assertModelSize(model, loaded);
  const file = await handle.getFile();
  return { bytes: new Uint8Array(await file.arrayBuffer()), cacheHit: false };
}

async function fetchModel(model: ScnetModelDefinition): Promise<Response> {
  const response = await fetch(model.url);
  if (!response.ok) throw new Error(`Download ${model.label} gagal: HTTP ${response.status}`);
  return response;
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
