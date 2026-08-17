/**
 * Registry encoder + file delivery (docs/03 §3c–3d).
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

// ── File delivery ────────────────────────────────────────────────────────────

/**
 * Object URL menahan Blob di memori/disk sampai di-revoke ATAU dokumen
 * dibongkar. Untuk export 170 MB yang diulang, lupa revoke = kebocoran nyata.
 *
 * Aturan di kode ini (docs/03 §3d): setiap `createObjectURL` didaftarkan di
 * sini, di-revoke setelah 60 detik dan pada `beforeunload`. 60 detik, bukan
 * segera: Safari membutuhkan URL tetap hidup saat unduhan dimulai.
 */
export class ObjectUrlRegistry {
  private static readonly urls = new Set<string>();
  private static installed = false;

  static create(blob: Blob, ttlMs = 60_000): string {
    ObjectUrlRegistry.install();
    const url = URL.createObjectURL(blob);
    ObjectUrlRegistry.urls.add(url);
    setTimeout(() => ObjectUrlRegistry.revoke(url), ttlMs);
    return url;
  }

  static revoke(url: string): void {
    if (ObjectUrlRegistry.urls.delete(url)) URL.revokeObjectURL(url);
  }

  static revokeAll(): void {
    for (const u of ObjectUrlRegistry.urls) URL.revokeObjectURL(u);
    ObjectUrlRegistry.urls.clear();
  }

  private static install(): void {
    if (ObjectUrlRegistry.installed || typeof window === 'undefined') return;
    ObjectUrlRegistry.installed = true;
    window.addEventListener('beforeunload', () => ObjectUrlRegistry.revokeAll());
  }
}

/** Apakah jalur streaming-ke-disk tersedia (Chromium; Firefox/Safari belum). */
export function canStreamToDisk(): boolean {
  return typeof globalThis !== 'undefined' && 'showSaveFilePicker' in globalThis;
}

/**
 * Minta lokasi simpan. **Harus dipanggil dari handler klik**, sebelum render
 * mulai — picker butuh user gesture (docs/03 §3d). Mengembalikan `null` kalau
 * tidak didukung atau user membatalkan.
 */
export async function pickSaveLocation(
  fileName: string,
  mime: string,
  ext: string,
): Promise<FileSystemFileHandle | null> {
  if (!canStreamToDisk()) return null;
  try {
    const picker = (
      globalThis as unknown as {
        showSaveFilePicker(o: unknown): Promise<FileSystemFileHandle>;
      }
    ).showSaveFilePicker;
    return await picker({
      suggestedName: fileName,
      types: [{ description: 'Audio', accept: { [mime]: ['.' + ext] } }],
    });
  } catch {
    // AbortError (user batal) maupun error lain → fallback ke jalur Blob.
    return null;
  }
}

/** Unduh Blob lewat anchor. Jalur baseline yang jalan di mana saja. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = ObjectUrlRegistry.create(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke ditangani ObjectUrlRegistry (60 s) — JANGAN revoke di sini.
}
