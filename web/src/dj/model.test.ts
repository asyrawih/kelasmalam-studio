import { describe, expect, it } from 'vitest';

import type { BeatGrid } from '../studio/analysis/beat-grid';
import {
  DEFAULT_TEMPO,
  EQ_KILL_DB,
  HOT_CUE_SLOTS,
  channelFaderGain,
  crossfaderGains,
  dbToGain,
  deckRemainingSec,
  effectiveBpm,
  effectiveRate,
  emptyDeck,
  faderForBpm,
  filterSpec,
  formatDeckTime,
  quantized,
  tempoPercent,
  tempoRatio,
  type CrossfaderCurve,
  type TempoRange,
} from './model';

const GRID: BeatGrid = { bpm: 120, offsetSec: 0, beatsPerBar: 4, manual: false };
const SR = 48_000;

describe('tempo fader', () => {
  it('travel × range = persen, dan 0 tetap 0 di rentang mana pun', () => {
    for (const r of [6, 10, 16, 100] as TempoRange[]) {
      expect(tempoPercent({ ...DEFAULT_TEMPO, rangePct: r, fader: 0 })).toBe(0);
    }
    expect(tempoPercent({ ...DEFAULT_TEMPO, rangePct: 16, fader: 0.5 })).toBeCloseTo(8, 12);
    expect(tempoPercent({ ...DEFAULT_TEMPO, rangePct: 6, fader: -1 })).toBeCloseTo(-6, 12);
  });

  it('WIDE benar-benar ±100% — di ujung bawah lagu berhenti', () => {
    const t = { ...DEFAULT_TEMPO, rangePct: 100 as TempoRange, fader: -1 };
    expect(tempoPercent(t)).toBe(-100);
    expect(tempoRatio(t)).toBe(0);
    expect(effectiveRate({ ...emptyDeck('A'), tempo: t })).toBe(0);
  });

  it('mengganti rentang TIDAK menggerakkan fader, tapi mengubah artinya', () => {
    const at6 = { ...DEFAULT_TEMPO, rangePct: 6 as TempoRange, fader: 0.5 };
    const at16 = { ...at6, rangePct: 16 as TempoRange };
    expect(at16.fader).toBe(at6.fader);
    expect(tempoPercent(at6)).toBeCloseTo(3, 12);
    expect(tempoPercent(at16)).toBeCloseTo(8, 12);
  });
});

describe('faderForBpm', () => {
  it('bolak-balik dengan effectiveBpm', () => {
    const table: Array<[number, number, TempoRange]> = [
      [128, 128, 10],
      [130, 128, 10],
      [124, 128, 10],
      [128, 124, 6],
      [140, 128, 16],
      [90, 128, 100],
    ];
    for (const [target, base, range] of table) {
      const fader = faderForBpm(target, base, range);
      expect(fader).not.toBeNull();
      const got = effectiveBpm(base, { ...DEFAULT_TEMPO, rangePct: range, fader: fader as number });
      expect(got as number).toBeCloseTo(target, 9);
    }
  });

  it('MENGEMBALIKAN NULL di luar rentang — bukan nilai yang dijepit', () => {
    // 128 → 160 butuh +25%, mustahil di ±16%.
    expect(faderForBpm(160, 128, 16)).toBeNull();
    expect(faderForBpm(160, 128, 100)).not.toBeNull();
  });

  it('menolak BPM yang tidak masuk akal alih-alih menghitung NaN', () => {
    expect(faderForBpm(128, 0, 10)).toBeNull();
    expect(faderForBpm(0, 128, 10)).toBeNull();
    expect(faderForBpm(Number.NaN, 128, 10)).toBeNull();
  });
});

