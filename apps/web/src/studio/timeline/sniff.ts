/**
 * Pengenalan format berdasarkan MAGIC BYTES, bukan ekstensi file.
 *
 * Kenapa perlu: ekstensi berbohong. Kasus nyata yang memicu modul ini — sebuah
 * file `.ogg` hasil unduhan ternyata berisi data **gzip**: server mengirimnya
 * dengan `Content-Encoding: gzip` dan file tersimpan dalam keadaan masih
 * terkompresi. `decodeAudioData` menolaknya dengan pesan "unknown content
 * type", yang benar tapi tidak membantu — ia tidak memberi tahu bahwa isinya
 * sebenarnya arsip, bukan audio rusak.
 *
 * Dua tugas modul ini:
 *   1. Membuka pembungkus gzip secara transparan supaya file seperti itu tetap
 *      bisa diimpor.
 *   2. Kalau tetap bukan audio, memberi pesan yang menyebut APA isinya.
 */

export type SniffResult =
  | { readonly kind: 'audio'; readonly format: string }
  | { readonly kind: 'gzip' }
  | { readonly kind: 'unknown'; readonly description: string };

function startsWith(bytes: Uint8Array, sig: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  return sig.every((b, i) => bytes[offset + i] === b);
}

const ascii = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

export function sniff(buffer: ArrayBuffer): SniffResult {
  const b = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 64));

  if (startsWith(b, [0x1f, 0x8b])) return { kind: 'gzip' };

  if (startsWith(b, ascii('OggS'))) return { kind: 'audio', format: 'Ogg' };
  if (startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WAVE'), 8)) {
    return { kind: 'audio', format: 'WAV' };
  }
  if (startsWith(b, ascii('fLaC'))) return { kind: 'audio', format: 'FLAC' };
  if (startsWith(b, ascii('ID3'))) return { kind: 'audio', format: 'MP3' };
  // Frame sync MP3: 11 bit menyala.
  if (b.length >= 2 && b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0) {
    return { kind: 'audio', format: 'MP3' };
  }
  if (startsWith(b, ascii('ftyp'), 4)) return { kind: 'audio', format: 'MP4/M4A' };
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return { kind: 'audio', format: 'WebM/Matroska' };
  if (startsWith(b, ascii('FORM'))) return { kind: 'audio', format: 'AIFF' };

  // Bukan audio — sebutkan apa yang terbaca supaya user tahu harus apa.
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04])) {
    return { kind: 'unknown', description: 'arsip ZIP' };
  }
  if (startsWith(b, ascii('%PDF'))) return { kind: 'unknown', description: 'dokumen PDF' };
  if (startsWith(b, ascii('<!DOCTYPE')) || startsWith(b, ascii('<html'))) {
    return { kind: 'unknown', description: 'halaman HTML (mungkin error page saat mengunduh)' };
  }

  const hex = [...b.slice(0, 4)].map((x) => x.toString(16).padStart(2, '0')).join(' ');
  return { kind: 'unknown', description: `format tak dikenal (byte awal: ${hex})` };
}

/** true kalau browser bisa membuka gzip tanpa pustaka tambahan. */
export function canGunzip(): boolean {
  return typeof (globalThis as { DecompressionStream?: unknown }).DecompressionStream === 'function';
}

/** Buka pembungkus gzip memakai DecompressionStream bawaan browser. */
export async function gunzip(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([buffer]).stream().pipeThrough(ds);
  return new Response(stream).arrayBuffer();
}
