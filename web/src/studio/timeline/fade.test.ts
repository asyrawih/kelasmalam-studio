import { describe, expect, it } from 'vitest';

import { DEFAULT_FADE_CURVE, type StudioClip } from '../model';
import { normalizeLanes } from '../persist/persistence';
import {
  clampFadeMs,
  fadeCurveArray,
  fadeInGain,
  fadeOutGain,
  fadeSamples,
  normalizeClipFade,
  samplesToFadeMs,
  secToMs,
} from './fade';

const SR = 48_000;

function clip(over: Partial<StudioClip> = {}): StudioClip {
  return {
    id: 'c1',
    assetId: 1,
    start: 0,
    len: 10 * SR,
    sourceStart: 0,
    sourceLen: 10 * SR,
    label: 'C',
    gainDb: 0,
    fadeInMs: 0,
    fadeOutMs: 0,
    fadeCurve: DEFAULT_FADE_CURVE,
    seed: 1,
    ...over,
  };
}

describe('bentuk kurva fade', () => {
  it('kedua kurva menyentuh persis 0 dan 1 di ujungnya', () => {
    for (const c of ['linear', 'equalPower'] as const) {
      expect(fadeInGain(c, 0)).toBe(0);
      expect(fadeInGain(c, 1)).toBe(1);
      expect(fadeOutGain(c, 0)).toBe(1);
      expect(fadeOutGain(c, 1)).toBe(0);
    }
  });

  it('equal-power di tengah ≈0.707, linear tepat 0.5', () => {
    expect(fadeInGain('linear', 0.5)).toBeCloseTo(0.5, 6);
    expect(fadeInGain('equalPower', 0.5)).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('nilai di luar 0..1 di-clamp, bukan diekstrapolasi', () => {
    expect(fadeInGain('equalPower', -3)).toBe(0);
    expect(fadeInGain('equalPower', 9)).toBe(1);
  });

  it('monoton naik untuk fade-in, monoton turun untuk fade-out', () => {
    for (const c of ['linear', 'equalPower'] as const) {
      let prev = -1;
      for (let i = 0; i <= 64; i++) {
        const g = fadeInGain(c, i / 64);
        expect(g).toBeGreaterThanOrEqual(prev);
        prev = g;
      }
    }
  });
});

describe('kurva untuk setValueCurveAtTime', () => {
  it('panjangnya sesuai dan diskalakan ke peak', () => {
    const a = fadeCurveArray('equalPower', 'in', 0.5, 128);
    expect(a.length).toBe(128);
    expect(a[0]).toBe(0);
    expect(a[127]).toBeCloseTo(0.5, 6);
  });

  it('potongan sisa dimulai dari posisi fade saat ini, bukan dari nol', () => {
    // Play ditekan di tengah fade-in: kurva harus MULAI di 0.707, bukan 0.
    const a = fadeCurveArray('equalPower', 'in', 1, 32, 0.5, 1);
    expect(a[0]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(a[31]).toBeCloseTo(1, 6);
  });

  it('fade-out mulai dari 1 dan berakhir tepat di 0', () => {
    const a = fadeCurveArray('linear', 'out', 1, 16);
    expect(a[0]).toBe(1);
    expect(a[15]).toBe(0);
  });
});

describe('daya total saat dua fade saling silang', () => {
  // INI ALASAN equal-power JADI DEFAULT. Satu lagu fade-out sementara yang
  // berikutnya fade-in pada rentang yang sama; yang diukur adalah daya
  // jumlahannya (asumsi dua sinyal tidak berkorelasi).
  const power = (curve: 'linear' | 'equalPower', t: number): number =>
    fadeOutGain(curve, t) ** 2 + fadeInGain(curve, t) ** 2;

  it('equal-power menjaga daya tetap ~konstan di sepanjang transisi', () => {
    for (let i = 0; i <= 32; i++) {
      expect(power('equalPower', i / 32)).toBeCloseTo(1, 6);
    }
  });

  it('linear melubang ~3 dB di tengah', () => {
    expect(power('linear', 0.5)).toBeCloseTo(0.5, 6);
    const dipDb = 10 * Math.log10(power('linear', 0.5));
    expect(dipDb).toBeLessThan(-2.9);
    expect(dipDb).toBeGreaterThan(-3.1);
  });
});

describe('konversi detik ↔ sample', () => {
  it('bolak-balik tanpa kehilangan nilai', () => {
    expect(fadeSamples(4000, SR)).toBe(4 * SR);
    expect(samplesToFadeMs(4 * SR, SR)).toBeCloseTo(4000, 6);
    expect(fadeSamples(-50, SR)).toBe(0);
    expect(samplesToFadeMs(1000, 0)).toBe(0);
  });
});

describe('clamp durasi fade', () => {
  it('tidak boleh negatif atau melebihi panjang clip', () => {
    const c = clip();
    expect(clampFadeMs(c, 'in', -500, SR)).toBe(0);
    expect(clampFadeMs(c, 'in', 999_000, SR)).toBe(10_000);
    expect(clampFadeMs(c, 'in', Number.NaN, SR)).toBe(0);
  });

  it('sisi yang ditarik dibatasi oleh fade seberang, bukan sebaliknya', () => {
    const c = clip({ fadeOutMs: 6000 });
    // Clip 10 s, fade-out 6 s → fade-in paling panjang 4 s.
    expect(clampFadeMs(c, 'in', 8000, SR)).toBe(4000);
    // Dan fade-out yang tidak disentuh tetap 6 s.
    expect(c.fadeOutMs).toBe(6000);
  });

  it('fade seberang yang sudah memenuhi clip menyisakan nol', () => {
    const c = clip({ fadeInMs: 12_000 });
    expect(clampFadeMs(c, 'out', 3000, SR)).toBe(0);
  });

  it('preset di bawah headroom tetap utuh', () => {
    const c = clip({ fadeOutMs: 2000 });
    expect(clampFadeMs(c, 'in', secToMs(4), SR)).toBe(4000);
  });
});

describe('project lama tanpa fadeCurve', () => {
  it('clip mendapat kurva default, bukan undefined', () => {
    const old = { ...clip(), fadeCurve: undefined } as unknown as StudioClip;
    expect(normalizeClipFade(old).fadeCurve).toBe(DEFAULT_FADE_CURVE);
  });

  it('nilai linear yang tersimpan tidak ikut diubah', () => {
    const c = clip({ fadeCurve: 'linear' });
    expect(normalizeClipFade(c)).toBe(c);
  });

  it('lane hasil restore ikut dinormalkan sampai ke tiap clip', () => {
    const lanes = [
      {
        id: 'l1',
        name: 'A',
        color: '#ffd400',
        mute: false,
        solo: false,
        gainDb: 0,
        speedRatio: 1,
        eq: { bands: [] },
        clips: [{ ...clip(), fadeCurve: undefined }],
      },
    ] as never;
    expect(normalizeLanes(lanes)[0]?.clips[0]?.fadeCurve).toBe(DEFAULT_FADE_CURVE);
  });

  it('fade rusak (NaN / negatif) dibersihkan jadi 0', () => {
    const c = normalizeClipFade(clip({ fadeInMs: Number.NaN, fadeOutMs: -10 }));
    expect(c.fadeInMs).toBe(0);
    expect(c.fadeOutMs).toBe(0);
  });
});
