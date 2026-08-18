import { beforeEach, describe, expect, it } from 'vitest';

import { studioActions, studioStore, type StudioAsset } from '../store';
import { DEFAULT_FADE_CURVE, type StudioClip } from '../model';
import { selectPlayheadTempo } from './playhead-tempo';

const SR = 48_000;

function asset(id: number, bpm: number | null, opts: Partial<StudioAsset> = {}): StudioAsset {
  return {
    id,
    name: `asset-${id}`,
    envelope: { levels: [], frames: 0 } as unknown as StudioAsset['envelope'],
    frames: 60 * SR,
    sampleRate: SR,
    tempo: bpm === null ? null : { bpm, confidence: 0.6, beatOffsetSec: 0 },
    tempoPending: false,
    tempoOctave: 0,
    ...opts,
  };
}

function clip(id: string, assetId: number, startSec: number, lenSec: number): StudioClip {
  return {
    id,
    assetId,
    start: startSec * SR,
    len: lenSec * SR,
    sourceStart: 0,
    sourceLen: lenSec * SR,
    label: id,
    gainDb: 0,
    fadeInMs: 0,
    fadeOutMs: 0,
    fadeCurve: DEFAULT_FADE_CURVE,
    seed: 1,
  };
}

function clearClips(): void {
  for (const lane of studioStore.getState().lanes) {
    for (const c of lane.clips) studioActions.removeClip(c.id);
  }
}

describe('tempo di playhead', () => {
  beforeEach(() => {
    studioActions.__resetForTest();
    clearClips();
  });

  it('melaporkan idle kalau playhead tidak menyentuh clip mana pun', () => {
    const t = selectPlayheadTempo(studioStore.getState());
    expect(t.idle).toBe(true);
    expect(t.primary).toBeNull();
  });

  it('mengambil BPM asset dari clip di bawah playhead', () => {
    const laneId = studioStore.getState().lanes[0]!.id;
    studioActions.registerAsset(asset(1, 128));
    studioActions.addClip(laneId, clip('a', 1, 0, 30));
    studioActions.setPlayhead(10 * SR);

    const t = selectPlayheadTempo(studioStore.getState());
    expect(t.primary?.bpm).toBeCloseTo(128, 5);
    expect(t.idle).toBe(false);
  });

  it('mengalikan dengan kecepatan lane — itu inti pitch fader DJ', () => {
    const laneId = studioStore.getState().lanes[0]!.id;
    studioActions.registerAsset(asset(1, 128));
    studioActions.addClip(laneId, clip('a', 1, 0, 30));
    studioActions.setPlayhead(10 * SR);
    studioActions.setLaneSpeed(laneId, 1.05);

    const t = selectPlayheadTempo(studioStore.getState());
    expect(t.primary?.bpm).toBeCloseTo(128 * 1.05, 3);
    // BPM sumber TIDAK ikut berubah: materinya tetap lagu 128.
    expect(t.primary?.sourceBpm).toBeCloseTo(128, 5);
  });

  it('koreksi oktaf user menggandakan / membagi dua', () => {
    const laneId = studioStore.getState().lanes[0]!.id;
    studioActions.registerAsset(asset(1, 85));
    studioActions.addClip(laneId, clip('a', 1, 0, 30));
    studioActions.setPlayhead(10 * SR);

    studioActions.shiftAssetTempoOctave(1, 1);
    expect(selectPlayheadTempo(studioStore.getState()).primary?.bpm).toBeCloseTo(170, 4);
    studioActions.shiftAssetTempoOctave(1, -1);
    expect(selectPlayheadTempo(studioStore.getState()).primary?.bpm).toBeCloseTo(85, 4);
    // Dibatasi ±2 oktaf supaya tidak bisa digeser sampai angka tak berarti.
    for (let i = 0; i < 6; i++) studioActions.shiftAssetTempoOctave(1, 1);
    expect(selectPlayheadTempo(studioStore.getState()).primary?.bpm).toBeCloseTo(85 * 4, 3);
  });

  it('lane yang di-mute tidak ikut dihitung', () => {
    const lanes = studioStore.getState().lanes;
    studioActions.registerAsset(asset(1, 128));
    studioActions.registerAsset(asset(2, 100));
    studioActions.addClip(lanes[0]!.id, clip('a', 1, 0, 30));
    studioActions.addClip(lanes[1]!.id, clip('b', 2, 0, 30));
    studioActions.setPlayhead(10 * SR);
    studioActions.toggleMute(lanes[0]!.id);

    const t = selectPlayheadTempo(studioStore.getState());
    expect(t.primary?.bpm).toBeCloseTo(100, 4);
    expect(t.others).toHaveLength(0);
  });

  it('dua lane berbunyi bersamaan: yang kedua masuk ke others', () => {
    const lanes = studioStore.getState().lanes;
    studioActions.registerAsset(asset(1, 128));
    studioActions.registerAsset(asset(2, 124));
    studioActions.addClip(lanes[0]!.id, clip('a', 1, 0, 30));
    studioActions.addClip(lanes[1]!.id, clip('b', 2, 0, 30));
    studioActions.setPlayhead(10 * SR);

    const t = selectPlayheadTempo(studioStore.getState());
    expect(t.primary?.bpm).toBeCloseTo(128, 4);
    expect(t.others.map((o) => Math.round(o.bpm))).toEqual([124]);
  });

  it('membedakan "sedang dianalisis" dari "tidak ada tempo"', () => {
    const laneId = studioStore.getState().lanes[0]!.id;
    studioActions.registerAsset(asset(1, null, { tempoPending: true }));
    studioActions.addClip(laneId, clip('a', 1, 0, 30));
    studioActions.setPlayhead(10 * SR);
    expect(selectPlayheadTempo(studioStore.getState())).toMatchObject({
      pending: true,
      unknown: false,
      idle: false,
    });

    studioActions.setAssetTempo(1, null);
    expect(selectPlayheadTempo(studioStore.getState())).toMatchObject({
      pending: false,
      unknown: true,
    });
  });

  it('batas akhir clip bersifat setengah-terbuka', () => {
    const laneId = studioStore.getState().lanes[0]!.id;
    studioActions.registerAsset(asset(1, 128));
    studioActions.addClip(laneId, clip('a', 1, 0, 30));

    studioActions.setPlayhead(30 * SR - 1);
    expect(selectPlayheadTempo(studioStore.getState()).idle).toBe(false);
    studioActions.setPlayhead(30 * SR);
    expect(selectPlayheadTempo(studioStore.getState()).idle).toBe(true);
  });
});
