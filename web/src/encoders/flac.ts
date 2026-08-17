/**
 * FLAC encoder — implementasi Rust (`daw-export::flac`, crate `flacenc`) lewat
 * surface bindgen. Lossless, kira-kira separuh ukuran WAV, tanpa dependensi JS.
 *
 * Kenapa ini ada: "compress audio untuk WAV" tidak punya jawaban di dalam WAV
 * itu sendiri — WAV adalah PCM mentah. FLAC menyimpan sample yang sama persis
 * (bit-exact saat di-decode) sambil separuh ukurannya, jadi ia satu-satunya
 * jawaban yang tidak menukar kualitas dengan ukuran.
 *
 * Bentuknya identik dengan `WavEncoder` — `header()` placeholder lalu
 * `finalHeader()` yang menggantikannya — supaya `run-export.ts` tidak perlu tahu
 * format apa yang sedang dipakai.
 */

import type { FlacEncoderHandleT, WasmBindgenExports } from '../audio/wasm-loader';
import { EMPTY, type Encoder, type EncoderInitOptions } from './types';

export class FlacEncoder implements Encoder {
  readonly mime = 'audio/flac';
  readonly ext = 'flac';

  private handle: FlacEncoderHandleT | null = null;
  private headerBytes: Uint8Array = EMPTY;

  constructor(
    private readonly wasm: WasmBindgenExports,
    private readonly ditherSeed = 0x5eed_1234,
  ) {}

  async init(opts: EncoderInitOptions): Promise<void> {
    // FLAC tidak punya float32. 32-bit yang diminta UI turun ke 24-bit — itu
    // kedalaman integer tertinggi yang bisa disimpan format ini, jadi tidak ada
    // informasi yang hilang dibanding pilihan FLAC mana pun.
    const bits =
      opts.bitDepth === 16 ? this.wasm.FlacBitsJs.Pcm16 : this.wasm.FlacBitsJs.Pcm24;
    this.handle = new this.wasm.FlacEncoderHandle(
      opts.sampleRate,
      opts.channels,
      bits,
      this.ditherSeed,
    );
    this.headerBytes = this.handle.header();
  }

  /** "fLaC" + STREAMINFO dengan total_samples/md5 masih nol. */
  header(): Uint8Array {
    return this.headerBytes;
  }

  encode(planar: Float32Array[]): Uint8Array {
    if (!this.handle) return EMPTY;
    const l = planar[0] ?? EMPTY_F32;
    const r = planar[1] ?? l;
    return this.handle.encode(l, r);
  }

  /** Frame terakhir (boleh lebih pendek) + sisa chunk. */
  finish(): Uint8Array {
    return this.handle ? this.handle.flush() : EMPTY;
  }

  /**
   * STREAMINFO final: jumlah sample + md5 sinyal asli. Panjangnya SAMA dengan
   * placeholder (STREAMINFO selalu 34 byte), jadi menukar part pertama Blob
   * aman. md5 itulah yang membuat `flac -t` bisa membuktikan file ini lossless.
   */
  finalHeader(): Uint8Array | null {
    if (!this.handle) return null;
    const h = this.handle.patchHeader();
    this.handle.free();
    this.handle = null;
    return h;
  }
}

const EMPTY_F32 = new Float32Array(0);
