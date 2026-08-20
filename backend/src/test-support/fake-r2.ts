/**
 * R2 palsu di memori.
 *
 * Dipalsukan, bukan dipakai sungguhan, karena yang diuji di sisi ini cuma dua
 * pertanyaan: "objeknya ada?" dan "byte-nya apa?" — dan keduanya tidak punya
 * perilaku R2 yang bisa mengejutkan. Bandingkan dengan D1, yang dipakai
 * sungguhan lewat SQLite karena SQL PUNYA banyak cara mengejutkan.
 */

import type { R2Bucket, R2Object, R2ObjectBody } from '../library/bindings';

export interface FakeR2 extends R2Bucket {
  /** Tempatkan objek seolah-olah browser baru saja meng-PUT-nya. */
  put(key: string, bytes: Uint8Array): void;
  has(key: string): boolean;
  keys(): readonly string[];
}

export function fakeR2(): FakeR2 {
  // `ArrayBuffer`, bukan `Uint8Array`: tipe `BlobPart` menuntut buffer yang
  // BUKAN `SharedArrayBuffer`, dan `Uint8Array` generik tidak bisa
  // membuktikannya. Menyimpan buffer-nya langsung menghilangkan pertanyaannya.
  const objects = new Map<string, ArrayBuffer>();

  return {
    put(key, bytes) {
      objects.set(key, bytes.slice().buffer);
    },
    has: (key) => objects.has(key),
    keys: () => [...objects.keys()],

    async head(key): Promise<R2Object | null> {
      const buf = objects.get(key);
      return buf === undefined ? null : { size: buf.byteLength };
    },

    async get(key): Promise<R2ObjectBody | null> {
      const buf = objects.get(key);
      if (buf === undefined) return null;
      return { size: buf.byteLength, body: new Blob([buf]).stream() };
    },
  };
}
