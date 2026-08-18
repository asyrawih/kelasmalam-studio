/**
 * Trim & slip.
 *
 * Yang dijaga di sini adalah hal yang tidak terlihat dari layar: tepi yang
 * SEHARUSNYA DIAM benar-benar diam (termasuk setelah puluhan langkah kecil),
 * konversi timeline↔source lewat `speedRatio`, dan batas materi yang kalau
 * dilewati membuat clip terlihat ada tapi bisu.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_FADE_CURVE, type StudioClip } from '../model';
import { slipClip, trimLeft, trimRight } from './clip-trim';

const SR = 48_000;
const FRAMES = 60 * SR;

function clip(over: Partial<StudioClip> = {}): StudioClip {
  return {
    id: 'c1',
    assetId: 1,
    start: 10 * SR,
    len: 20 * SR,
    sourceStart: 5 * SR,
    sourceLen: 20 * SR,
    label: 'c1',
    gainDb: 0,
    fadeInMs: 0,
    fadeOutMs: 0,
    fadeCurve: DEFAULT_FADE_CURVE,
    seed: 1,
    ...over,
  };
}

describe('trim tepi kanan', () => {
  it('memendekkan clip tanpa memindahkan tepi kiri', () => {
    const c = trimRight(clip(), 1, 22 * SR, FRAMES);
    expect(c.start).toBe(10 * SR);
    expect(c.len).toBe(12 * SR);
    expect(c.sourceStart).toBe(5 * SR); // jendela ke materi tidak bergeser
    expect(c.sourceLen).toBe(12 * SR);
  });

  it('memanjangkan kembali memunculkan materi yang tadi disembunyikan', () => {
    const short = trimRight(clip(), 1, 15 * SR, FRAMES);
    const back = trimRight(short, 1, 30 * SR, FRAMES);
    expect(back.len).toBe(20 * SR);
    expect(back.sourceLen).toBe(20 * SR);
  });

  it('tidak bisa melewati ujung materi', () => {
    // sourceStart 5 s, materi 60 s → sisa 55 s.
    const c = trimRight(clip(), 1, 999 * SR, FRAMES);
    expect(c.sourceStart + c.sourceLen).toBe(FRAMES);
    expect(c.sourceLen).toBe(55 * SR);
  });

  it('tanpa batas materi yang diketahui, tidak dipaksakan', () => {
    const c = trimRight(clip(), 1, 200 * SR, undefined);
    expect(c.sourceLen).toBe(190 * SR);
  });

  it('tidak bisa menyusut sampai nol', () => {
    const c = trimRight(clip(), 1, 10 * SR - 5, FRAMES);
    expect(c.sourceLen).toBeGreaterThan(0);
    expect(c.len).toBeGreaterThan(0);
  });

  it('kecepatan lane: satu detik timeline memakan dua detik materi', () => {
    const c = trimRight(clip({ sourceLen: 40 * SR, len: 20 * SR }), 2, 22 * SR, FRAMES);
    expect(c.len).toBe(12 * SR);
    expect(c.sourceLen).toBe(24 * SR);
  });
});

describe('trim tepi kiri', () => {
  it('memotong dari awal tanpa memindahkan tepi kanan', () => {
    const before = clip();
    const c = trimLeft(before, 1, 14 * SR);
    expect(c.start + c.len).toBe(before.start + before.len); // ujung kanan PATOK
    expect(c.start).toBe(14 * SR);
    expect(c.sourceStart).toBe(9 * SR);
    expect(c.sourceLen).toBe(16 * SR);
  });

  it('tepi kanan tetap di tempat setelah puluhan langkah kecil', () => {
    // Inilah yang rusak kalau kedua sisi dihitung dari selisih: pembulatan
    // sample menumpuk dan tepi yang tidak disentuh berpindah pelan-pelan.
    let c = clip();
    const right = c.start + c.len;
    for (let i = 0; i < 60; i++) c = trimLeft(c, 1, c.start + 137);
    expect(c.start + c.len).toBe(right);
  });

  it('tidak bisa mundur melewati awal materi', () => {
    // sourceStart 5 s → paling jauh mundur 5 detik.
    const c = trimLeft(clip(), 1, 0);
    expect(c.sourceStart).toBe(0);
    expect(c.start).toBe(5 * SR);
    expect(c.sourceLen).toBe(25 * SR);
  });

  it('tidak bisa maju melewati tepi kanannya sendiri', () => {
    const c = trimLeft(clip(), 1, 999 * SR);
    expect(c.sourceLen).toBeGreaterThan(0);
    expect(c.start).toBeLessThan(c.start + c.len);
  });

  it('kecepatan lane ikut diperhitungkan', () => {
    const c = trimLeft(clip({ sourceLen: 40 * SR, len: 20 * SR }), 2, 12 * SR);
    expect(c.sourceStart).toBe(9 * SR); // 2 detik timeline = 4 detik materi
    expect(c.sourceLen).toBe(36 * SR);
    expect(c.start + c.len).toBe(30 * SR);
  });
});

describe('slip', () => {
  it('menggeser materi tanpa memindahkan clip', () => {
    const before = clip();
    const c = slipClip(before, before.sourceStart, 3 * SR, FRAMES);
    expect(c.sourceStart).toBe(8 * SR);
    // Tiga angka ini yang membedakan slip dari trim dan dari pindah clip.
    expect(c.start).toBe(before.start);
    expect(c.len).toBe(before.len);
    expect(c.sourceLen).toBe(before.sourceLen);
  });

  it('dihitung dari titik AWAL tarikan, bukan posisi sekarang', () => {
    const before = clip();
    // Sepuluh langkah dari origin yang sama tidak menumpuk.
    let c = before;
    for (let i = 0; i < 10; i++) c = slipClip(c, before.sourceStart, 2 * SR, FRAMES);
    expect(c.sourceStart).toBe(7 * SR);
  });

  it('dijepit di kedua ujung materi', () => {
    const c = clip();
    expect(slipClip(c, c.sourceStart, -999 * SR, FRAMES).sourceStart).toBe(0);
    expect(slipClip(c, c.sourceStart, 999 * SR, FRAMES).sourceStart).toBe(FRAMES - 20 * SR);
  });

  it('mengembalikan objek LAMA kalau tidak ada yang berubah', () => {
    const c = clip();
    expect(slipClip(c, c.sourceStart, 0, FRAMES)).toBe(c);
  });
});
