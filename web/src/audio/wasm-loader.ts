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
import { allocThreadStack, type StackCapableExports, type ThreadStack } from './thread-stack';
import { WASM_URLS } from './wasm-urls';
import { SAB_SIZE } from './sab-layout';

/** Harus sama dengan `daw_wasm::ABI_VERSION`. */
export const EXPECTED_ABI_VERSION = 1;

/** 16 MiB awal: engine + scratch. Growth hanya terjadi saat import asset. */
const MEMORY_INITIAL_PAGES = 256;
/**
 * 2 GiB batas atas (32768 × 64 KiB). Tidak dialokasi di awal.
 *
 * HARUS sama dengan `--max-memory=2147483648` di `.cargo/config.toml` dan
 * `scripts/build-wasm.sh`: shared memory wajib punya maximum, dan kalau JS
 * meminta angka yang berbeda dari yang di-link, instantiate ditolak.
 *
 * Diekspor karena plafon ini PUNYA konsekuensi yang harus dijelaskan ke user,
 * bukan cuma parameter build: seluruh PCM project ada di linear memory selama
 * export, jadi ini yang menentukan berapa lama project masih bisa di-bounce.
 * Lihat `memoryHeadroomBytes` di `studio/export/wasm-engine.ts`.
 */
export const MEMORY_MAXIMUM_PAGES = 32768;

/** Ukuran satu page wasm. */
export const WASM_PAGE_BYTES = 65536;

/** Plafon linear memory dalam byte — bentuk yang dipakai penjaga export. */
export const MEMORY_MAXIMUM_BYTES = MEMORY_MAXIMUM_PAGES * WASM_PAGE_BYTES;

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
  /**
   * Model studio (JSON) → snapshot postcard. Pemetaannya ada di Rust karena
   * tata letak postcard ditentukan definisi tipe Rust — menuliskannya dari TS
   * berarti menyalinnya dengan tangan dan merusaknya diam-diam saat tipe
   * Rust-nya berubah.
   */
  snapshotFromStudioJson(json: string): StudioSnapshotHandle;
  /** Katalog efek sebagai JSON — sumber tunggal knob di panel FX. */
  fxCatalogJson(): string;
  /** Peta slot blok parameter, dibandingkan CI dengan `param-map.ts`. */
  paramMapJson(): string;
  OfflineRender: OfflineRenderCtor;
  WavEncoderHandle: WavEncoderCtor;
  WavBits: { Pcm16: number; Pcm24: number; Float32: number };
  FlacEncoderHandle: FlacEncoderCtor;
  FlacBitsJs: { Pcm16: number; Pcm24: number };
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
  /**
   * Daftarkan PCM satu asset SEBELUM `render()` pertama. Snapshot hanya
   * menyebut asset lewat id; tanpa ini setiap clip menunjuk slot kosong dan
   * hasil render senyap sempurna — tanpa error.
   *
   * `data` planar: channel `c` mulai di `c * frames`. Disalin di sisi Rust.
   */
  registerAsset(
    id: number,
    data: Float32Array,
    channels: number,
    frames: number,
    sampleRate: number,
  ): void;
  free(): void;
}

/** Snapshot postcard hasil pemetaan model studio (`crates/wasm-bridge/src/studio.rs`). */
export interface StudioSnapshotHandle {
  bytes(): Uint8Array;
  /** Selisih preview vs file yang WAJIB ditampilkan. Kosong = identik. */
  warnings(): string[];
  clipCount(): number;
  free(): void;
}

export interface WavEncoderCtor {
  new (sampleRate: number, channels: number, bits: number, ditherSeed: number): WavEncoderHandleT;
}

export interface WavEncoderHandleT {
  header(): Uint8Array;
  /** Frame maksimum yang muat di header RIFF untuk spec ini (batas 4 GiB). */
  maxFrames(): number;
  encode(l: Float32Array, r: Float32Array): Uint8Array;
  /** Sisa chunk terakhir. */
  flush(): Uint8Array;
  /** Header final dengan ukuran RIFF/data yang benar. */
  patchHeader(): Uint8Array;
  free(): void;
}

/**
 * Encoder FLAC di Rust. Bentuknya SENGAJA sama dengan `WavEncoderCtor`: satu
 * loop export, banyak encoder — begitu bentuknya berbeda, `run-export.ts` akan
 * butuh cabang per format dan "satu jalur render" berhenti berlaku.
 *
 * Bedanya cuma satu: setiap method bisa MELEMPAR (flacenc mengembalikan
 * `Result`), sementara WAV tidak pernah gagal.
 */
export interface FlacEncoderCtor {
  new (sampleRate: number, channels: number, bits: number, ditherSeed: number): FlacEncoderHandleT;
}

export interface FlacEncoderHandleT {
  header(): Uint8Array;
  encode(l: Float32Array, r: Float32Array): Uint8Array;
  flush(): Uint8Array;
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
  /**
   * Export MENTAH instance main thread (`instance.exports`), bukan namespace
   * glue-nya. Dibutuhkan untuk `scratch_alloc` dan `__stack_pointer` —
   * keduanya tidak pernah muncul di surface bindgen.
   */
  readonly raw: StackCapableExports;
  /**
   * Alokasikan stack privat untuk satu thread baru. **Hanya di jalur `mt`**:
   * di `st` tiap instance punya memory sendiri sehingga stack-nya tidak pernah
   * bertemu, dan fungsinya mengembalikan `null`.
   *
   * Dipanggil dari MAIN THREAD sebelum thread tujuan menjalankan wasm apa pun —
   * lihat `thread-stack.ts` untuk alasan urutannya.
   */
  newThreadStack(): ThreadStack | null;
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
  // URL dari tabel literal statis — JANGAN dibangun dengan template literal
  // di sini; Vite tidak bisa menyelesaikannya dan diam-diam mengarahkannya ke
  // direktori yang salah. Lihat wasm-urls.ts.
  const { glue: glueUrl, wasm: wasmUrl } = WASM_URLS[variant];

