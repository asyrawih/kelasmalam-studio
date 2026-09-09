/**
 * Tes matematika EQ parametrik: pemetaan posisi↔nilai (yang dipakai drag node),
 * clamping, hit-test, dan preset.
 *
 * Kenapa penting: semua bug "node melompat ke NaN" atau "kurva tidak sesuai
 * node" berasal dari salah satu pemetaan di bawah ini.
 */

import { describe, expect, it } from 'vitest';
import {
  EQ_MAX_GAIN_DB,
  EQ_MAX_HZ,
  EQ_MIN_HZ,
  EQ_PRESETS,
  clampEqBand,
  cloneEq,
  defaultEq,
  type EqBand,
} from '../model';
import {
  VIEW_MAX_HZ,
  VIEW_MIN_HZ,
  clampHz,
  coeffs,
  dbToY,
  formatHz,
  hitTestBand,
  logX,
  magnitudeDb,
  totalDb,
  xToHz,
  yToDb,
} from './eq-curve';

const SR = 48_000;

describe('pemetaan sumbu frekuensi', () => {
  it('x↔Hz bolak-balik tanpa kehilangan presisi', () => {
    for (const hz of [30, 90, 620, 3800, 11_000, 18_000]) {
      expect(xToHz(logX(hz))).toBeCloseTo(hz, 6);
    }
    for (const x of [0, 0.25, 0.5, 0.75, 1]) {
      expect(logX(xToHz(x))).toBeCloseTo(x, 9);
    }
  });

  it('ujung sumbu tepat di batas tampilan', () => {
    expect(xToHz(0)).toBeCloseTo(VIEW_MIN_HZ, 9);
    expect(xToHz(1)).toBeCloseTo(VIEW_MAX_HZ, 6);
  });

  it('skala logaritmik: tengah = rata-rata geometrik, bukan aritmetik', () => {
    expect(xToHz(0.5)).toBeCloseTo(Math.sqrt(VIEW_MIN_HZ * VIEW_MAX_HZ), 6);
  });
});

describe('pemetaan gain', () => {
  it('y↔dB bolak-balik, 0 dB di tengah', () => {
    const h = 160;
    expect(yToDb(dbToY(0, h), h)).toBeCloseTo(0, 9);
    expect(dbToY(0, h)).toBe(80);
    for (const db of [-12, -3, 0, 6, 17]) {
      expect(yToDb(dbToY(db, h), h)).toBeCloseTo(db, 9);
    }
  });

  it('gain di-clamp ±18 dB walau pointer keluar canvas', () => {
    const h = 160;
    expect(yToDb(-500, h)).toBe(EQ_MAX_GAIN_DB);
    expect(yToDb(9999, h)).toBe(-EQ_MAX_GAIN_DB);
  });
});

describe('clamp nilai band', () => {
  it('frekuensi terkurung 20 Hz–20 kHz', () => {
    expect(clampHz(1)).toBe(EQ_MIN_HZ);
    expect(clampHz(50_000)).toBe(EQ_MAX_HZ);
    expect(clampHz(440)).toBe(440);
  });

  it('clampEqBand menolak NaN — biquad dengan freq NaN mematikan lane', () => {
    const bad: EqBand = {
      id: 'mid',
      label: 'MID',
      color: '#fff',
      kind: 'peaking',
      freq: Number.NaN,
      q: Number.NaN,
      gainDb: Number.NaN,
    };
    const fixed = clampEqBand(bad);
    expect(Number.isFinite(fixed.freq)).toBe(true);
    expect(Number.isFinite(fixed.q)).toBe(true);
    expect(fixed.gainDb).toBe(0);
  });

  it('gain di luar rentang dipangkas', () => {
    const b = defaultEq().bands[0]!;
    expect(clampEqBand({ ...b, gainDb: 99 }).gainDb).toBe(EQ_MAX_GAIN_DB);
    expect(clampEqBand({ ...b, gainDb: -99 }).gainDb).toBe(-EQ_MAX_GAIN_DB);
  });
});

