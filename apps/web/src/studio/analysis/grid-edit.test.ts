import { describe, expect, it } from 'vitest';

import type { StudioAsset } from '../store';
import { BEATS_PER_BAR, MAX_GRID_BPM, MIN_GRID_BPM, resolveBeatGrid } from './beat-grid';
import {
  MIN_FIT_BARS,
  WIDEN_STEP_SEC,
  barsBetween,
  currentBpm,
  fitBpmToPoint,
  nearestBarSec,
  nudgeAnchor,
  rawAnchorSec,
  setBpm,
  setDownbeatAt,
  shiftOctave,
  widenBeat,
} from './grid-edit';

const SR = 48_000;

function asset(over: Partial<StudioAsset> = {}): StudioAsset {
  return {
    id: 1,
    name: 'a',
    contentHash: '',
    envelope: { levels: [], frames: 0 } as unknown as StudioAsset['envelope'],
    frames: 360 * SR,
    sampleRate: SR,
    tempo: { bpm: 128, confidence: 0.9, beatOffsetSec: 0.15 },
    tempoPending: false,
    tempoOctave: 0,
    bpmOverride: null,
    beatOffsetOverride: null,
    analysisLock: false,
    ...over,
  };
}

/**
 * Apakah `atSec` duduk di sebuah garis BAR menurut grid yang sudah dinormalkan
 * `resolveBeatGrid`? Ini pertanyaan yang sebenarnya di seluruh berkas ini —
 * membandingkan `offsetSec` mentah tidak membuktikan apa pun, karena grid itu
 * periodik dan dua angka yang berbeda bisa menghasilkan grid yang sama.
 */
function barPhaseErrorSec(a: StudioAsset, atSec: number): number {
  const g = resolveBeatGrid(a);
  if (g === null) return Number.POSITIVE_INFINITY;
  const barSec = (60 / g.bpm) * g.beatsPerBar;
  const phase = (((atSec - g.offsetSec) % barSec) + barSec) % barSec;
  return Math.min(phase, barSec - phase);
}

describe('rawAnchorSec — jebakan 1 di kepala berkas', () => {
  it('mengembalikan anchor MENTAH, bukan yang sudah dinormalkan ke satu bar', () => {
    const a = asset({ beatOffsetOverride: 180 });
    expect(rawAnchorSec(a)).toBe(180);
    // Yang dibaca penggambar memang sudah dinormalkan — dan justru karena itu
    // ia tidak boleh dipakai sebagai pivot.
    expect(resolveBeatGrid(a)!.offsetSec).toBeLessThan(2);
  });

  it('urutannya sama dengan resolveBeatGrid: override → deteksi → nol', () => {
    expect(rawAnchorSec(asset())).toBe(0.15);
    expect(rawAnchorSec(asset({ tempo: null }))).toBe(0);
    expect(rawAnchorSec(undefined)).toBe(0);
  });
});

describe('setDownbeatAt', () => {
  it('anchor disimpan apa adanya, tidak dinormalkan', () => {
    expect(setDownbeatAt(180.25)).toEqual({ offsetSec: 180.25 });
  });

  it('titik yang ditunjuk benar-benar jadi garis bar', () => {
    const a = asset({ beatOffsetOverride: setDownbeatAt(93.7).offsetSec ?? 0 });
    expect(barPhaseErrorSec(a, 93.7)).toBeLessThan(1e-9);
  });
});

describe('anchor tetap diam saat BPM diubah — inti seluruh berkas ini', () => {
  const ANCHOR = 180;

  it.each([
    ['setBpm', setBpm(131.5, ANCHOR)],
    ['widenBeat', widenBeat(128, WIDEN_STEP_SEC, ANCHOR)],
    ['shiftOctave ×2', shiftOctave(128, 1, ANCHOR)],
    ['shiftOctave ÷2', shiftOctave(128, -1, ANCHOR)],
  ])('%s tidak memindahkan garis bar di anchor', (_name, patch) => {
    const a = asset({
      bpmOverride: patch.bpm ?? null,
      beatOffsetOverride: patch.offsetSec ?? null,
    });
    expect(barPhaseErrorSec(a, ANCHOR)).toBeLessThan(1e-9);
  });

  it('tapi memang MEMINDAHKAN garis yang jauh dari anchor', () => {
    const before = asset({ bpmOverride: 128, beatOffsetOverride: ANCHOR });
    const patch = setBpm(131.5, ANCHOR);
    const after = asset({
      bpmOverride: patch.bpm ?? null,
      beatOffsetOverride: patch.offsetSec ?? null,
    });
    expect(barPhaseErrorSec(before, ANCHOR + 60)).toBeLessThan(1e-9);
    expect(barPhaseErrorSec(after, ANCHOR + 60)).toBeGreaterThan(0.01);
  });
});

