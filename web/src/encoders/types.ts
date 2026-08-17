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
  /** MP3: kbps (mis. 192). OGG: quality -0.1..1.0. WAV: diabaikan. */
  quality?: number;
  /** WAV: kedalaman bit. */
  bitDepth?: 16 | 24 | 32;
}

export interface Encoder {
  readonly mime: string;
  readonly ext: string;
  init(opts: EncoderInitOptions): Promise<void>;
  /** Planar f32, panjang bebas. Mengembalikan chunk terenkode (boleh kosong). */
  encode(planar: Float32Array[]): Uint8Array;
  finish(): Uint8Array;
  /** Bagian header yang harus di-*patch* setelah selesai (khusus WAV). */
  finalHeader?(): Uint8Array | null;
}

export type EncoderFormat = 'wav' | 'mp3' | 'ogg';

/** Chunk kosong yang dipakai bersama — menghindari alokasi per panggilan. */
export const EMPTY = new Uint8Array(0);
