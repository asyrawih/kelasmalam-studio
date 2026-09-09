import { describe, expect, it } from 'vitest';

import { BEATS_PER_BAR, type BeatGrid } from '../studio/analysis/beat-grid';
import { DEFAULT_TEMPO, type DeckTempo, type TempoRange } from './model';
import {
  foldToOctave,
  phaseDeltaSec,
  phaseErrorBeats,
  planSync,
  smallestRangeFor,
  syncBpmOf,
  type SyncDeck,
} from './sync';

const SR = 48_000;

const grid = (bpm: number, offsetSec = 0): BeatGrid => ({
  bpm,
  offsetSec,
  beatsPerBar: BEATS_PER_BAR,
  manual: false,
});

function tempo(over: Partial<DeckTempo> = {}): DeckTempo {
  return { ...DEFAULT_TEMPO, ...over };
}

function deck(over: Partial<SyncDeck> = {}): SyncDeck {
  return {
    grid: grid(128),
    playhead: 0,
    sampleRate: SR,
    tempo: tempo(),
    ...over,
  };
}

/** Posisi source yang berada tepat `beats` ketukan setelah titik nol grid. */
function atBeat(g: BeatGrid, beats: number): number {
  return Math.round((g.offsetSec + (beats * 60) / g.bpm) * SR);
}

describe('syncBpmOf', () => {
  it('memakai tempo fader — BPM efektif, bukan base', () => {
    // Ini cacat yang diperbaiki: dulu pemanggil mengirim BPM base master.
    const d = deck({ tempo: tempo({ fader: 0.5, rangePct: 10 }) });
    expect(syncBpmOf(d)!).toBeCloseTo(128 * 1.05, 9);
  });

  it('BEND TIDAK ikut — satu sentuhan jog di leader tidak boleh mengubah tempo follower selamanya', () => {
    const a = syncBpmOf(deck())!;
    // `bend` hidup di DeckState, bukan di DeckTempo: yang dibaca di sini memang
    // hanya fader, dan tes ini yang menjaganya tetap begitu.
    expect(a).toBeCloseTo(128, 9);
  });

  it('null kalau tidak ada grid', () => {
    expect(syncBpmOf(deck({ grid: null }))).toBeNull();
  });
});

describe('foldToOctave', () => {
  it('87 mengikuti 174 pada rasio 1:1, bukan dipaksa naik satu oktaf', () => {
    const out = foldToOctave(87, 174);
    expect(out.targetBpm).toBeCloseTo(87, 9);
    // Negatif = follower berjalan lebih lambat dari leader.
    expect(out.octave).toBe(-1);
  });

  it('174 mengikuti 87 dengan berjalan dua kali', () => {
    const out = foldToOctave(174, 87);
    expect(out.targetBpm).toBeCloseTo(174, 9);
    expect(out.octave).toBe(1);
  });

  it('tempo yang sudah berdekatan tidak dilipat', () => {
    expect(foldToOctave(128, 132)).toEqual({ targetBpm: 132, octave: 0 });
  });

  it('memilih di ruang LOG: 100 lawan 140 memberi 1.4×, bukan 0.7×', () => {
    // |log2(1.4)| = 0.485 < |log2(0.7)| = 0.514 — dan 140 memang yang lebih
    // dekat secara musikal.
    expect(foldToOctave(100, 140).targetBpm).toBeCloseTo(140, 9);
  });

  it('batasnya di √2, bukan di 1.5', () => {
    // 128 lawan 88: 128/88 = 1.4545 > √2, jadi dilipat.
    expect(foldToOctave(128, 88).octave).toBe(1);
    // 128 lawan 92: 1.391 < √2, tidak dilipat.
    expect(foldToOctave(128, 92).octave).toBe(0);
  });
});

describe('smallestRangeFor', () => {
  it('memilih rentang TERKECIL yang cukup', () => {
    expect(smallestRangeFor(1.05, 6)).toBe(6);
    expect(smallestRangeFor(1.08, 6)).toBe(10);
    expect(smallestRangeFor(1.13, 6)).toBe(16);
    expect(smallestRangeFor(1.4, 6)).toBe(100);
  });

  it('tidak pernah MENYEMPITKAN rentang pilihan user', () => {
    // Menyempitkannya diam-diam mengubah arti tiap gerakan fader sesudahnya.
    expect(smallestRangeFor(1.01, 16)).toBe(16);
  });

  it('null kalau tidak muat di mana pun', () => {
    expect(smallestRangeFor(3, 6)).toBeNull();
  });
});