  // PENTING: artefak diperiksa DULU, sebelum `import()` glue-nya.
  //
  // Kalau `web/src/wasm/` masih kosong, dev-server Vite menjawab request ke
  // `engine.js` dengan SPA fallback — yaitu index.html ber-MIME text/html.
  // Browser lalu menolaknya dengan "Loading module was blocked because of a
  // disallowed MIME type", sebuah pesan yang menyesatkan: seolah ada masalah
  // konfigurasi server, padahal file-nya memang belum dibangun.
  // Memeriksa binary-nya lebih dulu membuat kegagalannya jujur dan bisa
  // ditangani UI (tombol di-disable + tooltip), bukan error merah di console.
  const bytes = await fetchWasmBytes(wasmUrl);
  const glue = (await import(/* @vite-ignore */ glueUrl)) as WasmBindgenExports;

  const module = await WebAssembly.compile(bytes);

  // `shared: true` hanya legal (dan hanya berguna) di varian mt. Di jalur
  // degraded memory-nya biasa: worklet tetap jalan, hanya tidak berbagi
  // linear memory dengan main thread.
  const memory = new WebAssembly.Memory(
    variant === 'mt'
      ? { initial: MEMORY_INITIAL_PAGES, maximum: MEMORY_MAXIMUM_PAGES, shared: true }
      : { initial: MEMORY_INITIAL_PAGES, maximum: MEMORY_MAXIMUM_PAGES },
  );

  // `initSync` mengembalikan `instance.exports`. Itu penting: HANYA varian mt
  // yang meng-IMPORT memory, jadi hanya di sana `memory` di atas benar-benar
  // dipakai. Varian st meng-EKSPOR memory-nya sendiri dan mengabaikan argumen
  // ini diam-diam — memakai objek `memory` buatan JS untuk membaca hasil render
  // berarti membaca memori yang tidak pernah disentuh engine: semua nol, tanpa
  // satu pun error. Gejalanya adalah file export yang senyap sempurna.
  const inst = glue.initSync({ module, memory }) as { memory?: WebAssembly.Memory } | undefined;
  const actualMemory = inst?.memory ?? memory;
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

  const raw = (inst ?? {}) as StackCapableExports;
  // Varian st: memory per instance, jadi tidak ada stack yang bertabrakan dan
  // tidak ada yang perlu dialokasi. Menyediakannya di sana hanya akan membuang
  // 1 MiB per worker untuk masalah yang tidak ada.
  const newThreadStack = (): ThreadStack | null =>
    variant === 'mt' ? allocThreadStack(raw) : null;

  if (variant === 'mt' && raw.__stack_pointer === undefined) {
    // Bukan error: artefak lama tetap jalan. Tapi ini HARUS terdengar, karena
    // tanpa `__stack_pointer` setiap thread berbagi rentang stack yang sama dan
    // kerusakannya muncul di tempat lain sebagai panic yang tidak masuk akal.
    console.warn(
      '[wasm] artefak mt tanpa export __stack_pointer: semua thread akan berbagi ' +
        'rentang stack yang sama dan bisa saling menimpa. Bangun ulang dengan ' +
        'scripts/build-wasm.sh terbaru.',
    );
  }

  return { module, memory: actualMemory, variant, caps, exports: glue, controlPtr, raw, newThreadStack };
}

/** Ditandai supaya UI bisa membedakan "belum dibangun" dari error sungguhan. */
export class EngineNotBuiltError extends Error {
  readonly notBuilt = true;
  constructor(detail: string) {
    super(`Engine WASM belum dibangun (${detail}). Jalankan \`pnpm build:wasm\`.`);
    this.name = 'EngineNotBuiltError';
  }
}

async function fetchWasmBytes(url: string): Promise<ArrayBuffer> {
  let res: Response;
  try {
    // `cache: 'no-store'`: sebelum artefak dibangun, dev-server menjawab URL ini
    // dengan SPA fallback (HTML, status 200) — dan respons itu bisa mengendap di
    // cache HTTP. Setelah artefak ada, browser masih menyajikan HTML basi dan
    // engine terlihat "tidak pernah dibangun" padahal file-nya sudah ada.
    res = await fetch(url, { cache: 'no-store' });
  } catch (err) {
    throw new EngineNotBuiltError(err instanceof Error ? err.message : 'fetch gagal');
  }
  if (!res.ok) {
    throw new EngineNotBuiltError(`${url} → HTTP ${res.status}`);
  }
  // Dev-server mengembalikan index.html (200, text/html) untuk file yang tidak
  // ada — jadi status 200 saja BUKAN bukti artefaknya ada.
  const type = res.headers.get('content-type') ?? '';
  if (!type.includes('wasm') && !type.includes('octet-stream')) {
    throw new EngineNotBuiltError(`${url} mengembalikan "${type}", bukan wasm`);
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
