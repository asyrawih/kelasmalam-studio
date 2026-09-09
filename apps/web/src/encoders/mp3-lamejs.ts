/**
 * MP3 via **lamejs** — port JS dari LAME (docs/03 §3c, rekomendasi jalur B).
 *
 * Kenapa lamejs dan bukan ffmpeg.wasm: ~50 KB vs 5 MB, tanpa WASM sama sekali
 * (jadi tanpa masalah COEP untuk artefak lintas origin), tanpa MEMFS
 * round-trip. Kecepatannya cukup (5 menit stereo ≈ 10–20 s) dan kalau kurang,
 * jalur A (sidecar emcc LAME) menggantikannya TANPA mengubah antarmuka ini.
 *
 * Import-nya **dinamis dan malas**: paketnya baru diunduh saat user benar-benar
 * memilih MP3.
 *
 * Catatan lisensi: LAME = LGPL 2.1. lamejs didistribusikan sebagai paket
 * terpisah yang dapat diganti; sebutkan lisensinya di halaman About.
 */

import { EMPTY, type Encoder, type EncoderInitOptions } from './types';

interface LameMp3Encoder {
  encodeBuffer(l: Int16Array, r?: Int16Array): Uint8Array | number[];
  flush(): Uint8Array | number[];
}
interface LameModule {
  Mp3Encoder: new (channels: number, sampleRate: number, kbps: number) => LameMp3Encoder;
}

/** Ukuran blok yang disarankan lamejs (kelipatan 576 = granule MP3). */
const BLOCK = 1152;

export class Mp3LameJsEncoder implements Encoder {
  readonly mime = 'audio/mpeg';
  readonly ext = 'mp3';

  private enc: LameMp3Encoder | null = null;
  private channels = 2;
  /** Buffer i16 dipakai ulang — encode dipanggil ribuan kali per export. */
  private bufL = new Int16Array(BLOCK);
  private bufR = new Int16Array(BLOCK);

  async init(opts: EncoderInitOptions): Promise<void> {
    // `@breezystack/lamejs` = fork lamejs yang dipelihara & ESM-friendly.
    // Paket `lamejs` asli (1.2.1) memecah dirinya jadi global implisit
    // (`MPEGMode`) yang pecah di bundler modern — fork ini yang dipakai.
    const mod = (await import('@breezystack/lamejs')) as unknown as LameModule & {
      default?: LameModule;
    };
    const lame = mod.Mp3Encoder ? mod : (mod.default as LameModule);
    this.channels = opts.channels;
    const kbps = Math.round(opts.quality ?? 192);
    this.enc = new lame.Mp3Encoder(opts.channels, opts.sampleRate, kbps);
  }

  encode(planar: Float32Array[]): Uint8Array {
    const enc = this.enc;
    if (!enc) return EMPTY;
    const l = planar[0];
    if (!l) return EMPTY;
    const r = this.channels > 1 ? (planar[1] ?? l) : undefined;

    const chunks: Uint8Array[] = [];
    for (let off = 0; off < l.length; off += BLOCK) {
      const n = Math.min(BLOCK, l.length - off);
      if (this.bufL.length !== n) {
        // Hanya blok terakhir yang berbeda panjang; realokasi paling banyak 1×.
        this.bufL = new Int16Array(n);
        this.bufR = new Int16Array(n);
      }
      floatToI16(l, off, n, this.bufL);
      if (r) floatToI16(r, off, n, this.bufR);
      const out = enc.encodeBuffer(this.bufL, r ? this.bufR : undefined);
      if (out.length > 0) chunks.push(toU8(out));
    }
    // Kembalikan ukuran default untuk iterasi berikutnya.
    if (this.bufL.length !== BLOCK) {
      this.bufL = new Int16Array(BLOCK);
      this.bufR = new Int16Array(BLOCK);
    }
    return concat(chunks);
  }

  finish(): Uint8Array {
    if (!this.enc) return EMPTY;
    const out = toU8(this.enc.flush());
    this.enc = null;
    return out;
  }
}

/**
 * f32 [-1,1] → i16. Clamp SEBELUM skala supaya sinyal >0 dBFS tidak wrap
 * (menjadi klik keras), dan skala asimetris 32767/32768 dihindari dengan
 * memakai 32767 untuk kedua arah — 1 LSB, tidak terdengar, tapi menjamin tidak
 * ada overflow di -1.0.
 */
function floatToI16(src: Float32Array, off: number, n: number, dst: Int16Array): void {
  for (let i = 0; i < n; i++) {
    const v = src[off + i]!;
    const c = v > 1 ? 1 : v < -1 ? -1 : v;
    dst[i] = (c * 32767) | 0;
  }
}

function toU8(v: Uint8Array | number[]): Uint8Array {
  return v instanceof Uint8Array ? v : Uint8Array.from(v);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return EMPTY;
  if (chunks.length === 1) return chunks[0]!;
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
