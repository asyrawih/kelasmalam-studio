import { describe, expect, it } from 'vitest';

import { DEFAULT_FADE_CURVE, defaultEq, type StudioClip, type StudioLane } from '../model';
import type { StudioAsset } from '../store';
import { computeClipSync } from './beat-sync';

const SR = 48_000;

function clip(id: string, assetId: number, startSec = 0): StudioClip {
  return {
    id, assetId, start: startSec * SR, len: 30 * SR, sourceStart: 0, sourceLen: 30 * SR,
    label: id, gainDb: 0, fadeInMs: 0, fadeOutMs: 0, fadeCurve: DEFAULT_FADE_CURVE,
    seed: 1, chain: [],
  };
}

function lane(id: string, speedRatio = 1): StudioLane {
  return { id, name: id, color: '#fff', mute: false, solo: false, gainDb: 0,
    chain: [], speedRatio, eq: defaultEq(), clips: [] };
}

function asset(id: number, bpm: number, offsetSec = 0): StudioAsset {
  return {
    id, name: String(id), contentHash: '', envelope: { levels: [], frames: 0 },
    frames: 60 * SR, sampleRate: SR, tempo: { bpm, confidence: 1, beatOffsetSec: offsetSec },
    tempoPending: false, tempoOctave: 0, bpmOverride: null, beatOffsetOverride: null,
    analysisLock: false,
  };
}

const base = {
  targetClip: clip('target', 1), targetLane: lane('target-lane'), targetAsset: asset(1, 120),
  referenceClip: clip('master', 2), referenceLane: lane('master-lane'), referenceAsset: asset(2, 128),
  playhead: 5 * SR, sampleRate: SR,
} as const;

describe('computeClipSync', () => {
  it('tempo sync menghitung ratio tanpa memindahkan clip', () => {
    const out = computeClipSync({ ...base, alignment: 'tempo' })!;
    expect(out.laneSpeedRatio).toBeCloseTo(128 / 120);
    expect(out.targetStart).toBe(0);
  });

  it('beat sync menyatukan garis beat terdekat', () => {
    const out = computeClipSync({
      ...base,
      targetAsset: asset(1, 120, 0.25),
      alignment: 'beat',
    })!;
    expect(out.laneSpeedRatio).toBeCloseTo(128 / 120);
    // Target beat 5.25 s dipetakan ke master beat 5.15625 s.
    expect(out.targetStart / SR).toBeCloseTo(5.15625 - 5.25 / (128 / 120), 4);
  });

  it('bar sync memakai kelipatan empat beat, bukan beat terdekat sembarang', () => {
    const out = computeClipSync({
      ...base,
      targetAsset: asset(1, 120, 0.25),
      alignment: 'bar',
    })!;
    expect(out.targetStart).not.toBe(
      computeClipSync({ ...base, targetAsset: asset(1, 120, 0.25), alignment: 'beat' })!.targetStart,
    );
  });
});
