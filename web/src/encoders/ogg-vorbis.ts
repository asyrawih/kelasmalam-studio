/**
 * OGG Vorbis via **ogg-vorbis-encoder-js** (libvorbis dikompilasi dengan emcc,
 * ~350 KB gz). Lazy-load: hanya diunduh kalau user memilih OGG (docs/03 §3c).
 *
 * Tidak ada encoder Vorbis pure-Rust yang layak produksi — `lewton` decoder
 * saja, crate `ogg` container saja. libvorbis berlisensi BSD-like, jadi tidak
 * ada kewajiban seperti LAME (LGPL).
 *
 * API paketnya menerima planar Float32Array langsung dan menghasilkan Blob di
 * akhir; kita membungkusnya ke antarmuka `Encoder` yang berbasis chunk.
 */

import { EMPTY, type Encoder, type EncoderInitOptions } from './types';

interface VorbisEncoderInstance {
  encode(buffers: Float32Array[]): void;
  finish(): Blob;
}
interface VorbisModule {
  new (sampleRate: number, channels: number, quality: number): VorbisEncoderInstance;
}

export class OggVorbisEncoder implements Encoder {
  readonly mime = 'audio/ogg';
  readonly ext = 'ogg';

  private enc: VorbisEncoderInstance | null = null;

  async init(opts: EncoderInitOptions): Promise<void> {
    // `vorbis-encoder-js` adalah publikasi npm dari ogg-vorbis-encoder-js
    // (higuma) — sumber & API-nya sama; nama npm-nya saja yang berbeda.
    const mod = (await import('vorbis-encoder-js')) as unknown as Record<string, unknown>;
    // Paketnya CommonJS (`module.exports = { libvorbis, encoder }`) dan
    // konstruktornya bernama `encoder`, bukan `OggVorbisEncoder` — nama itu
    // hanya ada di README repo aslinya. Interop ESM Vite/Node juga bisa
    // menaruhnya di `default`. Semua bentuk dicoba, lalu yang PERTAMA yang
    // benar-benar sebuah fungsi dipakai: menebak satu bentuk saja pernah
    // membuat jalur OGG gagal dengan "Ctor is not a constructor".
    const d = (mod['default'] ?? {}) as Record<string, unknown>;
    const Ctor = [mod['encoder'], mod['OggVorbisEncoder'], d['encoder'], d['OggVorbisEncoder'], d].find(
      (c): c is VorbisModule => typeof c === 'function',
    );
    if (!Ctor) {
      throw new Error(
        'vorbis-encoder-js: konstruktor tidak ditemukan di modul (bentuk export berubah?)',
      );
    }
    // quality vorbis: -0.1 .. 1.0 (0.5 ≈ 160 kbps stereo).
    const q = clamp(opts.quality ?? 0.5, -0.1, 1.0);
    this.enc = new Ctor(opts.sampleRate, opts.channels, q);
  }

  /**
   * Encoder ini menahan seluruh stream di dalam dirinya dan baru mengeluarkan
   * Blob di `finish()`. Jadi `encode()` mengembalikan kosong, dan seluruh
   * output muncul di `finish()`. Konsekuensinya: jalur OGG **tidak**
   * streaming-ke-disk; memori naik seiring panjang lagu. Untuk export sangat
   * panjang, sarankan WAV/MP3 (atau jalur A nanti, yang chunked).
   */
  encode(planar: Float32Array[]): Uint8Array {
    this.enc?.encode(planar);
    return EMPTY;
  }

  /**
   * ASYNC, dan itu bukan pilihan gaya: paket ini mengembalikan `Blob`, dan satu-
   * satunya cara membaca isi Blob adalah lewat Promise. Versi sinkron dari
   * method ini pernah ada di sini dan mengembalikan array kosong — hasilnya file
   * OGG 0 byte, tanpa satu pun error di mana pun.
   */
  async finish(): Promise<Uint8Array> {
    if (!this.enc) return EMPTY;
    const blob = this.enc.finish();
    this.enc = null;
    return new Uint8Array(await blob.arrayBuffer());
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
