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

/** Ukuran satu page wasm. */
export const WASM_PAGE_BYTES = 65536;

/**
 * 4 GiB (65536 page) — plafon yang DIMINTA lebih dulu.
 *
 * Ini juga batas mutlak wasm32: linear memory dialamati pointer 32 bit, jadi
 * `--max-memory` di atas 4294967296 ditolak wasm-ld mentah-mentah. Tidak ada
 * konfigurasi yang membuat 8 atau 16 GiB mungkin; itu butuh memory64, target
 * yang berbeda dan belum stabil.
 */
export const MEMORY_MAXIMUM_PAGES = 65536;

/**
 * 2 GiB — dipakai kalau mesin menolak membuat shared memory 4 GiB.
 *
 * KENAPA HARUS ADA FALLBACK-NYA. Varian mt meng-IMPORT memory-nya, jadi objek
 * `WebAssembly.Memory` dibuat JS SEBELUM instantiate. Kalau pembuatannya
 * melempar, yang gagal bukan cuma export — seluruh engine tidak pernah hidup,
 * dan aplikasinya tidak boot sama sekali. Menaikkan plafon tanpa jaring
 * berarti menukar bug export yang bisa dihindari dengan halaman kosong.
 *
 * Yang membuat ini sah: import memory cocok selama `maximum` yang disediakan
 * TIDAK MELEBIHI yang dideklarasikan modul. Modulnya di-link di 4 GiB, jadi
 * memory 2 GiB tetap diterima instance yang sama. Tidak perlu artefak kedua.
 */
export const MEMORY_FALLBACK_PAGES = 32768;

/**
 * Buat linear memory sebesar yang disanggupi mesin.
 *
 * Plafonnya dikembalikan bersama objeknya, bukan diasumsikan dari konstanta:
 * yang dipakai penjaga export harus plafon YANG SUNGGUHAN didapat, dan setelah
 * fallback keduanya berbeda. Menebaknya 4 GiB padahal cuma dapat 2 GiB akan
 * meloloskan export yang pasti kehabisan memori di tengah jalan.
 */
export function createMemory(
  variant: WasmVariant,
  declaredMaximumPages?: number | null,
): {
  memory: WebAssembly.Memory;
  maximumBytes: number;
} {
  // `shared: true` hanya legal (dan hanya berguna) di varian mt. Di jalur
  // degraded memory-nya biasa: worklet tetap jalan, hanya tidak berbagi
  // linear memory dengan main thread.
  const shared = variant === 'mt';
  // Jangan pernah MEMINTA lebih dari yang dideklarasikan modul. Import memory
  // cocok kalau `maximum` yang disediakan tidak melebihi milik modul — jadi
  // meminta 4 GiB untuk artefak yang di-link 2 GiB bukan "ambil yang terbesar
  // lalu turun kalau gagal", melainkan instantiate yang PASTI gagal, dengan
  // "imported Memory with incompatible maximum size" dan tanpa sepatah kata
  // pun tentang artefak yang perlu dibangun ulang.
  const candidates = dedupe(
    [MEMORY_MAXIMUM_PAGES, MEMORY_FALLBACK_PAGES]
      .map((p) => Math.min(p, declaredMaximumPages ?? MEMORY_MAXIMUM_PAGES))
      .filter((p) => p > 0),
  );
  for (const pages of candidates) {
    try {
      const descriptor = { initial: MEMORY_INITIAL_PAGES, maximum: pages };
      const memory = new WebAssembly.Memory(shared ? { ...descriptor, shared } : descriptor);
      return { memory, maximumBytes: pages * WASM_PAGE_BYTES };
    } catch (e: unknown) {
      // Shared memory memesan ruang ALAMAT sebesar `maximum` di muka, jadi
      // penolakannya terjadi di sini — bukan nanti saat `grow`. Turun satu
      // tingkat dan coba lagi; kalau yang 2 GiB pun ditolak, itu bukan lagi
      // soal ukuran dan errornya harus naik apa adanya.
      if (pages === candidates[candidates.length - 1]) throw e;
      // eslint-disable-next-line no-console
      console.warn(
        `[wasm] linear memory ${pages / 16} GiB ditolak mesin, turun ke ` +
          `${MEMORY_FALLBACK_PAGES / 16} GiB. Project panjang akan lebih cepat ` +
          'menyentuh plafon saat export.',
        e,
      );
    }
  }
  // Tidak terjangkau: loop di atas selalu mengembalikan nilai atau melempar.
  throw new Error('linear memory tidak bisa dibuat');
}

