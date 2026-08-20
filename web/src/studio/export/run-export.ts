/**
 * LOOP EXPORT — render offline lewat engine Rust, lalu encode.
 *
 * Ini jalur yang dijanjikan docs/03: bounce memanggil `Engine::render_block`
 * YANG SAMA dengan playback. Tidak ada `OfflineAudioContext`, tidak ada graf
 * Web Audio kedua, jadi tidak ada cara bagi yang terdengar dan yang ter-export
 * untuk berbeda selain lewat pemetaan di `wasm-bridge/src/studio.rs` — dan
 * selisih di sana dilaporkan sebagai `warnings`, bukan didiamkan.
 *
 * Kenapa orkestrasinya di sini dan bukan langsung menyentuh modul WASM: jsdom
 * tidak bisa meng-instantiate modul kita, jadi loop-nya bicara HANYA lewat
 * [`ExportEngine`]. Tes memberi implementasi palsu dan menguji hal yang benar-
 * benar bisa salah — urutan panggilan, pengambilan ulang view setelah
 * `memory.grow`, progress, dan pembatalan — tanpa WASM sama sekali.
 */

import {
  PCM_CHUNK_FRAMES,
  type ExportAssetInfo,
  type ExportAssetSource,
  type ExportPayload,
} from './payload';
import type { ExportSink } from './sinks';

/** 100 blok × 128 frame ≈ 267 ms audio @48k (docs/03 §3a). */
export const BLOCKS_PER_BATCH = 100;

export interface SnapshotResult {
  readonly bytes: Uint8Array;
  /** Selisih nyata antara preview dan file. Kosong = identik. */
  readonly warnings: readonly string[];
  readonly clipCount: number;
}

export interface RenderHandle {
  totalFrames(): number;
  renderedFrames(): number;
  /** Frame yang dihasilkan; 0 = selesai. */
  render(blocks: number): number;
  outLPtr(): number;
  outRPtr(): number;
  /**
   * Sediakan tempat untuk PCM satu asset; kembalikan alamatnya di linear
   * memory. Pemanggil WAJIB mengisinya segera — lihat `fillAsset`.
   */
  beginAsset(id: number, channels: number, frames: number, sampleRate: number): number;
  free(): void;
}

/**
 * Segala yang dibutuhkan loop dari sisi WASM. Sengaja sekecil ini: makin sempit
 * antarmukanya, makin sedikit yang harus dipalsukan tes — dan makin kecil
 * peluang tes lulus untuk kode yang sebenarnya rusak.
 */
export interface ExportEngine {
  snapshot(json: string): SnapshotResult;
  createRender(
    snapshot: Uint8Array,
    sampleRate: number,
    startSample: number,
    endSample: number,
    blocksPerBatch: number,
  ): RenderHandle;
  /**
   * View f32 ke linear memory. WAJIB diambil ULANG setiap batch: `render` bisa
   * memicu `memory.grow`, dan view lama akan diam-diam berukuran 0 tanpa
   * melempar apa pun (docs/05).
   */
  view(ptr: number, len: number): Float32Array;
  /**
   * Sisa byte yang masih boleh ditumbuhkan linear memory sebelum plafonnya.
   * Opsional: engine palsu di tes tidak punya linear memory sama sekali, dan
   * `undefined` berarti "jangan periksa", bukan "tak terbatas".
   */
  memoryHeadroomBytes?(): number;
}

/** Encoder — bentuknya sama dengan `encoders/types.ts`. */
export interface ExportEncoder {
  readonly mime: string;
  init(opts: { sampleRate: number; channels: number; quality?: number; bitDepth?: 16 | 24 | 32 }): Promise<void>;
  encode(planar: Float32Array[]): Uint8Array;
  /** Boleh async — encoder Vorbis hanya bisa menyerahkan hasilnya lewat Blob. */
  finish(): Uint8Array | Promise<Uint8Array>;
  /** WAV: header final yang menggantikan placeholder. */
  finalHeader?(): Uint8Array | null;
  /** WAV: header placeholder yang ditulis lebih dulu. */
  header?(): Uint8Array;
  /**
   * Frame maksimum yang bisa dinyatakan format ini, `null` kalau tak terbatas.
   * Dicek SEBELUM render — lihat `assertFitsEncoderLimit`.
   */
  limitFrames?(): number | null;
}

