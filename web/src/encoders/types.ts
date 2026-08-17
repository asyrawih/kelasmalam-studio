/**
 * Antarmuka encoder — docs/03 §3c.
 *
 * Seluruh pipeline export hanya bicara lewat interface ini. Itulah yang membuat
 * "jalur B" (lamejs / ogg-vorbis-encoder-js) bisa ditukar ke "jalur A" (sidecar
 * emcc LAME+libvorbis) nanti **tanpa mengubah arsitektur** — hanya implementasi
 * yang diganti.
 */

export interface EncoderInitOptions {
  sampleRate: number;
  channels: number;
  /** MP3: kbps (mis. 192). OGG: quality -0.1..1.0. WAV/FLAC: diabaikan. */
  quality?: number;
  /** WAV: 16/24/32. FLAC: 16/24 saja — formatnya memang tidak punya float. */
  bitDepth?: 16 | 24 | 32;
}

export interface Encoder {
  readonly mime: string;
  readonly ext: string;
  init(opts: EncoderInitOptions): Promise<void>;
  /** Planar f32, panjang bebas. Mengembalikan chunk terenkode (boleh kosong). */
  encode(planar: Float32Array[]): Uint8Array;
  /**
   * Boleh async. Bukan kemewahan: encoder Vorbis membangun Blob dan Blob hanya
   * bisa dibaca lewat Promise. Waktu `finish()` masih sinkron, jalur OGG
   * mengembalikan array kosong dan menghasilkan file 0 byte tanpa satu pun
   * error — persis jenis kegagalan yang paling mahal.
   */
  finish(): Uint8Array | Promise<Uint8Array>;
  /** Bagian header yang harus di-*patch* setelah selesai (khusus WAV). */
  finalHeader?(): Uint8Array | null;
}

export type EncoderFormat = 'wav' | 'flac' | 'mp3' | 'ogg';

/** Chunk kosong yang dipakai bersama — menghindari alokasi per panggilan. */
export const EMPTY = new Uint8Array(0);
