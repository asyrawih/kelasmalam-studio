/**
 * Loader WASM — dijalankan SEKALI di main thread.
 *
 * Tanggung jawabnya (docs/01 §1a + docs/05 §memory growth):
 *   1. pilih varian artefak (`mt` / `st`) berdasarkan `caps.ts`,
 *   2. `WebAssembly.compile()` SEKALI — mahal (~10–50 ms untuk 300 KB);
 *      instantiate berikutnya di worklet/worker <1 ms,
 *   3. buat `WebAssembly.Memory` dengan `initial`/`maximum` (untuk shared,
 *      `maximum` WAJIB; reservasi ruang alamat itu virtual, murah),
 *   4. instantiate satu instance main-thread (surface bindgen) untuk
 *      snapshot/import/alloc blok kontrol,
 *   5. mengekspos `{ module, memory }` untuk diserahkan ke worklet & worker.
 *
 * `WebAssembly.Module` structured-cloneable → boleh lewat `postMessage` /
 * `processorOptions`. `Instance` TIDAK.
 */

import { detectCaps, type Caps, type WasmVariant } from './caps';
import { SAB_SIZE } from './sab-layout';

/** Harus sama dengan `daw_wasm::ABI_VERSION`. */
export const EXPECTED_ABI_VERSION = 1;

/** 16 MiB awal: engine + scratch. Growth hanya terjadi saat import asset. */
const MEMORY_INITIAL_PAGES = 256;
/** 2 GiB batas atas (32768 × 64 KiB). Tidak dialokasi di awal. */
const MEMORY_MAXIMUM_PAGES = 32768;

/** Surface bindgen yang dipakai main thread & worker. */
export interface WasmBindgenExports {
  initSync(input: { module: WebAssembly.Module; memory?: WebAssembly.Memory }): unknown;
  initNonRealtime(): void;
  abiVersion(): number;
  allocControlBlock(): number;
  controlBlockSize(): number;
  buildHasAtomics(): boolean;
  buildHasSimd(): boolean;
  importFromPcm(
    data: Float32Array,
    channels: number,
    frames: number,
    sampleRate: number,
    targetRate: number,
    peakBucket: number,
  ): ImportedAssetHandle;
  OfflineRender: OfflineRenderCtor;
  WavEncoderHandle: WavEncoderCtor;
  WavBits: { Pcm16: number; Pcm24: number; Float32: number };
}

export interface ImportedAssetHandle {
  sampleRate(): number;
  frames(): number;
  channels(): number;
  channelPtr(ch: number): number;
  peaksPtr(): number;
  peaksLen(): number;
  peakBucket(): number;
  free(): void;
}

export interface OfflineRenderCtor {
  new (
    snapshot: Uint8Array,
    sampleRate: number,
    start: number,
    end: number,
    blocksPerBatch: number,
  ): OfflineRenderHandle;
}

export interface OfflineRenderHandle {
  totalFrames(): number;
  renderedFrames(): number;
  render(blocks: number): number;
  outLPtr(): number;
  outRPtr(): number;
  outCapacity(): number;
  free(): void;
}

export interface WavEncoderCtor {
  new (sampleRate: number, channels: number, bits: number, ditherSeed: number): WavEncoderHandleT;
}

export interface WavEncoderHandleT {
  header(): Uint8Array;
  encode(l: Float32Array, r: Float32Array): Uint8Array;
  /** Sisa chunk terakhir. */
  flush(): Uint8Array;
  /** Header final dengan ukuran RIFF/data yang benar. */
  patchHeader(): Uint8Array;
  free(): void;
}

/** Hasil load — semuanya cloneable kecuali `exports`. */
export interface LoadedWasm {
  readonly module: WebAssembly.Module;
  readonly memory: WebAssembly.Memory;
  readonly variant: WasmVariant;
  readonly caps: Caps;
  /** Instance main thread (surface bindgen). */
  readonly exports: WasmBindgenExports;
  /** Offset blok kontrol di dalam linear memory. */
  readonly controlPtr: number;
}

