/**
 * Penjaga penyimpangan: batas di server HARUS sama dengan batas di UI.
 *
 * Ini satu-satunya berkas di backend yang meng-import paket web, dan ia
 * sengaja berupa TES, bukan kode produksi — bundle Worker tetap mandiri
 * (alasannya di kepala `limits.ts`), tapi angka yang berbeda antara dua sisi
 * tidak bisa lolos diam-diam.
 *
 * Kalau tes ini merah, yang rusak bukan gaya penulisan: UI sedang menerima
 * berkas yang akan ditolak server, atau sebaliknya menolak berkas yang
 * sebetulnya boleh.
 */

import { describe, expect, it } from 'vitest';

import * as web from '../../../web/src/roblox/model';
import { AUDIO_EXTS, MAX_BYTES, MAX_DESC_LEN, MAX_NAME_LEN, MAX_SECONDS, extOf } from './limits';

describe('batas server = batas UI', () => {
  it('angkanya identik', () => {
    expect(MAX_BYTES).toBe(web.MAX_BYTES);
    expect(MAX_SECONDS).toBe(web.MAX_SECONDS);
    expect(MAX_NAME_LEN).toBe(web.MAX_NAME_LEN);
    expect(MAX_DESC_LEN).toBe(web.MAX_DESC_LEN);
  });

  it('daftar ekstensinya identik dan berurutan sama', () => {
    expect([...AUDIO_EXTS]).toEqual([...web.AUDIO_EXTS]);
  });

  it('`extOf` menjawab sama untuk kasus yang sama', () => {
    for (const name of ['a.mp3', 'a.OGG', 'mix.final.mp3', '.gitignore', 'tanpa-titik']) {
      expect(extOf(name)).toBe(web.extOf(name));
    }
  });
});