const dedupe = (xs: number[]): number[] => xs.filter((x, i) => xs.indexOf(x) === i);

/**
 * Baca `maximum` dari import memory di dalam binary wasm.
 *
 * KENAPA MEMBACA BINARY-NYA SENDIRI. `WebAssembly.Module.imports()` menyebutkan
 * ada import bernama "memory" berjenis "memory", tapi TIDAK menyebutkan
 * limitnya — dan justru limit itulah satu-satunya angka yang menentukan
 * instantiate berhasil atau tidak. Tidak ada API lain yang mengeluarkannya,
 * jadi section import-nya diurai di sini. Byte-nya sudah ada di tangan
 * (`fetchWasmBytes`), jadi tidak ada request tambahan.
 *
 * `null` = tidak bisa ditentukan (bukan wasm, tidak ada import memory, atau
 * memory tanpa `maximum`). Pemanggil memperlakukannya sebagai "jangan
 * membatasi", bukan "nol" — tebakan yang salah di sini akan menurunkan plafon
 * untuk semua orang.
 */
export function declaredMemoryMaximumPages(bytes: ArrayBuffer | Uint8Array): number | null {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // \0asm + versi.
  if (b.length < 8 || b[0] !== 0x00 || b[1] !== 0x61 || b[2] !== 0x73 || b[3] !== 0x6d) return null;

  let at = 8;
  const u32 = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      const byte = b[at++];
      if (byte === undefined) throw new RangeError('wasm terpotong');
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result >>> 0;
      shift += 7;
      if (shift > 35) throw new RangeError('LEB128 terlalu panjang');
    }
  };
  /** Limits: flag, min, lalu max kalau bit 0 menyala. */
  const limitsMax = (): number | null => {
    const flags = u32();
    u32(); // minimum — tidak dipakai
    return (flags & 0x01) !== 0 ? u32() : null;
  };

  try {
    while (at < b.length) {
      const id = b[at++];
      const size = u32();
      const end = at + size;
      if (id !== 2) {
        // Bukan section import. Section id 0 (custom) dan lainnya dilewati
        // utuh — tidak perlu diurai untuk menjawab pertanyaan ini.
        at = end;
        continue;
      }
      const count = u32();
      for (let i = 0; i < count; i++) {
        // JANGAN `at += u32()`: JavaScript membaca nilai `at` SEBELUM
        // memanggil `u32()`, sedangkan `u32()` sendiri memajukan `at`. Hasilnya
        // penunjuk mundur beberapa byte dan seluruh section terurai jadi
        // sampah — tanpa melempar, cuma mengembalikan `null` seolah binary-nya
        // memang tidak punya import memory.
        const modLen = u32();
        at += modLen;
        const fieldLen = u32();
        at += fieldLen;
        const kind = b[at++];
        switch (kind) {
          case 0x00: // func
            u32();
            break;
          case 0x01: // table
            at++; // reftype
            limitsMax();
            break;
          case 0x02: // memory — yang dicari
            return limitsMax();
          case 0x03: // global
            at += 2; // valtype + mutability
            break;
          default:
            return null; // jenis import yang tidak dikenal: berhenti menebak
        }
      }
      // Section import selesai tanpa memory: varian st mengekspor memory-nya
      // sendiri, dan di sana tidak ada yang perlu dicocokkan.
      return null;
    }
  } catch {
    // Binary yang tidak bisa diurai bukan alasan menggagalkan boot: `null`
    // mengembalikan perilaku ke sebelum ada fungsi ini.
    return null;
  }
  return null;
}

