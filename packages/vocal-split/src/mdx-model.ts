/**
 * Pemuat ONNX Kim_Vocal_2 (docs/26 §2 butir 2, §5) — pola
 * `proof-stem/scnet-model.ts`, ditulis ulang di sini dan BUKAN diimpor dari
 * sana: `vocal-split` dan `proof-stem` tidak boleh saling bergantung
 * (`no-package-cycles.test.ts`), dan duplikasi ±60 baris jalur fetch + OPFS
 * lebih murah daripada paket ketiga yang cuma berisi itu.
 *
 * Dua jalur byte model, dipilih oleh KONTRAK host, bukan platform:
 *   - host punya `modelBytes` (desktop: `model_download`/`model_read` lewat
 *     Rust) → main thread mengambilnya ([`prefetchVocalModelBytes`]) dan
 *     mengirimnya ke worker sebagai transferable;
 *   - host tanpa `modelBytes` (web) → worker `fetch` langsung dari HuggingFace
 *     dan menyimpannya di OPFS ([`fetchVocalModelBytesInBrowser`]). Bobot
 *     tidak pernah menyentuh origin kita (docs/26 §2 butir 3).
 *
 * Sesi ORT disimpan per modul — satu worker, satu sesi. Model yang dipakai
 * `separateMdx` adalah [`runVocalModel`], cocok dengan tanda tangan `MdxModel`.
 */

import type { InferenceSession } from 'onnxruntime-common';
import { getPlatformHost, type ModelBytes, type ScnetModelDownloadProgress } from '@kelasmalam/platform';
import {
  assertVocalModelSize,
  VOCAL_MODELS,
  type VocalModelDefinition,
  type VocalModelId,
} from './catalog';
import type { MdxDims } from './mdx-stft';

/** Bentuk progres milik kontrak host (`PlatformHost.modelBytes`), dipakai untuk kedua keluarga model. */
export type VocalModelDownloadProgress = ScnetModelDownloadProgress;

/**
 * `wasm` adalah jalur produksi P0/P1. `webgpu` ditawarkan di web sejak 10 Sep
 * 2026 (docs/26 §4) kalau `navigator.gpu.requestAdapter()` memberi adapter —
 * `split-session.ts` yang memprobe dan yang jatuh kembali ke `wasm` kalau
 * WebGPU gagal. MDX-Net tidak punya LSTM, jadi catatan docs/14 §WebGPU tidak
 * berlaku.
 */
export type VocalExecutionProvider = 'wasm' | 'webgpu';

export interface VocalModelInfo {
  readonly loadMs: number;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly threads: number;
  readonly modelId: VocalModelId;
  readonly modelBytes: number;
  readonly cacheHit: boolean;
  readonly executionProvider: VocalExecutionProvider;
}

export interface VocalModelOptions {
  readonly maxThreads?: number;
  /**
   * Byte model yang sudah disiapkan main thread ([`prefetchVocalModelBytes`]).
   * Kalau ada, tidak ada unduhan di sini — dipakai di worker desktop, yang
   * tidak punya jembatan IPC untuk mengambilnya sendiri.
   */
  readonly bytes?: Uint8Array;
  /** Default `'wasm'`. */
  readonly executionProvider?: VocalExecutionProvider;
}

/** Runtime ORT; bundel `wasm` dan `webgpu` punya API yang sama (`onnxruntime-common`). */
type OrtRuntime = typeof import('onnxruntime-web/wasm');

interface LoadedSession {
  readonly session: InferenceSession;
  readonly runtime: OrtRuntime;
  readonly modelId: VocalModelId;
  readonly executionProvider: VocalExecutionProvider;
  /** Nama tensor dibaca dari sesi saat load, bukan ditulis mati. */
  readonly inputName: string;
  readonly outputName: string;
}

let loaded: LoadedSession | null = null;

/**
 * Byte model untuk worker, atau `null` kalau worker bisa mengambilnya sendiri.
 *
 * Host yang punya `modelBytes` hanya bisa dipanggil dari WebView utama — IPC
 * tidak ada di worker — jadi main thread mengambilnya di sini dan mengirimnya
 * ke worker sebagai transferable (`{type:'init', bytes}`). Host tanpa
 * `modelBytes` membiarkan worker memanggil [`loadVocalModel`] dan
 * [`fetchVocalModelBytesInBrowser`] bekerja di dalam worker; menariknya di
 * main thread hanya menambah satu salinan 64 MB yang harus dipindah.
 */