export interface RunExportOptions {
  readonly payload: ExportPayload;
  readonly sampleRate: number;
  readonly engine: ExportEngine;
  readonly encoder: ExportEncoder;
  /**
   * Ke mana byte-nya pergi. WAJIB, dan sengaja tanpa default: default apa pun
   * di sini akan menumpuk seluruh file di memori, dan itu persis yang membuat
   * export panjang gagal sebelum lapisan ini ada (lihat `sinks.ts`).
   */
  readonly sink: ExportSink;
  /**
   * Sumber PCM, ditarik sepotong demi sepotong SESUDAH penjaga memori lolos.
   * Terpisah dari `payload` karena payload harus tetap bisa menyeberang
   * `postMessage`, dan fungsi tidak bisa di-structured-clone.
   */
  readonly pcm: ExportAssetSource;
  /** 0..1. Dipanggil sesudah tiap batch. */
  readonly onProgress?: (fraction01: number) => void;
  /** Selisih preview vs file, dilaporkan SEBELUM render mulai. */
  readonly onWarnings?: (warnings: readonly string[]) => void;
  /** Dicek SEKALI PER BATCH — telat ≤267 ms untuk membatalkan tidak masalah. */
  readonly isCancelled?: () => boolean;
  /** Beri napas ke event loop supaya UI dan tombol batal tetap hidup. */
  readonly yieldToEventLoop?: () => Promise<void>;
}

export interface ExportResult {
  readonly warnings: readonly string[];
  readonly frames: number;
}

/** Dilempar saat user membatalkan — dibedakan supaya UI tidak menampilkannya
 *  sebagai kegagalan. */
export class ExportCancelled extends Error {
  readonly cancelled = true;
  constructor() {
    super('Export dibatalkan.');
    this.name = 'ExportCancelled';
  }
}

/**
 * Yield lewat MessageChannel, BUKAN `setTimeout`: di tab background
 * `setTimeout` di-clamp ke ≥1000 ms dan export jadi 1000× lebih lambat
 * (docs/05 §tab throttling). `await Promise.resolve()` tidak cukup — microtask
 * tidak menjalankan message queue, jadi klik "batal" tidak akan pernah terbaca.
 */
export function defaultYield(): Promise<void> {
  if (typeof MessageChannel === 'undefined') return Promise.resolve();
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      resolve();
    };
    ch.port2.postMessage(0);
  });
}

