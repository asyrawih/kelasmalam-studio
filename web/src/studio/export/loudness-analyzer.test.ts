import { describe, expect, it } from 'vitest';

import {
  LoudnessAnalyzer,
  applyGain,
  assessRobloxSafe,
  type LoudnessAnalysis,
} from './loudness-analyzer';

const SR = 48_000;

function sine(amplitude: number, seconds = 2): [Float32Array, Float32Array] {
  const n = Math.round(seconds * SR);
  const l = Float32Array.from({ length: n }, (_, i) => amplitude * Math.sin((2 * Math.PI * 1000 * i) / SR));
  return [l, l.slice()];
}

function analyze(channels: [Float32Array, Float32Array], chunks = 1): LoudnessAnalysis {
  const a = new LoudnessAnalyzer(SR);
  const size = Math.ceil(channels[0].length / chunks);
  for (let at = 0; at < channels[0].length; at += size) {
    a.push(channels[0].subarray(at, at + size), channels[1].subarray(at, at + size));
  }
  return a.finish();
}

describe('LoudnessAnalyzer', () => {
  it('silence tidak dipalsukan sebagai angka loudness', () => {
    const z = new Float32Array(SR);
    const r = analyze([z, z]);
    expect(r.integratedLufs).toBeNull();
    expect(r.truePeakDbtp).toBeNull();
    expect(r.clippedSamples).toBe(0);
  });

  it('hasil tidak bergantung pada batas chunk render', () => {
    const audio = sine(0.2, 3);
    const whole = analyze(audio, 1);
    const chunked = analyze(audio, 37);
    expect(chunked.integratedLufs).toBeCloseTo(whole.integratedLufs!, 8);
    expect(chunked.truePeakDbtp).toBeCloseTo(whole.truePeakDbtp!, 8);
  });

  it('mendeteksi sample clipping pada kedua channel', () => {
    const l = new Float32Array([0, 1, -1.1, 0]);
    const r = new Float32Array([0, 0.5, 1.2, 0]);
    const r0 = analyze([l, r]);
    expect(r0.clippedSamples).toBe(3);
    expect(r0.samplePeakDbfs).toBeGreaterThan(0);
  });

  it('gain -6 dB menurunkan sample sekitar separuh', () => {
    const channels: [Float32Array, Float32Array] = [new Float32Array([1]), new Float32Array([-1])];
    applyGain(channels, -6.020599913);
    expect(channels[0][0]).toBeCloseTo(0.5, 5);
    expect(channels[1][0]).toBeCloseTo(-0.5, 5);
  });
});

describe('preset Roblox Safe', () => {
  const report = (over: Partial<LoudnessAnalysis>): LoudnessAnalysis => ({
    integratedLufs: -16,
    truePeakDbtp: -3,
    samplePeakDbfs: -3.2,
    clippedSamples: 0,
    crestFactorDb: 9,
    frames: SR,
    durationSec: 1,
    ...over,
  });

  it('lulus pada -16 LUFS, peak di bawah -2, dan nol clipping', () => {
    expect(assessRobloxSafe(report({})).safe).toBe(true);
  });

  it('gain rekomendasi dibatasi oleh true peak, bukan memaksa -16 LUFS', () => {
    const a = assessRobloxSafe(report({ integratedLufs: -20, truePeakDbtp: -3 }));
    expect(a.recommendedGainDb).toBeCloseTo(1, 6);
  });

  it('clipping selalu gagal walau LUFS dan peak tampak aman', () => {
    expect(assessRobloxSafe(report({ clippedSamples: 1 })).safe).toBe(false);
  });
});
