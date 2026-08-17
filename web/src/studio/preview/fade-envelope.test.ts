/**
 * Otomasi gain clip. Web Audio tidak ada di jsdom, jadi `GainNode` dipalsukan
 * seminimal mungkin: yang diperiksa adalah KURVA apa yang dijadwalkan, kapan,
 * dan selama berapa lama — bukan bunyinya.
 */
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_FADE_CURVE, type StudioClip } from '../model';
import { applyClipGainEnvelope } from './audio-preview';

const SR = 48_000;

function fakeGain() {
  const g = {
    setValueAtTime: vi.fn(),
    setValueCurveAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn(),
    value: 1,
  };
  return { node: { gain: g } as unknown as GainNode, g };
}

function clip(over: Partial<StudioClip> = {}): StudioClip {
  return {
    id: 'c',
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

const timing = (over: Partial<Parameters<typeof applyClipGainEnvelope>[2]> = {}) => ({
  startAt: 100,
  wallDurationSec: 10,
  transportSpeed: 1,
  clipElapsedSec: 0,
  ...over,
});

describe('applyClipGainEnvelope', () => {
  it('fade dijadwalkan sebagai kurva, bukan ramp lurus', () => {
    const { node, g } = fakeGain();
    applyClipGainEnvelope(node, clip({ fadeInMs: 4000 }), timing());
    expect(g.linearRampToValueAtTime).not.toHaveBeenCalled();
    const [curve, at, dur] = g.setValueCurveAtTime.mock.calls[0]!;
    expect(at).toBe(100);
    expect(dur).toBeCloseTo(4, 6);
    expect((curve as Float32Array)[0]).toBe(0);
    // Equal-power: setengah jalan ≈0.707, bukan 0.5.
    expect((curve as Float32Array)[63]).toBeGreaterThan(0.68);
  });

  it('mulai di TENGAH fade-in melanjutkan dari gain saat itu', () => {
    const { node, g } = fakeGain();
    applyClipGainEnvelope(node, clip({ fadeInMs: 4000 }), timing({ clipElapsedSec: 2 }));
    const [curve, , dur] = g.setValueCurveAtTime.mock.calls[0]!;
    expect(dur).toBeCloseTo(2, 6); // sisa fade, bukan 4 detik penuh
    expect((curve as Float32Array)[0]).toBeCloseTo(Math.SQRT1_2, 5); // bukan 0
  });

  it('durasi fade dibagi kecepatan transport (jam dinding)', () => {
    const { node, g } = fakeGain();
    applyClipGainEnvelope(
      node,
      clip({ fadeInMs: 4000 }),
      timing({ transportSpeed: 2, wallDurationSec: 5 }),
    );
    expect(g.setValueCurveAtTime.mock.calls[0]![2]).toBeCloseTo(2, 6);
  });

  it('fade out dijadwalkan di ujung clip dan berakhir di nol', () => {
    const { node, g } = fakeGain();
    applyClipGainEnvelope(node, clip({ fadeOutMs: 3000 }), timing());
    const [curve, at, dur] = g.setValueCurveAtTime.mock.calls[0]!;
    expect(at).toBeCloseTo(107, 6);
    expect(dur).toBeCloseTo(3, 6);
    const c = curve as Float32Array;
    expect(c[0]).toBeCloseTo(1, 6);
    expect(c[c.length - 1]).toBe(0);
  });

  it('mulai di TENGAH fade-out tidak mengulang dari gain penuh', () => {
    const { node, g } = fakeGain();
    // Clip 10 s dengan fade-out 4 s, playhead sudah 8 s → sisa 2 s fade.
    applyClipGainEnvelope(
      node,
      clip({ fadeOutMs: 4000 }),
      timing({ wallDurationSec: 2, clipElapsedSec: 8 }),
    );
    const [curve, , dur] = g.setValueCurveAtTime.mock.calls[0]!;
    expect(dur).toBeCloseTo(2, 6);
    expect((curve as Float32Array)[0]).toBeCloseTo(Math.SQRT1_2, 5);
  });

  it('linear tetap linear', () => {
    const { node, g } = fakeGain();
    applyClipGainEnvelope(node, clip({ fadeInMs: 4000, fadeCurve: 'linear' }), timing());
    const c = g.setValueCurveAtTime.mock.calls[0]![0] as Float32Array;
    expect(c[63]).toBeCloseTo(63 / 127, 5);
  });

  it('tanpa fade, gain dipasang sekali dan tidak ada kurva', () => {
    const { node, g } = fakeGain();
    applyClipGainEnvelope(node, clip({ gainDb: -6 }), timing());
    expect(g.setValueCurveAtTime).not.toHaveBeenCalled();
    expect(g.setValueAtTime).toHaveBeenCalledWith(expect.closeTo(0.5012, 3), 100);
  });

  it('fade in + fade out yang bersentuhan tidak menjadwalkan rentang tumpang tindih', () => {
    const { node, g } = fakeGain();
    applyClipGainEnvelope(node, clip({ fadeInMs: 5000, fadeOutMs: 5000 }), timing());
    const calls = g.setValueCurveAtTime.mock.calls as [Float32Array, number, number][];
    expect(calls.length).toBe(2);
    const [, at0, dur0] = calls[0]!;
    const [, at1] = calls[1]!;
    expect(at0 + dur0).toBeLessThanOrEqual(at1 + 1e-9);
  });
});