export async function prefetchVocalModelBytes(
  modelId: VocalModelId,
  onProgress: (progress: VocalModelDownloadProgress) => void,
): Promise<Uint8Array | null> {
  const host = getPlatformHost();
  if (host.modelBytes === undefined) return null;
  const { bytes } = await host.modelBytes(modelId, onProgress);
  return bytes;
}

export async function loadVocalModel(
  modelId: VocalModelId = 'kim-vocal-2',
  onProgress: (progress: VocalModelDownloadProgress) => void = () => {},
  options: VocalModelOptions = {},
): Promise<VocalModelInfo> {
  const model = VOCAL_MODELS[modelId];
  const executionProvider = options.executionProvider ?? 'wasm';
  // Bundel `webgpu` membawa backend JSEP di atas WASM yang sama; bundel `wasm`
  // lebih kecil dan cukup untuk jalur produksi.
  const ort: OrtRuntime = executionProvider === 'webgpu'
    ? await import('onnxruntime-web/webgpu')
    : await import('onnxruntime-web/wasm');
  // Batas 8 (bukan 4): docs/26 §4 — 8 thread 4,3 s/segmen vs 4 thread 5,2 s.
  const threadLimit = options.maxThreads ?? 8;
  const threads = Math.max(1, Math.min(threadLimit, (navigator.hardwareConcurrency || 2) - 2));
  // Wrapper `.mjs` di-dynamic-import oleh ORT, jadi ia tidak boleh berada di
  // Vite `public/`. `new URL(..., import.meta.url)` membuat Vite menerbitkan
  // keduanya sebagai asset ber-hash dan memberi URL dev/build yang valid.
  //
  // `@ort-dist` adalah alias Vite (`packages/engine/vite/ort-dist.ts`) ke
  // `onnxruntime-web/dist/` — BUKAN path relatif ke `node_modules`, karena
  // letak folder itu bergantung pada pengelola paket (workspace bun meng-hoist
  // ke root repo). `apps/web/src/__tests__/ort-dist.test.ts` menjaga berkas
  // `wasm`-nya ada; varian `.jsep` dipakai EP WebGPU.
  ort.env.wasm.wasmPaths = executionProvider === 'webgpu'
    ? {
        mjs: new URL('@ort-dist/ort-wasm-simd-threaded.jsep.mjs', import.meta.url).href,
        wasm: new URL('@ort-dist/ort-wasm-simd-threaded.jsep.wasm', import.meta.url).href,
      }
    : {
        mjs: new URL('@ort-dist/ort-wasm-simd-threaded.mjs', import.meta.url).href,
        wasm: new URL('@ort-dist/ort-wasm-simd-threaded.wasm', import.meta.url).href,
      };
  // `numThreads` diset untuk KEDUA EP: WebGPU (JSEP) tetap menjalankan op
  // yang tidak punya kernel GPU di WASM, dan pool thread-nya yang ini.
  ort.env.wasm.numThreads = threads;
  ort.env.wasm.simd = true;

  const cached = await loadModelBytes(model, onProgress, options.bytes);
  const started = performance.now();
  if (loaded !== null && (loaded.modelId !== modelId || loaded.executionProvider !== executionProvider)) {
    // `init` kedua dengan model/EP lain berarti ganti, bukan tumpuk dua sesi.
    await disposeVocalModel();
  }
  if (loaded === null) {
    const session = await ort.InferenceSession.create(cached.bytes, {
      executionProviders: [executionProvider],
      graphOptimizationLevel: 'all',
      executionMode: 'sequential',
    });
    const inputName = session.inputNames[0];
    const outputName = session.outputNames[0];
    if (inputName === undefined || outputName === undefined) {
      await session.release();
      throw new Error(
        `Model ${model.label} tidak punya tensor input/output: ` +
        `inputs=[${session.inputNames.join(', ')}] outputs=[${session.outputNames.join(', ')}]`,
      );
    }
    loaded = { session, runtime: ort, modelId, executionProvider, inputName, outputName };
  }
  return {
    loadMs: performance.now() - started,
    inputs: loaded.session.inputNames,
    outputs: loaded.session.outputNames,
    threads,
    modelId,
    modelBytes: model.bytes,
    cacheHit: cached.cacheHit,
    executionProvider,
  };
}

/**
 * Dari byte yang sudah disiapkan main thread, atau diambil sendiri.
 *
 * Fungsi ini berjalan di WORKER, dan di sana tidak ada host platform: app
 * mendaftarkan resolver host di modul platform miliknya, yang tidak pernah
 * dimuat worker (docs/25 §1d). Jadi worker tidak bertanya ke host sama
 * sekali — kalau host punya `modelBytes`, main thread sudah memanggilnya
 * ([`prefetchVocalModelBytes`]) dan byte-nya ada di `prepared`; kalau tidak,
 * jalur browser umum di bawah yang bekerja.
 */
