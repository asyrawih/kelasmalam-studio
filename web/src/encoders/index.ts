/**
 * Registry encoder (docs/03 §3c).
 */

import type { WasmBindgenExports } from '../audio/wasm-loader';
import { FlacEncoder } from './flac';
import { Mp3LameJsEncoder } from './mp3-lamejs';
import { OggVorbisEncoder } from './ogg-vorbis';
import type { Encoder, EncoderFormat } from './types';
import { WavEncoder } from './wav';

export type { Encoder, EncoderFormat, EncoderInitOptions } from './types';
export { WavEncoder } from './wav';
export { FlacEncoder } from './flac';
export { Mp3LameJsEncoder } from './mp3-lamejs';
export { OggVorbisEncoder } from './ogg-vorbis';

/**
 * Buat encoder. MP3/OGG di-`import()` secara dinamis di dalam `init()`-nya,
 * jadi memanggil fungsi ini tidak mengunduh apa pun sampai `init()` dipanggil —
 * dan satu paket lossy yang gagal dimuat tidak menyentuh format lain sama
 * sekali.
 *
 * WAV dan FLAC keduanya Rust: sudah ada di artefak yang sama dengan engine,
 * tidak ada yang perlu diunduh.
 */
export function createEncoder(format: EncoderFormat, wasm?: WasmBindgenExports): Encoder {
  switch (format) {
    case 'wav':
      if (!wasm) throw new Error('WAV encoder butuh instance WASM (surface bindgen)');
      return new WavEncoder(wasm);
    case 'flac':
      if (!wasm) throw new Error('FLAC encoder butuh instance WASM (surface bindgen)');
      return new FlacEncoder(wasm);
    case 'mp3':
      return new Mp3LameJsEncoder();
    case 'ogg':
      return new OggVorbisEncoder();
  }
}

// File delivery (`pickSaveLocation`, `downloadBlob`, `ObjectUrlRegistry`) pindah
// ke `platform/web.ts`: ke mana byte pergi adalah urusan platform, bukan encoder.