export async function runExport(opts: RunExportOptions): Promise<ExportResult> {
  const { payload, engine, encoder, sampleRate, sink, pcm } = opts;
  const yieldFn = opts.yieldToEventLoop ?? defaultYield;

  const snap = engine.snapshot(payload.json);
  // Engine memutar asset apa adanya — ia tidak me-resample per blok (satu
  // sample rate untuk seluruh engine, docs/06). Asset di rate lain akan
  // berbunyi salah pitch, dan itu HARUS dikatakan, bukan didiamkan.
  const warnings = [
    ...snap.warnings,
    ...payload.assets
      .filter((a) => a.sampleRate !== sampleRate)
      .map(
        (a) =>
          `Asset ${a.assetId} ber-sample-rate ${a.sampleRate} Hz, project ${sampleRate} Hz — ` +
          'pitch-nya di file akan berbeda dari preview.',
      ),
  ];
  if (warnings.length > 0) opts.onWarnings?.(warnings);

  // Sebelum apa pun dialokasi: kalau PCM-nya tidak akan muat, gagal SEKARANG
  // dengan kalimat yang bisa ditindaklanjuti — bukan nanti sebagai trap wasm di
  // tengah `beginAsset`, dengan `OfflineRender` yang sudah terlanjur berdiri.
  assertPcmFitsInMemory(payload.assets, engine);
  // Dan sebelum render berjam-jam dimulai: apakah formatnya SANGGUP menyatakan
  // panjang sepanjang itu. Menemukannya di byte terakhir berarti membuang
  // seluruh waktu render.
  assertFitsEncoderLimit(encoder, payload.endSample, sampleRate);

  const render = engine.createRender(
    snap.bytes,
    sampleRate,
    0,
    payload.endSample,
    BLOCKS_PER_BATCH,
  );

  // Clip ada tapi PCM tidak dikirim = jaminan file senyap. Engine tidak bisa
  // mendeteksinya sendiri: clip yang menunjuk slot asset kosong itu sah, dan
  // hasilnya nol — tanpa error, tanpa peringatan. Kegagalan paling buruk
  // adalah yang menghasilkan file yang terlihat normal, jadi ini dihentikan
  // di sini, bukan dibiarkan sampai user memutar hasilnya.
  if (snap.clipCount > 0 && payload.assets.length === 0) {
    throw new Error(
      `Export dibatalkan: ${snap.clipCount} clip akan dirender tapi tidak ada PCM ` +
        'yang dikirim ke engine. Hasilnya pasti senyap.',
    );
  }

  let frames = 0;
  /** Error asli dari badan `try`, supaya `finally` tidak menimpanya. */
  let failure: unknown = null;
  try {
    // Asset didaftarkan SEBELUM batch pertama. Tanpa langkah ini setiap clip
    // menunjuk slot kosong dan engine merender senyap sempurna — tanpa error,
    // tanpa peringatan, hanya file kosong.
    //
    // Satu per satu, dan PCM-nya baru diminta di sini: tidak pernah ada lebih
    // dari satu asset yang dipegang di luar linear memory.
    for (const info of payload.assets) await fillAsset(engine, render, info, pcm);

    const header = encoder.header?.();
    if (header && header.length > 0) await sink.header(header);

    const total = render.totalFrames();
    for (;;) {
      if (opts.isCancelled?.()) throw new ExportCancelled();

      const n = render.render(BLOCKS_PER_BATCH);
      if (n === 0) break;

      // Pointer DAN view diambil ulang tiap batch: render bisa memicu
      // memory.grow dan view lama jadi berukuran 0 tanpa exception (docs/05).
      const l = engine.view(render.outLPtr(), n);
      const r = engine.view(render.outRPtr(), n);

      const bytes = encoder.encode([l, r]);
      // Tidak ada `slice()` di sini. Glue wasm-bindgen SUDAH menyalin keluar
      // dari linear memory saat mengembalikan `Vec<u8>` (lihat
      // `getArrayU8FromWasm0(...).slice()` di web/src/wasm/mt/engine.js), jadi
      // salinan kedua hanya menggandakan puncak memori tiap chunk 4 MiB —
      // dan mencegah buffer-nya di-transfer utuh ke main thread.
      if (bytes.length > 0) await sink.chunk(bytes);

      frames += n;
      opts.onProgress?.(total > 0 ? Math.min(1, frames / total) : 1);

      await yieldFn();
    }

    const tail = await encoder.finish();
    if (tail.length > 0) await sink.chunk(tail);

    // WAV: ukuran RIFF/data baru diketahui sekarang, jadi header placeholder di
    // depan file ditimpa oleh yang final.
    const finalHeader = encoder.finalHeader?.();
    if (finalHeader && finalHeader.length > 0) await sink.patchHeader(finalHeader);

    await sink.close();
  } catch (e: unknown) {
    failure = e;
    // Sink DULU, baru lempar: kalau tidak, jalur File System Access
    // meninggalkan berkas separuh jadi di disk yang terlihat seperti export
    // yang berhasil. `abort()` sengaja tidak boleh melempar sendiri.
    await sink.abort(e);
    throw e;
  } finally {
    // `free()` di sini BISA melempar sendiri, dan kalau dibiarkan ia akan
    // MENIMPA penyebab sebenarnya. Persis itu yang terjadi saat render kehabisan
    // memori: `panic_immediate_abort` memutus method `&mut self` di tengah jalan
    // tanpa menjalankan destruktor, jadi flag borrow wasm-bindgen tertinggal
    // aktif, dan `free()` berikutnya melempar
    //
    //     attempted to take ownership of Rust value while it was borrowed
    //
    // — kalimat yang tidak menyebut-nyebut memori sama sekali, menggantikan
    // `RuntimeError: unreachable executed` yang setidaknya menunjuk ke tempat
    // yang benar. Yang asli menang; yang ini turun ke console.
    try {
      render.free();
    } catch (freeError: unknown) {
      if (failure === null) throw freeError;
      console.error(
        '[export] render.free() ikut gagal setelah error di atas (biasanya efek ' +
          'lanjutan, bukan penyebab):',
        freeError,
      );
    }
  }

  opts.onProgress?.(1);
  return { warnings, frames };
}

/**
 * Tolak SEBELUM render kalau formatnya tidak bisa menyatakan panjang segitu.
 *
 * WAV klasik menyimpan ukuran RIFF dan ukuran data di field 32-bit, jadi
 * batasnya ~4 GiB — sekitar 4,1 jam untuk stereo 24-bit @48k, dan hanya 3,1 jam
 * untuk float 32-bit. Angka batasnya datang dari `WavStreamWriter::max_frames()`
 * di Rust, bukan dihitung ulang di sini.
 *
 * Sebelum ini tidak ada cek sama sekali DAN tidak ada error: header ditulis
 * dengan `saturating_add`, jadi file di atas batas tetap selesai dengan panjang
 * yang dijepit. Yang didapat user adalah berkas berukuran benar yang berhenti
 * di tengah saat diputar — kegagalan yang baru ketahuan setelah semuanya
 * terlihat berhasil.
 */
function assertFitsEncoderLimit(
  encoder: ExportEncoder,
  frames: number,
  sampleRate: number,
): void {
  const limit = encoder.limitFrames?.();
  if (limit === undefined || limit === null || !Number.isFinite(limit)) return;
  if (frames <= limit) return;

  const hours = (n: number): string => (n / Math.max(1, sampleRate) / 3600).toFixed(1);
  throw new Error(
    `Export ${hours(frames)} jam terlalu panjang untuk format ini: batasnya ` +
      `${hours(limit)} jam (ukuran berkas WAV disimpan dalam field 32-bit, ~4 GiB). ` +
      'Yang bisa dilakukan: pilih FLAC, turunkan bit depth, atau persempit rentang waktunya.',
  );
}