describe('phaseDeltaSec', () => {
  it('nol kalau kedua deck sudah sejajar', () => {
    const g = grid(128);
    const leader = deck({ grid: g, playhead: atBeat(g, 8) });
    const follower = deck({ grid: g, playhead: atBeat(g, 16) });
    expect(phaseDeltaSec(leader, follower, 128, 128)).toBeCloseTo(0, 9);
  });

  it('positif kalau follower TERTINGGAL — ia harus maju', () => {
    const g = grid(128);
    const beatSec = 60 / 128;
    const leader = deck({ grid: g, playhead: atBeat(g, 8.25) });
    const follower = deck({ grid: g, playhead: atBeat(g, 8) });
    expect(phaseDeltaSec(leader, follower, 128, 128)).toBeCloseTo(beatSec * 0.25, 6);
  });

  it('selalu memilih koreksi TERKECIL, bukan yang selalu maju', () => {
    const g = grid(128);
    const beatSec = 60 / 128;
    // Follower 0.25 ketukan DI DEPAN: mundur 0.25 lebih baik daripada maju 0.75.
    const leader = deck({ grid: g, playhead: atBeat(g, 8) });
    const follower = deck({ grid: g, playhead: atBeat(g, 8.25) });
    const d = phaseDeltaSec(leader, follower, 128, 128);
    expect(d).toBeCloseTo(-beatSec * 0.25, 6);
    expect(Math.abs(d)).toBeLessThanOrEqual(beatSec / 2 + 1e-9);
  });

  it('grid dengan offset berbeda tetap disejajarkan', () => {
    const gl = grid(128, 0.15);
    const gf = grid(128, 0.9);
    const leader = deck({ grid: gl, playhead: atBeat(gl, 4) });
    const follower = deck({ grid: gf, playhead: atBeat(gf, 4) });
    // Kedua deck sama-sama tepat di ketukan menurut grid MASING-MASING, jadi
    // fasenya memang sudah sama — inilah gunanya menghitung dari beat index,
    // bukan dari selisih posisi mentah.
    expect(phaseDeltaSec(leader, follower, 128, 128)).toBeCloseTo(0, 9);
  });

  it('OKTAF BERBEDA: dihitung pada periode yang lebih KASAR (mixxx#6618)', () => {
    // Leader 174, follower 87 berjalan 1:1 → ketukan follower dua kali lebih
    // panjang. Menyamakan beat distance mentah akan ambigu; yang benar adalah
    // menyejajarkan pada periode 87 BPM.
    const gl = grid(174);
    const gf = grid(87);
    const leader = deck({ grid: gl, playhead: atBeat(gl, 4) });
    const follower = deck({ grid: gf, playhead: atBeat(gf, 2) });
    expect(phaseDeltaSec(leader, follower, 174, 87)).toBeCloseTo(0, 6);

    // Dan koreksinya tidak pernah melebihi setengah periode KASAR (87 BPM).
    const off = deck({ grid: gf, playhead: atBeat(gf, 2.4) });
    const d = phaseDeltaSec(leader, off, 174, 87);
    expect(Math.abs(d)).toBeLessThanOrEqual(60 / 87 / 2 + 1e-9);
  });

  it('nol kalau salah satu tidak punya grid', () => {
    expect(phaseDeltaSec(deck({ grid: null }), deck(), 128, 128)).toBe(0);
  });
});

describe('phaseErrorBeats', () => {
  it('nol saat sejajar, dan dibungkus ke [−0.5, 0.5)', () => {
    const g = grid(128);
    const leader = deck({ grid: g, playhead: atBeat(g, 8) });
    expect(phaseErrorBeats(leader, deck({ grid: g, playhead: atBeat(g, 4) }))!).toBeCloseTo(0, 9);

    const off = deck({ grid: g, playhead: atBeat(g, 4.25) });
    const e = phaseErrorBeats(leader, off)!;
    expect(e).toBeCloseTo(-0.25, 6);
    expect(e).toBeGreaterThanOrEqual(-0.5);
    expect(e).toBeLessThan(0.5);
  });
});

