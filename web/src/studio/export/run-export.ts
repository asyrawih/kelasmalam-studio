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

import type { ExportAssetPcm, ExportPayload } from './payload';

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
  registerAsset(
    id: number,
    data: Float32Array,
    channels: number,
    frames: number,
    sampleRate: number,
  ): void;
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
}

export interface RunExportOptions {
  readonly payload: ExportPayload;
  readonly sampleRate: number;
  readonly engine: ExportEngine;
  readonly encoder: ExportEncoder;
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
  readonly blob: Blob;
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
  const { payload, engine, encoder, sampleRate } = opts;
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

  const parts: BlobPart[] = [];
  let frames = 0;
  try {
    // Asset didaftarkan SEBELUM batch pertama. Tanpa langkah ini setiap clip
    // menunjuk slot kosong dan engine merender senyap sempurna — tanpa error,
    // tanpa peringatan, hanya file kosong.
    for (const a of payload.assets) registerAsset(render, a);

    const header = encoder.header?.();
    if (header && header.length > 0) parts.push(header.slice() as BlobPart);

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
      // `slice()` menyalin KELUAR dari linear memory — buffer WASM tidak akan
      // valid lagi setelah grow berikutnya, dan Blob menyimpannya jauh lebih lama.
      if (bytes.length > 0) parts.push(bytes.slice() as BlobPart);

      frames += n;
      opts.onProgress?.(total > 0 ? Math.min(1, frames / total) : 1);

      await yieldFn();
    }

    const tail = await encoder.finish();
    if (tail.length > 0) parts.push(tail.slice() as BlobPart);

    // WAV: ukuran RIFF/data baru diketahui sekarang, jadi header placeholder di
    // part pertama diganti oleh yang final.
    const finalHeader = encoder.finalHeader?.();
    if (finalHeader && finalHeader.length > 0) {
      if (parts.length > 0 && header && header.length > 0) parts[0] = finalHeader.slice() as BlobPart;
      else parts.unshift(finalHeader.slice() as BlobPart);
    }
  } finally {
    render.free();
  }

  opts.onProgress?.(1);
  return { blob: new Blob(parts, { type: encoder.mime }), warnings, frames };
}

function registerAsset(render: RenderHandle, a: ExportAssetPcm): void {
  render.registerAsset(a.assetId, a.data, a.channels, a.frames, a.sampleRate);
}