async function loadModelBytes(
  model: VocalModelDefinition,
  onProgress: (progress: VocalModelDownloadProgress) => void,
  prepared: Uint8Array | undefined,
): Promise<ModelBytes> {
  if (prepared !== undefined) {
    assertVocalModelSize(model, prepared.byteLength);
    // Byte-nya sudah ada di tangan; dari sudut pandang worker ini cache hit.
    onProgress({ loaded: prepared.byteLength, total: model.bytes, cacheHit: true });
    return { bytes: prepared, cacheHit: true };
  }
  return fetchVocalModelBytesInBrowser(model, onProgress);
}

/**
 * Jalur browser umum: `fetch` langsung dari HuggingFace (mode `cors` bawaan;
 * HuggingFace mengirim `access-control-allow-origin` di kedua hop, jadi lolos
 * COEP `require-corp` — diverifikasi docs/26 §2 butir 3), cache di OPFS
 * dengan nama `model.fileName` supaya 64 MB tidak diunduh ulang tiap
 * kunjungan. Tanpa OPFS (Safari lama, konteks tertentu) jalurnya fetch
 * langsung ke memori — tetap jalan, hanya tidak diingat.
 *
 * Cache hit = ukuran berkas cocok dengan katalog; hash penuh dihitung sekali
 * saat unduh di desktop, bukan tiap kali model dimuat.
 */
export async function fetchVocalModelBytesInBrowser(
  model: VocalModelDefinition,
  onProgress: (progress: VocalModelDownloadProgress) => void,
): Promise<ModelBytes> {
  if (typeof navigator.storage?.getDirectory !== 'function') {
    const response = await fetchModel(model);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assertVocalModelSize(model, bytes.byteLength);
    onProgress({ loaded: bytes.byteLength, total: model.bytes, cacheHit: false });
    return { bytes, cacheHit: false };
  }

  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle('vocal-split-models', { create: true });
  const fileName = model.fileName;
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
    // Di dalam `try`, bukan sesudahnya (beda dari proof-stem): unduhan yang
    // selesai tapi terpotong tidak boleh tinggal di OPFS sebagai berkas
    // berukuran salah — ia dihapus lewat jalur `catch` yang sama.
    assertVocalModelSize(model, loaded);
  } catch (reason) {
    await writable.abort(reason).catch(() => {});
    await directory.removeEntry(fileName).catch(() => {});
    throw reason;
  }

  const file = await handle.getFile();
  return { bytes: new Uint8Array(await file.arrayBuffer()), cacheHit: false };
}

async function fetchModel(model: VocalModelDefinition): Promise<Response> {
  const response = await fetch(model.url);
  if (!response.ok) throw new Error(`Download ${model.label} gagal: HTTP ${response.status}`);
  return response;
}

/**
 * Satu langkah model untuk `separateMdx` (`MdxModel`): tensor
 * `[1, 4, dimF, frames]` masuk, tensor dengan layout yang sama keluar. Nama
 * tensor diambil dari sesi saat load (`input`/`output` pada Kim_Vocal_2).
 *
 * Tidak memuat model sendiri: worker WAJIB `init` dulu, karena hanya main
 * thread yang tahu dari mana byte-nya datang.
 */
export async function runVocalModel(input: Float32Array, dims: MdxDims): Promise<Float32Array> {
  if (loaded === null) throw new Error('Model vocal split belum dimuat: panggil loadVocalModel dulu');
  const { session, runtime, inputName, outputName } = loaded;
  const tensor = new runtime.Tensor('float32', input, [...dims]);
  try {
    const output = await session.run({ [inputName]: tensor });
    const result = output[outputName];
    if (result === undefined || !(result.data instanceof Float32Array)) {
      throw new Error(`Output ONNX \`${outputName}\` tidak ditemukan atau bukan Float32Array`);
    }
    return result.data;
  } finally {
    tensor.dispose();
  }
}

export function hasVocalModelSession(): boolean {
  return loaded !== null;
}

/** Lepas sesi ORT (memori WASM/GPU-nya ikut lepas). Aman dipanggil tanpa sesi. */
export async function disposeVocalModel(): Promise<void> {
  const current = loaded;
  loaded = null;
  if (current !== null) await current.session.release();
}
