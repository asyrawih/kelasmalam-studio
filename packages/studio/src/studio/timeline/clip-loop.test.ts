/**
 * LOOP CLIP — region yang mengisi clip, bukan yang memotongnya.
 *
 * Yang dikunci di sini adalah janji fiturnya, satu per satu:
 *
 *   1. memasang loop TIDAK memindahkan atau memanjangkan clip;
 *   2. masuk di tengah clip berarti masuk di tengah PUTARAN (modulo), bukan di
 *      awal region — cacat yang hanya muncul saat user melompat;
 *   3. penjabaran untuk export menutup rentang clip PERSIS, tanpa ekor yang
 *      menonjol keluar dan tanpa lubang di ujung;
 *   4. clip yang loop boleh lebih panjang dari file-nya (itu gunanya), tapi
 *      putarannya sendiri tetap wajib muat di dalam file.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_FADE_CURVE, timelineLenFor, type StudioClip } from '../model';
import {
  activeLoopLen,
  applyClipLoop,
  clearClipLoop,
  expandLoopClip,
  loopSourceOffset,
  loopTileCount,
  normalizeClipLoop,
  MIN_LOOP_LEN,
} from './clip-loop';
import { slipClip, trimRight } from './clip-trim';

const SR = 48_000;

function clip(over: Partial<StudioClip> = {}): StudioClip {
  return {
    id: 'clip-1',
    assetId: 7,
    chain: [],
    start: 10 * SR,
    len: 60 * SR,
    sourceStart: 0,
    sourceLen: 60 * SR,
    label: 'lagu',
    gainDb: -2,
    fadeInMs: 0,
    fadeOutMs: 0,
    fadeCurve: DEFAULT_FADE_CURVE,
    seed: 1,
    ...over,
  };
}

describe('activeLoopLen', () => {
  it('null kalau tidak dipasang', () => {
    expect(activeLoopLen(clip())).toBeNull();
  });

  it('null kalau putaran tidak lebih pendek dari materi clip — ia tidak akan pernah berputar', () => {
    expect(activeLoopLen(clip({ loopLen: 60 * SR }))).toBeNull();
    expect(activeLoopLen(clip({ loopLen: 90 * SR }))).toBeNull();
  });

  it('null untuk nilai rusak, bukan melempar', () => {
    expect(activeLoopLen(clip({ loopLen: Number.NaN }))).toBeNull();
    expect(activeLoopLen(clip({ loopLen: 0 }))).toBeNull();
    expect(activeLoopLen(clip({ loopLen: MIN_LOOP_LEN - 1 }))).toBeNull();
  });

  it('membulatkan panjang yang pecahan', () => {
    expect(activeLoopLen(clip({ loopLen: 4.4 * SR }))).toBe(Math.round(4.4 * SR));
  });
});

describe('normalizeClipLoop', () => {
  it('membuang field yang rusak dari project lama', () => {
    expect(normalizeClipLoop(clip({ loopLen: Number.NaN }))).not.toHaveProperty('loopLen');
    expect(normalizeClipLoop(clip({ loopLen: -5 }))).not.toHaveProperty('loopLen');
  });

  it('clip yang sudah benar dikembalikan APA ADANYA (referensi sama)', () => {
    const c = clip({ loopLen: 4 * SR });
    expect(normalizeClipLoop(c)).toBe(c);
  });
});

describe('applyClipLoop', () => {
  it('tidak memindahkan dan tidak memanjangkan clip', () => {
    const c = clip();
    const next = applyClipLoop(c, { sourceStart: 8 * SR, sourceLen: 4 * SR }, SR);
    expect(next.start).toBe(c.start);
    expect(next.len).toBe(c.len);
    expect(next.sourceLen).toBe(c.sourceLen);
  });

  it('memindahkan titik masuk ke awal region dan memasang panjang putaran', () => {
    const next = applyClipLoop(clip(), { sourceStart: 8 * SR, sourceLen: 4 * SR }, SR);
    expect(next.sourceStart).toBe(8 * SR);
    expect(next.loopLen).toBe(4 * SR);
    expect(activeLoopLen(next)).toBe(4 * SR);
  });

  it('LEPAS LOOP mengembalikan clip tanpa field loop sama sekali', () => {
    const looped = applyClipLoop(clip(), { sourceStart: 8 * SR, sourceLen: 4 * SR }, SR);
    expect(clearClipLoop(looped)).not.toHaveProperty('loopLen');
    expect(activeLoopLen(clearClipLoop(looped))).toBeNull();
  });
});

describe('loopSourceOffset', () => {
  it('masuk di tengah clip = masuk di tengah PUTARAN, bukan di awal region', () => {
    const c = clip({ sourceStart: 8 * SR, loopLen: 4 * SR });
    // 10 detik ke dalam clip: putaran ke-3 sudah berjalan 2 detik.
    expect(loopSourceOffset(c, 4 * SR, 10 * SR)).toBe(8 * SR + 2 * SR);
  });

  it('tepat di batas putaran kembali ke awal region', () => {
    const c = clip({ sourceStart: 8 * SR, loopLen: 4 * SR });
    expect(loopSourceOffset(c, 4 * SR, 8 * SR)).toBe(8 * SR);
  });

  it('posisi negatif (playhead sebelum clip) tidak menghasilkan offset negatif', () => {
    const c = clip({ sourceStart: 8 * SR, loopLen: 4 * SR });
    expect(loopSourceOffset(c, 4 * SR, -5 * SR)).toBe(8 * SR);
  });
});

describe('loopTileCount', () => {
  it('putaran terakhir yang terpotong tetap dihitung', () => {
    expect(loopTileCount(10 * SR, 4 * SR)).toBe(3);
    expect(loopTileCount(8 * SR, 4 * SR)).toBe(2);
  });
});

describe('expandLoopClip — penjabaran untuk export', () => {
  const ids = (i: number): string => `x${i}`;

  it('clip tanpa loop dikembalikan apa adanya', () => {
    const c = clip();
    expect(expandLoopClip(c, 1, SR, ids)).toEqual([c]);
  });

  it('potongan menutup rentang clip PERSIS — tanpa lubang, tanpa ekor', () => {
    const c = clip({ len: 10 * SR, sourceLen: 10 * SR, loopLen: 4 * SR });
    const out = expandLoopClip(c, 1, SR, ids);
    expect(out).toHaveLength(3);
    expect(out[0]!.start).toBe(c.start);
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.start).toBe(out[i - 1]!.start + out[i - 1]!.len);
    }
    const last = out[out.length - 1]!;
    expect(last.start + last.len).toBe(c.start + c.len);
    // Potongan terakhir memang lebih pendek dari satu putaran.
    expect(last.len).toBe(2 * SR);
  });

  it('tiap potongan membaca region yang SAMA — itu arti mengulang', () => {
    const c = clip({ len: 10 * SR, sourceLen: 10 * SR, sourceStart: 8 * SR, loopLen: 4 * SR });
    for (const p of expandLoopClip(c, 1, SR, ids)) {
      expect(p.sourceStart).toBe(8 * SR);
      expect(p.loopLen).toBeUndefined();
      expect(p.sourceLen).toBeLessThanOrEqual(4 * SR);
    }
  });

  it('fade hanya di ujung-ujung clip, bukan di tiap sambungan', () => {
    const c = clip({ len: 10 * SR, sourceLen: 10 * SR, loopLen: 4 * SR, fadeInMs: 500, fadeOutMs: 800 });
    const out = expandLoopClip(c, 1, SR, ids);
    expect(out[0]!.fadeInMs).toBe(500);
    expect(out[0]!.fadeOutMs).toBe(0);
    expect(out[1]!.fadeInMs).toBe(0);
    expect(out[1]!.fadeOutMs).toBe(0);
    expect(out[out.length - 1]!.fadeOutMs).toBe(800);
  });

  it('clip pertama MEMPERTAHANKAN id-nya; sisanya id baru yang unik', () => {
    const c = clip({ len: 10 * SR, sourceLen: 10 * SR, loopLen: 4 * SR });
    const out = expandLoopClip(c, 1, SR, ids);
    expect(out[0]!.id).toBe('clip-1');
    expect(new Set(out.map((p) => p.id)).size).toBe(out.length);
  });

  it('lane yang dipercepat: panjang potongan lewat timelineLenFor, bukan rumus kedua', () => {
    const c = clip({ len: 5 * SR, sourceLen: 10 * SR, loopLen: 4 * SR });
    const out = expandLoopClip(c, 2, SR, ids);
    expect(out[0]!.len).toBe(timelineLenFor(4 * SR, 2));
    const last = out[out.length - 1]!;
    expect(last.start + last.len).toBe(c.start + c.len);
  });
});

describe('trim & slip pada clip yang loop', () => {
  const ASSET = 30 * SR;

  it('clip biasa tidak bisa dipanjangkan melewati ujung materi', () => {
    const c = clip({ len: 30 * SR, sourceLen: 30 * SR });
    const next = trimRight(c, 1, c.start + 60 * SR, ASSET);
    expect(next.sourceLen).toBe(ASSET);
  });

  it('clip yang LOOP boleh dipanjangkan sejauh apa pun — pengulangan yang mengisinya', () => {
    const c = clip({ len: 30 * SR, sourceLen: 30 * SR, loopLen: 4 * SR });
    const next = trimRight(c, 1, c.start + 90 * SR, ASSET);
    expect(next.len).toBe(90 * SR);
    expect(activeLoopLen(next)).toBe(4 * SR);
  });

  it('slip clip yang loop dibatasi oleh PUTARANNYA, bukan oleh panjang clip', () => {
    // Clip 90 detik dengan putaran 4 detik di asset 30 detik: awal putaran
    // masih boleh digeser sampai 26 detik, walau clip-nya jauh lebih panjang.
    const c = clip({ start: 0, len: 90 * SR, sourceLen: 90 * SR, loopLen: 4 * SR });
    const next = slipClip(c, 0, 40 * SR, ASSET);
    expect(next.sourceStart).toBe(ASSET - 4 * SR);
  });
});