/**
 * Salin PCM satu asset ke linear memory, SEPOTONG demi sepotong.
 *
 * Satu-satunya salinan di jalur ini. Sebelumnya ada dua: `flattenBuffer` di JS,
 * lalu glue wasm-bindgen menyalin lagi ke linear memory — dan yang pertama
 * dibuat untuk semua asset sekaligus lalu ditahan sampai export selesai.
 *
 * Berpotongan, bukan sekali per channel, supaya sumber yang harus MENYALIN
 * (lintas `postMessage`, atau `copyFromChannel`) tidak perlu membuat satu asset
 * penuh berwujud di heap JS — lihat [`ExportAssetSource`].
 */
async function fillAsset(
  engine: ExportEngine,
  render: RenderHandle,
  info: ExportAssetInfo,
  pcm: ExportAssetSource,
): Promise<void> {
  // Alamat DULU: alokasinya bisa memicu memory.grow, dan view apa pun yang
  // diambil sebelum itu akan berukuran nol tanpa melempar (docs/05).
  const ptr = render.beginAsset(info.assetId, info.channels, info.frames, info.sampleRate);
  const len = info.channels * info.frames;
  for (let c = 0; c < info.channels; c++) {
    let at = 0;
    while (at < info.frames) {
      const src = await pcm({
        asset: info,
        channel: c,
        offset: at,
        maxFrames: Math.min(PCM_CHUNK_FRAMES, info.frames - at),
      });
      // Sumber yang kehabisan lebih dulu menyisakan nol di ekornya, dan itu
      // senyap — bukan sampah. Berhenti, jangan berputar selamanya.
      if (src.length === 0) break;
      // View diambil ULANG tiap potong. `pcm` boleh async, dan setiap `await`
      // memberi giliran ke kode lain yang bisa menumbuhkan linear memory —
      // yang membuat view lama berukuran nol TANPA melempar apa pun (docs/05).
      // Menyimpannya di luar loop berarti sisa potongannya diam-diam hilang.
      const dst = engine.view(ptr, len);
      const n = Math.min(src.length, info.frames - at);
      dst.set(n === src.length ? src : src.subarray(0, n), c * info.frames + at);
      at += n;
    }
  }
}

const MIB = 1024 * 1024;

/**
 * Tolak DULU export yang PCM-nya tidak muat di linear memory.
 *
 * Tanpa ini kegagalannya bukan exception melainkan trap: `beginAsset`
 * meminta blok sebesar seluruh PCM satu lane, `memory.grow` menolak, dan
 * `handle_alloc_error` di wasm memanggil `abort()` — bukan lewat mesin panic,
 * jadi `console_error_panic_hook` pun tidak kebagian. Yang sampai ke user
 * adalah `RuntimeError: unreachable executed`, tanpa satu kata pun tentang
 * memori atau tentang apa yang harus ia lakukan.
 *
 * Skalanya nyata, bukan teoretis: satu lane 28 menit stereo @48k = 610 MiB, dan
 * plafonnya (2 atau 4 GiB, hasil negosiasi di `wasm-loader.ts`) berlaku untuk
 * SELURUH engine, bukan per asset.
 */
function assertPcmFitsInMemory(
  assets: readonly ExportAssetInfo[],
  engine: ExportEngine,
): void {
  const headroom = engine.memoryHeadroomBytes?.();
  if (headroom === undefined) return;

  // Satu salinan per asset: `beginAsset` mengalokasi di linear memory dan JS
  // menyalin channel-nya langsung ke sana (lihat `fillAsset`).
  const need = assets.reduce((sum, a) => sum + a.channels * a.frames * 4, 0);
  if (need <= headroom) return;

  const mib = (bytes: number): string => Math.ceil(bytes / MIB).toLocaleString('id-ID');
  const longest = assets.reduce(
    (best, a) => (a.frames > best.frames ? a : best),
    assets[0] as ExportAssetInfo,
  );
  const minutes = (a: ExportAssetInfo): string =>
    (a.frames / Math.max(1, a.sampleRate) / 60).toFixed(1);

  throw new Error(
    `Project terlalu besar untuk di-render dalam satu jalan: PCM-nya butuh ` +
      `${mib(need)} MiB, sisa linear memory engine ${mib(headroom)} MiB ` +
      `(seluruh audio harus ada di sana selama render). ` +
      `${assets.length} asset, terpanjang ${minutes(longest)} menit × ` +
      `${longest.channels} channel. Yang bisa dilakukan: export per-lane lalu ` +
      `gabungkan, persempit rentang waktunya, atau jadikan asset panjang mono.`,
  );
}