describe('setBpm', () => {
  it('menulis anchor walau nilainya tidak berubah — mengunci offset jadi keputusan user', () => {
    expect(setBpm(130, 0.15)).toEqual({ bpm: 130, offsetSec: 0.15 });
  });

  it('dibatasi ke rentang grid', () => {
    expect(setBpm(9999, 0).bpm).toBe(MAX_GRID_BPM);
    expect(setBpm(0.5, 0).bpm).toBe(MIN_GRID_BPM);
  });
});

describe('nudgeAnchor', () => {
  it('menggeser anchor tanpa menyentuh BPM', () => {
    expect(nudgeAnchor(0.15, 0.001)).toEqual({ offsetSec: 0.151 });
    expect(nudgeAnchor(0.15, -0.001).offsetSec).toBeCloseTo(0.149, 12);
  });

  it('melewati nol tetap menghasilkan grid yang sah', () => {
    const a = asset({
      bpmOverride: 128,
      beatOffsetOverride: nudgeAnchor(0.001, -0.01).offsetSec ?? 0,
    });
    const g = resolveBeatGrid(a);
    expect(g).not.toBeNull();
    expect(g!.offsetSec).toBeGreaterThanOrEqual(0);
    expect(g!.offsetSec).toBeLessThan((60 / 128) * BEATS_PER_BAR);
  });
});

describe('widenBeat', () => {
  it('positif = lebih renggang = BPM turun', () => {
    // 128 BPM → ketukan 468.75 ms. +1 ms → 469.75 ms → 127.7275 BPM.
    expect(widenBeat(128, 0.001, 0).bpm).toBeCloseTo(127.7275, 3);
    expect(widenBeat(128, -0.001, 0).bpm).toBeCloseTo(128.2737, 3);
  });

  it('satu langkah 1 ms pada 128 BPM ≈ 0.27 BPM — jauh di atas anggaran ±0.0089', () => {
    // Tes ini yang membenarkan keberadaan `fitBpmToPoint`. Kalau suatu saat
    // angkanya berubah, klaim di kepala fungsi itu ikut harus ditinjau.
    const delta = Math.abs(128 - (widenBeat(128, 0.001, 0).bpm ?? 0));
    expect(delta).toBeGreaterThan(0.25);
    expect(delta).toBeLessThan(0.3);
  });

  it('tidak pernah membalik tanda panjang ketukan', () => {
    // Pada BPM maksimum, ketukan hanya 200 ms; langkah −1 detik menembus nol.
    const out = widenBeat(MAX_GRID_BPM, -1, 0);
    expect(out.bpm).toBeGreaterThan(0);
    expect(out.bpm).toBeLessThanOrEqual(MAX_GRID_BPM);
  });
});

describe('shiftOctave', () => {
  it('menggandakan dan membagi dua', () => {
    expect(shiftOctave(85, 1, 0).bpm).toBe(170);
    expect(shiftOctave(170, -1, 0).bpm).toBe(85);
  });

  it('dibatasi, tidak dibiarkan menembus rentang', () => {
    expect(shiftOctave(200, 1, 0).bpm).toBe(MAX_GRID_BPM);
  });
});