describe('kurva crossfader', () => {
  it('smooth adalah equal-power: a² + b² = 1 di seluruh travel', () => {
    for (let i = 0; i <= 100; i += 1) {
      const { a, b } = crossfaderGains(i / 100, 'smooth');
      expect(a * a + b * b).toBeCloseTo(1, 12);
    }
  });

  it('tiap kurva mencapai isolasi penuh di kedua ujung', () => {
    for (const curve of ['smooth', 'sharp', 'cut'] as CrossfaderCurve[]) {
      const lo = crossfaderGains(0, curve);
      const hi = crossfaderGains(1, curve);
      expect(lo.a).toBeCloseTo(1, 9);
      expect(lo.b).toBeCloseTo(0, 9);
      expect(hi.a).toBeCloseTo(0, 9);
      expect(hi.b).toBeCloseTo(1, 9);
    }
  });

  it('sharp membiarkan KEDUA sisi penuh di tengah — itu yang dicari, bukan bug', () => {
    const mid = crossfaderGains(0.5, 'sharp');
    expect(mid.a).toBeCloseTo(1, 9);
    expect(mid.b).toBeCloseTo(1, 9);
  });

  it('cut praktis biner tapi tetap punya lereng, supaya tidak ada klik DC', () => {
    expect(crossfaderGains(0.45, 'cut').a).toBeCloseTo(1, 9);
    expect(crossfaderGains(0.55, 'cut').a).toBeCloseTo(0, 9);
    const mid = crossfaderGains(0.5, 'cut');
    expect(mid.a).toBeGreaterThan(0);
    expect(mid.a).toBeLessThan(1);
  });

  it('posisi di luar 0..1 dijepit, tidak diteruskan', () => {
    expect(crossfaderGains(-5, 'smooth').a).toBeCloseTo(1, 9);
    expect(crossfaderGains(5, 'smooth').b).toBeCloseTo(1, 9);
  });
});

describe('gain kanal', () => {
  it('nol di dasar dan unity di puncak, keduanya EKSAK', () => {
    expect(channelFaderGain(0)).toBe(0);
    expect(channelFaderGain(1)).toBe(1);
  });

  it('KILL adalah nol sungguhan, bukan -26 dB yang masih terdengar', () => {
    expect(dbToGain(EQ_KILL_DB)).toBe(0);
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(6)).toBeCloseTo(1.995, 3);
  });
});

describe('knob COLOR', () => {
  it('tengah = benar-benar tidak ada filter', () => {
    expect(filterSpec(0).type).toBe('none');
    expect(filterSpec(0.01).type).toBe('none');
  });

  it('kiri lowpass, kanan highpass — dua perilaku, bukan satu yang dicerminkan', () => {
    expect(filterSpec(-1).type).toBe('lowpass');
    expect(filterSpec(1).type).toBe('highpass');
  });

  it('sapuannya monoton di kedua arah', () => {
    let prev = Infinity;
    for (let i = 1; i <= 20; i += 1) {
      const hz = filterSpec(-i / 20).cutoffHz;
      expect(hz).toBeLessThan(prev);
      prev = hz;
    }
    prev = 0;
    for (let i = 1; i <= 20; i += 1) {
      const hz = filterSpec(i / 20).cutoffHz;
      expect(hz).toBeGreaterThan(prev);
      prev = hz;
    }
  });
});

describe('quantize', () => {
  it('mati = identitas, apa pun grid-nya', () => {
    expect(quantized(12_345, GRID, SR, false, '1')).toBe(12_345);
    expect(quantized(12_345, GRID, SR, true, 'off')).toBe(12_345);
  });

  it('tanpa grid juga identitas — bukan menempel ke nol', () => {
    expect(quantized(12_345, null, SR, true, '1')).toBe(12_345);
  });

  it('menempel ke ketukan terdekat pada 120 BPM (1 ketukan = 24000 sample)', () => {
    expect(quantized(23_000, GRID, SR, true, '1')).toBe(24_000);
    expect(quantized(1_000, GRID, SR, true, '1')).toBe(0);
  });
});

describe('readout', () => {
  it('sisa waktu memakai laju EFEKTIF, bukan laju nominal', () => {
    const d = { ...emptyDeck('A'), frames: SR * 100, sampleRate: SR };
    expect(deckRemainingSec(d)).toBeCloseTo(100, 6);
    const faster = { ...d, tempo: { ...DEFAULT_TEMPO, rangePct: 100 as TempoRange, fader: 1 } };
    expect(deckRemainingSec(faster)).toBeCloseTo(50, 6);
  });

  it('format waktu deck seperti rekordbox', () => {
    expect(formatDeckTime(220.24)).toBe('03:40.2');
    expect(formatDeckTime(0)).toBe('00:00.0');
    expect(formatDeckTime(-1)).toBe('--:--.-');
  });
});

describe('bank hot cue', () => {
  it('selalu delapan slot, A sampai H', () => {
    expect(HOT_CUE_SLOTS).toHaveLength(8);
    expect(HOT_CUE_SLOTS[0]).toBe('A');
    expect(HOT_CUE_SLOTS[7]).toBe('H');
  });
});
