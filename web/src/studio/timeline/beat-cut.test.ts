import { describe, expect, it } from 'vitest';

import { DEFAULT_FADE_CURVE, defaultEq, type StudioClip, type StudioLane } from '../model';
import { MAX_LOOP_REPEAT, applyLoopCut, clampLoopSpec } from './beat-cut';

const SR = 48_000;

function lane(speedRatio = 1): StudioLane {
  return {
    id: 'lane-1',
    name: 'A',
    color: '#ffd400',
    mute: false,
    solo: false,
    gainDb: 0,
    speedRatio,
    eq: defaultEq(),
    clips: [],
  };
}

function clip(over: Partial<StudioClip> = {}): StudioClip {
  return {
    id: 'clip-1',
    assetId: 7,
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

/** Id yang bisa ditebak — tes tidak boleh bergantung pada waktu. */
function ids(): () => string {
  let n = 0;
  return () => `new-${++n}`;
}

describe('clampLoopSpec', () => {
  it('menahan region di dalam batas asset', () => {
    const r = clampLoopSpec({ sourceStart: 55 * SR, sourceLen: 20 * SR, repeat: 1, assetFrames: 60 * SR });
    expect(r.sourceStart).toBe(55 * SR);
    expect(r.sourceLen).toBe(5 * SR);
  });

  it('start negatif jadi nol, panjang nol jadi minimal satu sample', () => {
    const r = clampLoopSpec({ sourceStart: -100, sourceLen: 0, repeat: 1 });
    expect(r.sourceStart).toBe(0);
    expect(r.sourceLen).toBe(1);
  });

  it('repeat dibatasi 1..MAX', () => {
    expect(clampLoopSpec({ sourceStart: 0, sourceLen: SR, repeat: 0 }).repeat).toBe(1);
    expect(clampLoopSpec({ sourceStart: 0, sourceLen: SR, repeat: 1e6 }).repeat).toBe(MAX_LOOP_REPEAT);
    expect(clampLoopSpec({ sourceStart: 0, sourceLen: SR, repeat: Number.NaN }).repeat).toBe(1);
  });
});

describe('applyLoopCut', () => {
  it('repeat 4 menghasilkan 4 clip berderet tanpa celah', () => {
    const out = applyLoopCut(
      lane(),
      clip(),
      { sourceStart: 8 * SR, sourceLen: 2 * SR, repeat: 4, assetFrames: 60 * SR },
      ids(),
      SR,
    );
    expect(out).toHaveLength(4);
    expect(out.map((c) => c.start)).toEqual([10, 12, 14, 16].map((s) => s * SR));
    for (const c of out) {
      expect(c.len).toBe(2 * SR);
      expect(c.sourceStart).toBe(8 * SR);
      expect(c.sourceLen).toBe(2 * SR);
      expect(c.assetId).toBe(7);
      expect(c.gainDb).toBe(-2);
    }
    // Ujung tiap potongan tepat di awal potongan berikutnya.
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.start).toBe(out[i - 1]!.start + out[i - 1]!.len);
    }
  });

  it('clip pertama mempertahankan id-nya, sisanya id baru dan unik', () => {
    const out = applyLoopCut(lane(), clip(), { sourceStart: 0, sourceLen: SR, repeat: 3 }, ids(), SR);
    expect(out[0]!.id).toBe('clip-1');
    expect(new Set(out.map((c) => c.id)).size).toBe(3);
  });

  it('speedRatio 2 membuat panjang TIMELINE separuh sourceLen', () => {
    const out = applyLoopCut(
      lane(2),
      clip(),
      { sourceStart: 0, sourceLen: 4 * SR, repeat: 2, assetFrames: 60 * SR },
      ids(),
      SR,
    );
    expect(out[0]!.sourceLen).toBe(4 * SR);
    expect(out[0]!.len).toBe(2 * SR);
    expect(out[1]!.start).toBe(10 * SR + 2 * SR);
  });

  it('fade hanya di potongan pertama — sambungan loop tidak melubang', () => {
    const out = applyLoopCut(
      lane(),
      clip({ fadeInMs: 500, fadeOutMs: 500 }),
      { sourceStart: 0, sourceLen: 4 * SR, repeat: 3 },
      ids(),
      SR,
    );
    expect(out[0]!.fadeInMs).toBe(500);
    expect(out[0]!.fadeOutMs).toBe(500);
    expect(out[1]!.fadeInMs).toBe(0);
    expect(out[1]!.fadeOutMs).toBe(0);
    expect(out[2]!.fadeOutMs).toBe(0);
  });

  it('fade lama yang lebih panjang dari region baru dipangkas', () => {
    const out = applyLoopCut(
      lane(),
      clip({ fadeInMs: 8_000, fadeOutMs: 8_000 }),
      { sourceStart: 0, sourceLen: 2 * SR, repeat: 1 },
      ids(),
      SR,
    );
    // Clip barunya 2 detik; dua fade 8 detik tidak mungkin muat.
    expect(out[0]!.fadeInMs + out[0]!.fadeOutMs).toBeLessThanOrEqual(2_000);
  });

  it('region tidak pernah keluar dari batas asset', () => {
    const out = applyLoopCut(
      lane(),
      clip(),
      { sourceStart: 59 * SR, sourceLen: 10 * SR, repeat: 2, assetFrames: 60 * SR },
      ids(),
      SR,
    );
    for (const c of out) {
      expect(c.sourceStart + c.sourceLen).toBeLessThanOrEqual(60 * SR);
    }
  });
});