describe('fitBpmToPoint — kunci-dua-titik', () => {
  it('memulihkan BPM sebenarnya dari grid yang meleset', () => {
    // Lagu 128.000 BPM, downbeat di 0.15 s. Detektor memberi 128.3 — meleset
    // 0.3 BPM, cukup untuk merayap keluar transien dalam satu menit.
    const anchor = 0.15;
    const trueBpm = 128;
    // Downbeat sungguhan di bar ke-64 (≈ 2 menit).
    const t2 = anchor + (60 / trueBpm) * BEATS_PER_BAR * 64;

    const out = fitBpmToPoint(anchor, 128.3, t2);
    expect(out).not.toBeNull();
    expect(out!.bpm!).toBeCloseTo(trueBpm, 6);
  });

  it('titik kedua meleset 10 ms pada jarak 300 s tetap di dalam anggaran ±0.0089 BPM', () => {
    // Ini klaim inti dokumen recordbox/06 §3, dikunci sebagai tes.
    const anchor = 0;
    const trueBpm = 128;
    const barSec = (60 / trueBpm) * BEATS_PER_BAR;
    const bars = Math.round(300 / barSec);
    const t2 = bars * barSec + 0.01; // tangan meleset 10 ms

    const out = fitBpmToPoint(anchor, trueBpm, t2);
    expect(out).not.toBeNull();
    expect(Math.abs((out!.bpm ?? 0) - trueBpm)).toBeLessThan(0.0089);
  });

  it('kedua ujung lagu duduk di garis bar setelah dikunci', () => {
    const anchor = 0.15;
    const trueBpm = 128;
    const t2 = anchor + (60 / trueBpm) * BEATS_PER_BAR * 64;
    const out = fitBpmToPoint(anchor, 128.3, t2)!;
    const a = asset({
      bpmOverride: out.bpm ?? null,
      beatOffsetOverride: out.offsetSec ?? null,
    });

    expect(barPhaseErrorSec(a, anchor)).toBeLessThan(1e-6);
    expect(barPhaseErrorSec(a, t2)).toBeLessThan(1e-6);
  });

  it('menolak jarak yang lebih pendek dari MIN_FIT_BARS', () => {
    const barSec = (60 / 128) * BEATS_PER_BAR;
    expect(fitBpmToPoint(0, 128, barSec * (MIN_FIT_BARS - 1))).toBeNull();
    expect(fitBpmToPoint(0, 128, barSec * MIN_FIT_BARS)).not.toBeNull();
  });

  it('titik kedua boleh berada SEBELUM anchor', () => {
    const barSec = (60 / 128) * BEATS_PER_BAR;
    const out = fitBpmToPoint(200, 128, 200 - barSec * 32);
    expect(out).not.toBeNull();
    expect(out!.bpm!).toBeCloseTo(128, 6);
  });

  it('null pada masukan yang tidak berhingga', () => {
    expect(fitBpmToPoint(0, 128, Number.NaN)).toBeNull();
  });
});

describe('barsBetween / nearestBarSec', () => {
  it('barsBetween menampilkan pecahan — petunjuk bahwa titiknya belum di downbeat', () => {
    const barSec = (60 / 128) * BEATS_PER_BAR;
    expect(barsBetween(0, 128, barSec * 8)).toBeCloseTo(8, 9);
    expect(barsBetween(0, 128, barSec * 8.5)).toBeCloseTo(8.5, 9);
  });

  it('nearestBarSec menempel ke garis bar terdekat, bukan ke ketukan', () => {
    const barSec = (60 / 128) * BEATS_PER_BAR;
    expect(nearestBarSec(0, 128, barSec * 8 + 0.05)).toBeCloseTo(barSec * 8, 9);
    expect(nearestBarSec(0, 128, barSec * 8 - 0.05)).toBeCloseTo(barSec * 8, 9);
  });
});

describe('currentBpm', () => {
  it('override menang atas deteksi', () => {
    expect(currentBpm(asset({ bpmOverride: 140 }))).toBe(140);
  });

  it('koreksi oktaf ikut terbaca', () => {
    expect(currentBpm(asset({ tempoOctave: -1 }))).toBe(64);
  });

  it('null hanya kalau memang tidak ada jawabannya', () => {
    expect(currentBpm(asset({ tempo: null }))).toBeNull();
    expect(currentBpm(undefined)).toBeNull();
  });
});
