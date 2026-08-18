import { beforeEach, describe, expect, it } from 'vitest';

import { studioActions, studioStore, type StudioAsset } from '../store';
import { buildEnvelope } from '../timeline/envelope';
import { deserialize, normalizeLanes, serialize } from './persistence';

const SR = 48_000;

function asset(id: number): StudioAsset {
  return {
    id,
    name: `a-${id}`,
    envelope: buildEnvelope({
      numberOfChannels: 1,
      length: SR,
      getChannelData: () => new Float32Array(SR),
    }),
    frames: SR,
    sampleRate: SR,
    tempo: null,
    tempoPending: false,
    tempoOctave: 0,
    bpmOverride: null,
    beatOffsetOverride: null,
  };
}

describe('serialisasi project', () => {
  beforeEach(() => studioActions.__resetForTest());

  it('bolak-balik mempertahankan lane dan clip', () => {
    const before = studioStore.getState();
    const back = deserialize(serialize(before));
    expect(back).not.toBeNull();
    expect(back!.lanes).toEqual(before.lanes);
    expect(back!.sampleRate).toBe(before.sampleRate);
  });

  it('TIDAK menyimpan state transien', () => {
    studioActions.togglePlay();
    studioActions.copySelectedClip();
    const json = serialize(studioStore.getState());
    // Kalau "playing" ikut tersimpan, refresh akan membunyikan audio sendiri.
    expect(json).not.toContain('"playing"');
    expect(json).not.toContain('"clipboard"');
    expect(json).not.toContain('"draggingClip"');
    expect(json).not.toContain('"exportProgress"');
  });

  it('menolak data dengan versi berbeda — lebih baik mulai bersih daripada salah baca', () => {
    const json = serialize(studioStore.getState());
    const bumped = json.replace('"version":1', '"version":99');
    expect(deserialize(bumped)).toBeNull();
  });

  it('menolak JSON rusak tanpa melempar', () => {
    expect(deserialize('{bukan json')).toBeNull();
    expect(deserialize('{}')).toBeNull();
    expect(deserialize('{"version":1,"lanes":[]}')).toBeNull();
  });

  it('menyimpan koreksi beat grid, tapi HANYA asset yang benar-benar dikoreksi', () => {
    studioActions.registerAsset(asset(1));
    studioActions.registerAsset(asset(2));
    studioActions.setAssetBeatGrid(1, { bpm: 128, offsetSec: 0.25 });

    const back = deserialize(serialize(studioStore.getState()));
    expect(back!.assetGrids).toEqual({ 1: { bpm: 128, offsetSec: 0.25 } });
  });

  it('project lama tanpa assetGrids tetap terbaca', () => {
    const json = serialize(studioStore.getState()).replace(/,"assetGrids":\{[^}]*\}/, '');
    expect(deserialize(json)).not.toBeNull();
  });

  it('stem clip ikut tersimpan, dan nilai rusak dibereskan saat load', () => {
    const clipId = studioStore.getState().lanes.flatMap((l) => l.clips)[0]!.id;
    studioActions.setClipStem(clipId, { vocal: 0, bass: 0.5 });
    const back = deserialize(serialize(studioStore.getState()));
    const saved = back!.lanes.flatMap((l) => l.clips).find((c) => c.id === clipId)!;
    expect(saved.stem).toMatchObject({ vocal: 0, bass: 0.5 });

    // Nilai di luar rentang dari project yang diedit tangan tidak boleh sampai
    // ke GainNode: 5 akan menguatkan, -1 akan membalik fase.
    const dirty = normalizeLanes([
      { ...back!.lanes[0]!, clips: [{ ...saved, stem: { ...saved.stem!, vocal: 5, other: -1 } }] },
    ]);
    expect(dirty[0]!.clips[0]!.stem).toMatchObject({ vocal: 1, other: 0 });
  });

  it('stem yang setara bypass dibuang saat load, bukan disimpan sebagai semua-1', () => {
    const base = studioStore.getState().lanes[0]!;
    const clip = base.clips[0]!;
    const out = normalizeLanes([
      { ...base, clips: [{ ...clip, stem: { ...clip.stem, vocal: 1, bass: 1, other: 1, bassSplitHz: 180, voiceTopHz: 6000 } }] },
    ]);
    expect(out[0]!.clips[0]!.stem).toBeUndefined();
  });

  it('tinggi lane ikut tersimpan, dan project lama memakai default', () => {
    studioActions.setLaneHeight('L');
    expect(deserialize(serialize(studioStore.getState()))!.laneHeight).toBe('L');
    const json = serialize(studioStore.getState()).replace(/"laneHeight":"L",/, '');
    expect(deserialize(json)!.laneHeight).toBeUndefined();
  });

  it('hydrate memaksa playing=false walau data lama menyatakan sebaliknya', () => {
    studioActions.hydrate({ playing: true, playhead: 1000 });
    expect(studioStore.getState().playing).toBe(false);
    expect(studioStore.getState().playhead).toBe(1000);
  });
});