let loading: Promise<LoadedWasm> | null = null;

/** Load idempoten — panggil sesering yang perlu, kompilasi tetap sekali. */
export function loadWasm(): Promise<LoadedWasm> {
  loading ??= doLoad();
  return loading;
}

async function doLoad(): Promise<LoadedWasm> {
  const caps = await detectCaps();
  const variant = caps.variant;

  // URL dibangun runtime, bukan static import: artefak baru ada setelah
  // `pnpm build:wasm`, dan kita tidak mau typecheck/dev-server gagal hanya
  // karena artefak belum dibangun.
  const base = new URL(`../wasm/${variant}/`, import.meta.url);
  const glueUrl = new URL('engine.js', base).href;
  const wasmUrl = new URL('engine_bg.wasm', base).href;

  const [glue, bytes] = await Promise.all([
    import(/* @vite-ignore */ glueUrl) as Promise<WasmBindgenExports>,
    fetchWasmBytes(wasmUrl),
  ]);

  const module = await WebAssembly.compile(bytes);

  // `shared: true` hanya legal (dan hanya berguna) di varian mt. Di jalur
  // degraded memory-nya biasa: worklet tetap jalan, hanya tidak berbagi
  // linear memory dengan main thread.
  const memory = new WebAssembly.Memory(
    variant === 'mt'
      ? { initial: MEMORY_INITIAL_PAGES, maximum: MEMORY_MAXIMUM_PAGES, shared: true }
      : { initial: MEMORY_INITIAL_PAGES, maximum: MEMORY_MAXIMUM_PAGES },
  );

  glue.initSync({ module, memory });
  glue.initNonRealtime();

  const abi = glue.abiVersion();
  if (abi !== EXPECTED_ABI_VERSION) {
    throw new Error(
      `ABI WASM tidak cocok: artefak=${abi}, JS mengharapkan ${EXPECTED_ABI_VERSION}. ` +
        'Jalankan `pnpm build:wasm` (atau hapus cache service worker).',
    );
  }
  if (variant === 'mt' && !glue.buildHasAtomics()) {
    throw new Error('Varian mt terpilih tapi artefak dibangun tanpa +atomics.');
  }
  if (glue.controlBlockSize() !== SAB_SIZE) {
    throw new Error(
      `Ukuran blok kontrol beda: Rust=${glue.controlBlockSize()}, TS=${SAB_SIZE}. ` +
        'Sinkronkan sab-layout.ts dengan crates/rt/src/layout.rs.',
    );
  }

  const controlPtr = glue.allocControlBlock();

  return { module, memory, variant, caps, exports: glue, controlPtr };
}

async function fetchWasmBytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Gagal memuat ${url} (${res.status}). Sudah menjalankan \`pnpm build:wasm\`?`,
    );
  }
  return res.arrayBuffer();
}

/**
 * View SELALU diambil ulang dari `memory.buffer` — jangan pernah di-cache.
 * `memory.grow` men-detach ArrayBuffer lama: view lama jadi `byteLength 0`
 * TANPA exception, dan kode yang membacanya diam-diam membaca nol (docs/05).
 * Biaya pembuatan view ~50 ns, tidak layak dioptimasi.
 */
export function f32View(memory: WebAssembly.Memory, ptr: number, len: number): Float32Array {
  return new Float32Array(memory.buffer, ptr, len);
}

export function u8View(memory: WebAssembly.Memory, ptr: number, len: number): Uint8Array {
  return new Uint8Array(memory.buffer, ptr, len);
}

/** Int32Array atas blok kontrol — dipakai untuk semua operasi `Atomics`. */
export function controlI32(memory: WebAssembly.Memory, controlPtr: number): Int32Array {
  return new Int32Array(memory.buffer, controlPtr, SAB_SIZE / 4);
}

export function controlF32(memory: WebAssembly.Memory, controlPtr: number): Float32Array {
  return new Float32Array(memory.buffer, controlPtr, SAB_SIZE / 4);
}