/** Surface bindgen yang dipakai main thread & worker. */
export interface WasmBindgenExports {
  initSync(input: { module: WebAssembly.Module; memory?: WebAssembly.Memory }): unknown;
  initNonRealtime(): void;
  abiVersion(): number;
  allocControlBlock(): number;
  controlBlockSize(): number;
  buildHasAtomics(): boolean;
  /** Byte PCM asset yang saat ini terdaftar di linear memory. */
  assetBytesLive(): number;
  /** Puncak byte PCM asset yang pernah hidup bersamaan. */
  assetBytesPeak(): number;
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
  /**
   * Plafon linear memory yang BENAR-BENAR didapat (byte), sesudah fallback.
   * Dibawa di sini dan bukan dibaca ulang dari `memory`: `Memory.prototype.type()`
   * belum ada di semua mesin, dan menebaknya dari konstanta akan salah persis di
   * mesin yang tadi menolak 4 GiB.
   */
  readonly memoryMaximumBytes: number;
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

/**
 * `initSync`, tapi kegagalan yang berasal dari ketidakcocokan memory diberi
 * kalimat yang menyebut penyebabnya.
 *
 * Jaring terakhir. `declaredMemoryMaximumPages` sudah mencegah kasus yang kita
 * tahu, tapi ia bisa mengembalikan `null` (binary tidak terurai), dan yang
 * sampai ke user kalau begitu adalah "imported Memory with incompatible
 * maximum size" — kalimat yang benar secara teknis dan tidak berguna sama
 * sekali bagi orang yang cuma perlu membangun ulang artefaknya.
 */
function initSyncOrExplain(
  glue: WasmBindgenExports,
  module: WebAssembly.Module,
  memory: WebAssembly.Memory,
): { memory?: WebAssembly.Memory } | undefined {
  try {
    return glue.initSync({ module, memory }) as { memory?: WebAssembly.Memory } | undefined;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/incompatible|imported Memory|memory import/i.test(msg)) {
      throw new Error(
        `Artefak WASM tidak cocok dengan engine: ${msg}. Hampir selalu ini berarti ` +
          'artefak di `web/src/wasm/` lebih lama daripada kodenya — artefak itu ' +
          'tidak dilacak git, jadi `git pull` tidak membawanya. Jalankan ' +
          '`pnpm build:wasm`.',
      );
    }
    throw e;
  }
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

  // Plafon yang benar-benar dideklarasikan artefak ini — bukan yang kita
  // harapkan. Artefak WASM tidak dilacak git (`.gitignore` memuat
  // `/web/src/wasm/`), jadi `git pull` tidak pernah membawanya: sesudah plafon
  // naik ke 4 GiB, siapa pun yang belum menjalankan `pnpm build:wasm` masih
  // memegang artefak 2 GiB.
  const declaredPages = declaredMemoryMaximumPages(bytes);
  if (declaredPages !== null && declaredPages < MEMORY_MAXIMUM_PAGES) {
    // Bukan error: memintanya sesuai deklarasi membuat semuanya tetap jalan,
    // hanya dengan plafon yang lebih rendah. Tapi ini HARUS terdengar, karena
    // gejalanya nanti adalah export yang ditolak "kehabisan memori" di project
    // yang sebenarnya muat.
    console.warn(
      `[wasm] artefak ini di-link dengan plafon ${declaredPages / 16} GiB, ` +
        `sedangkan engine sekarang ${MEMORY_MAXIMUM_PAGES / 16} GiB — artefaknya ` +
        'lebih lama daripada kodenya. Jalankan `pnpm build:wasm` untuk mendapat ' +
        'plafon penuh.',
    );
  }

  const { memory, maximumBytes: memoryMaximumBytes } = createMemory(variant, declaredPages);

  // `initSync` mengembalikan `instance.exports`. Itu penting: HANYA varian mt
  // yang meng-IMPORT memory, jadi hanya di sana `memory` di atas benar-benar
  // dipakai. Varian st meng-EKSPOR memory-nya sendiri dan mengabaikan argumen
  // ini diam-diam — memakai objek `memory` buatan JS untuk membaca hasil render
  // berarti membaca memori yang tidak pernah disentuh engine: semua nol, tanpa
  // satu pun error. Gejalanya adalah file export yang senyap sempurna.
  const inst = initSyncOrExplain(glue, module, memory);
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

  return {
    module,
    memory: actualMemory,
    // Untuk `mt` ini plafon yang sungguhan dinegosiasikan. Untuk `st` modulnya
    // memakai memory-nya SENDIRI dan mengabaikan yang dibuat JS, jadi angka ini
    // jadi proksi: mesin yang menolak descriptor 4 GiB di atas juga tidak akan
    // menumbuhkan memory internalnya sejauh itu. Proksi yang meleset pun tetap
    // lebih baik dari tidak ada batas sama sekali — tanpa angka, satu-satunya
    // bentuk kegagalan yang tersisa adalah trap tanpa pesan.
    memoryMaximumBytes,
    variant,
    caps,
    exports: glue,
    controlPtr,
    raw,
    newThreadStack,
  };
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
