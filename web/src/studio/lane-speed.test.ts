import { beforeEach, describe, expect, it } from 'vitest';

import { effectiveSpeed, timelineLenFor, type StudioLane } from './model';
import { studioActions, studioStore } from './store';

function laneWithClips(): StudioLane {
  return studioStore.getState().lanes.find((l) => l.clips.length > 0)!;
}
const clipById = (id: string) =>
  studioStore
    .getState()
    .lanes.flatMap((l) => l.clips)
    .find((c) => c.id === id)!;

describe('speed per lane', () => {
  beforeEach(() => studioActions.__resetForTest());

  it('mempercepat lane memendekkan SEMUA clip di lane itu, source tetap', () => {
    const lane = laneWithClips();
    const before = lane.clips.map((c) => ({ id: c.id, len: c.len, sourceLen: c.sourceLen }));

    studioActions.setLaneSpeed(lane.id, 2);

    for (const b of before) {
      const after = clipById(b.id);
      expect(after.sourceLen).toBe(b.sourceLen); // materi tidak hilang
      expect(after.len).toBe(timelineLenFor(b.sourceLen, 2));
    }
  });

  it('posisi start TIDAK ikut diskalakan — sinkron antar lane terjaga', () => {
    const lane = laneWithClips();
    const starts = lane.clips.map((c) => c.start);
    studioActions.setLaneSpeed(lane.id, 0.5);
    const after = studioStore.getState().lanes.find((l) => l.id === lane.id)!;
    expect(after.clips.map((c) => c.start)).toEqual(starts);
  });

  it('lane lain tidak terpengaruh', () => {
    const target = laneWithClips();
    const other = studioStore.getState().lanes.find((l) => l.id !== target.id)!;
    const beforeOther = other.clips.map((c) => c.len);
    studioActions.setLaneSpeed(target.id, 2);
    const afterOther = studioStore.getState().lanes.find((l) => l.id === other.id)!;
    expect(afterOther.clips.map((c) => c.len)).toEqual(beforeOther);
    expect(afterOther.speedRatio).toBe(1);
  });

  it('bolak-balik kembali ke panjang semula — non-destruktif', () => {
    const lane = laneWithClips();
    const before = lane.clips.map((c) => c.len);
    studioActions.setLaneSpeed(lane.id, 0.5);
    studioActions.setLaneSpeed(lane.id, 2);
    studioActions.setLaneSpeed(lane.id, 1);
    const after = studioStore.getState().lanes.find((l) => l.id === lane.id)!;
    expect(after.clips.map((c) => c.len)).toEqual(before);
  });

  it('ratio dibatasi ke rentang wajar', () => {
    const lane = laneWithClips();
    studioActions.setLaneSpeed(lane.id, 999);
    expect(studioStore.getState().lanes.find((l) => l.id === lane.id)!.speedRatio).toBe(4);
  });

  it('split di lane ber-speed memotong source tepat di sambungan', () => {
    const lane = laneWithClips();
    studioActions.setLaneSpeed(lane.id, 2);
    const target = studioStore.getState().lanes.find((l) => l.id === lane.id)!.clips[0]!;

    studioActions.setPlayhead(target.start + Math.round(target.len / 2));
    studioActions.splitClipAtPlayhead(target.id);

    const clips = studioStore.getState().lanes.find((l) => l.id === lane.id)!.clips;
    const left = clips.find((c) => c.id === target.id)!;
    const right = clips.find((c) => c.start === left.start + left.len)!;

    expect(right.sourceStart).toBe(left.sourceStart + left.sourceLen);
    expect(left.sourceLen + right.sourceLen).toBe(target.sourceLen);
  });

  it('effectiveSpeed = lane × transport', () => {
    const lane = laneWithClips();
    expect(effectiveSpeed({ ...lane, speedRatio: 1.5 }, 2)).toBe(3);
  });
});