describe('hit-test node', () => {
  const bands = defaultEq().bands;
  const W = 400;
  const H = 160;

  it('mengenai node yang tepat di bawah pointer', () => {
    bands.forEach((b, i) => {
      expect(hitTestBand(bands, logX(b.freq) * W, dbToY(b.gainDb, H), W, H)).toBe(i);
    });
  });

  it('meleset jauh = tidak ada node', () => {
    expect(hitTestBand(bands, 0, 0, W, H)).toBe(-1);
  });

  it('ukuran 0×0 tidak menghasilkan NaN atau hit palsu', () => {
    expect(hitTestBand(bands, 0, 0, 0, 0)).toBe(-1);
  });
});

describe('respons biquad', () => {
  it('gain 0 dB praktis transparan', () => {
    const b = defaultEq().bands[1]!;
    expect(magnitudeDb(coeffs(b, SR), b.freq, SR)).toBeCloseTo(0, 6);
  });

  it('peaking memberi gain persis di frekuensi tengahnya', () => {
    const b: EqBand = { ...defaultEq().bands[1]!, gainDb: 6 };
    expect(magnitudeDb(coeffs(b, SR), b.freq, SR)).toBeCloseTo(6, 1);
  });

  it('kurva gabungan = jumlah dB tiap band', () => {
    const bands = defaultEq().bands.map((b, i) => ({ ...b, gainDb: i === 0 ? 6 : 3 }));
    const cs = bands.map((b) => coeffs(b, SR));
    const hz = 1000;
    const sum = cs.reduce((a, c) => a + magnitudeDb(c, hz, SR), 0);
    expect(totalDb(cs, hz, SR)).toBeCloseTo(sum, 9);
  });

  it('EQ flat menghasilkan kurva rata di seluruh rentang', () => {
    const cs = EQ_PRESETS.FLAT.bands.map((b) => coeffs(b, SR));
    for (const hz of [50, 500, 5000, 15_000]) {
      expect(totalDb(cs, hz, SR)).toBeCloseTo(0, 6);
    }
  });
});

describe('preset EQ', () => {
  it('FLAT nol semua', () => {
    expect(EQ_PRESETS.FLAT.bands.every((b) => b.gainDb === 0)).toBe(true);
  });

  it('setiap preset punya 4 band dengan id yang sama', () => {
    const ids = ['low', 'mid', 'pres', 'air'];
    for (const p of Object.values(EQ_PRESETS)) {
      expect(p.bands.map((b) => b.id)).toEqual(ids);
      for (const b of p.bands) {
        expect(clampEqBand(b)).toEqual(b); // semua nilai preset sudah sah
      }
    }
  });

  it('BASS menaikkan low, CLUB menaikkan low dan air', () => {
    const gain = (p: keyof typeof EQ_PRESETS, id: string): number =>
      EQ_PRESETS[p].bands.find((b) => b.id === id)!.gainDb;
    expect(gain('BASS', 'low')).toBeGreaterThan(0);
    expect(gain('CLUB', 'low')).toBeGreaterThan(0);
    expect(gain('CLUB', 'air')).toBeGreaterThan(0);
    expect(gain('VOCAL', 'pres')).toBeGreaterThan(0);
  });

  it('cloneEq benar-benar salinan dalam — dua lane tidak berbagi band', () => {
    const a = cloneEq(EQ_PRESETS.CLUB);
    a.bands[0]!.gainDb = -99;
    expect(EQ_PRESETS.CLUB.bands[0]!.gainDb).not.toBe(-99);
    expect(defaultEq().bands[0]).not.toBe(defaultEq().bands[0]);
  });
});

describe('formatHz', () => {
  it('menampilkan kHz di atas 1000', () => {
    expect(formatHz(90)).toBe('90 Hz');
    expect(formatHz(3800)).toBe('3.80 kHz');
    expect(formatHz(11_000)).toBe('11.0 kHz');
  });
});
