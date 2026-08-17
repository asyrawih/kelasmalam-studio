/**
 * WAV encoder — memanggil implementasi Rust (`daw-export`) lewat surface
 * bindgen. Selalu tersedia, nol dependensi, ini format default export.
 *
 * Dither TPDF ditangani di sisi Rust (docs/03 §3b): hanya untuk 16-bit, seed
 * dari parameter export supaya dua export dengan setelan sama menghasilkan file
 * byte-identik (penting untuk tes null).
 */

import type { WasmBindgenExports, WavEncoderHandleT } from '../audio/wasm-loader';
import { EMPTY, type Encoder, type EncoderInitOptions } from './types';

export class WavEncoder implements Encoder {
  readonly mime = 'audio/wav';
  readonly ext = 'wav';

  private handle: WavEncoderHandleT | null = null;
  private headerBytes: Uint8Array = EMPTY;

  constructor(
    private readonly wasm: WasmBindgenExports,
    private readonly ditherSeed = 0x5eed_1234,
  ) {}

  async init(opts: EncoderInitOptions): Promise<void> {
    const bits =
      opts.bitDepth === 16
        ? this.wasm.WavBits.Pcm16
        : opts.bitDepth === 32
          ? this.wasm.WavBits.Float32
          : this.wasm.WavBits.Pcm24;
    this.handle = new this.wasm.WavEncoderHandle(
      opts.sampleRate,
      opts.channels,
      bits,
      this.ditherSeed,
    );
    // Header placeholder: ukuran RIFF/data belum diketahui, di-patch di finish().
    this.headerBytes = this.handle.header();
  }

  /** Header placeholder — ditulis sebagai part pertama. */
  header(): Uint8Array {
    return this.headerBytes;
  }

  encode(planar: Float32Array[]): Uint8Array {
    if (!this.handle) return EMPTY;
    const l = planar[0] ?? EMPTY_F32;
    const r = planar[1] ?? l;
    return this.handle.encode(l, r);
  }

  /** Sisa chunk terakhir dari writer Rust. */
  finish(): Uint8Array {
    return this.handle ? this.handle.flush() : EMPTY;
  }

  /** Header final dengan ukuran yang benar; menggantikan placeholder. */
  finalHeader(): Uint8Array | null {
    if (!this.handle) return null;
    const h = this.handle.patchHeader();
    this.handle.free();
    this.handle = null;
    return h;
  }
}

const EMPTY_F32 = new Float32Array(0);