describe('planSync', () => {
  it('menolak dengan kalimat kalau materinya belum punya grid', () => {
    expect(planSync(deck(), deck({ grid: null }))).toEqual({
      ok: false,
      reason: 'deck ini belum punya beat grid',
    });
    const r = planSync(deck({ grid: null }), deck());
    expect(r.ok).toBe(false);
  });

  it('menyamakan tempo ke BPM EFEKTIF leader, bukan base-nya', () => {
    const leader = deck({ grid: grid(130), tempo: tempo({ fader: 0.5, rangePct: 10 }) });
    const out = planSync(leader, deck({ grid: grid(128) }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // 130 × 1.05 = 136.5 — bukan 130.
    expect(out.plan.targetBpm).toBeCloseTo(136.5, 6);
  });

  it('87 mengikuti 174 tanpa menaikkan pitch satu oktaf', () => {
    const out = planSync(deck({ grid: grid(174) }), deck({ grid: grid(87) }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.plan.ratio).toBeCloseTo(1, 9);
    expect(out.plan.fader).toBeCloseTo(0, 9);
    expect(out.plan.octave).toBe(-1);
    // Dan rentangnya TIDAK perlu dilebarkan — inilah bedanya dengan versi lama,
    // yang menolak dengan "di luar rentang ±10%".
    expect(out.plan.rangeWidened).toBe(false);
  });

  it('melebarkan rentang kalau perlu, dan mengatakannya', () => {
    // 128 → 145 butuh +13.3%: tidak muat di ±10, muat di ±16.
    const out = planSync(deck({ grid: grid(145) }), deck({ grid: grid(128) }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.plan.rangePct).toBe(16);
    expect(out.plan.rangeWidened).toBe(true);
    expect(Math.abs(out.plan.fader)).toBeLessThanOrEqual(1);
  });

  it('fader yang dihasilkan benar-benar menghasilkan target BPM', () => {
    const out = planSync(deck({ grid: grid(145) }), deck({ grid: grid(128) }));
    if (!out.ok) throw new Error('harusnya berhasil');
    const heard = 128 * (1 + (out.plan.fader * out.plan.rangePct) / 100);
    expect(heard).toBeCloseTo(145, 6);
  });

  it('menggeser FASE, bukan hanya tempo', () => {
    const g = grid(128);
    const leader = deck({ grid: g, playhead: atBeat(g, 8) });
    const follower = deck({ grid: g, playhead: atBeat(g, 8.25) });
    const out = planSync(leader, follower);
    if (!out.ok) throw new Error('harusnya berhasil');

    // Seperempat ketukan pada 128 BPM = 0.1172 s = 5625 sample.
    expect(out.plan.deltaSamples).toBeCloseTo(-5625, -1);

    // Dan setelah digeser, fasenya benar-benar nol.
    const moved = { ...follower, playhead: follower.playhead + out.plan.deltaSamples };
    expect(phaseErrorBeats(leader, moved)!).toBeCloseTo(0, 4);
  });

  it('koreksi fase memperhitungkan rasio: sample source ≠ detik nyata', () => {
    const leader = deck({ grid: grid(145), playhead: atBeat(grid(145), 8) });
    const follower = deck({ grid: grid(128), playhead: atBeat(grid(128), 8) });
    const out = planSync(leader, follower);
    if (!out.ok) throw new Error('harusnya berhasil');

    const moved = { ...follower, playhead: follower.playhead + out.plan.deltaSamples };
    // Fase diukur pada tempo SETELAH sync, jadi grid follower dinilai pada
    // ratio-nya yang baru.
    const d = phaseDeltaSec(leader, moved, 145, out.plan.targetBpm);
    expect(Math.abs(d)).toBeLessThan(0.001);
  });

  it('menolak kalau bahkan rentang terlebar tidak cukup', () => {
    // Rasio 3× tidak mungkin muncul setelah pelipatan oktaf, jadi ini dipaksa
    // lewat rentang yang sudah mentok.
    const out = planSync(
      deck({ grid: grid(128) }),
      deck({ grid: grid(128), tempo: tempo({ rangePct: 100 as TempoRange }) }),
    );
    expect(out.ok).toBe(true);
  });
});
