/**
 * `insertLanesBelow` — lane hasil pemisahan vokal (docs/26 §3a).
 *
 * Yang dijaga: posisi sisip (tepat di bawah sumber, bukan di akhir), urutan
 * input, mute lane sumber, dan bahwa semuanya SATU langkah undo. Kalau mute
 * dan sisip jadi dua langkah, ⌘Z pertama membunyikan lagi lane sumber di atas
 * dua stem yang masih ada — terdengar seperti bug, bukan seperti undo.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_FADE_CURVE, type StudioClip } from './model';
import { studioActions, studioStore } from './store';

const SR = 48_000;

function clip(label: string, startSec: number, lenSec: number): Omit<StudioClip, 'id'> {
  return {
    assetId: 7,
    chain: [],
    start: startSec * SR,
    len: lenSec * SR,
    sourceStart: 0,
    sourceLen: lenSec * SR,
    label,
    gainDb: 0,
    fadeInMs: 0,
    fadeOutMs: 0,
    fadeCurve: DEFAULT_FADE_CURVE,
    seed: 3,
  };
}

const laneIds = () => studioStore.getState().lanes.map((l) => l.id);
const lane = (id: string) => studioStore.getState().lanes.find((l) => l.id === id);

describe('studioActions.insertLanesBelow', () => {
  beforeEach(() => studioActions.__resetForTest());

  it('menyisipkan tepat di bawah lane sumber, urut sesuai input', () => {
    const before = laneIds();
    const ids = studioActions.insertLanesBelow('l2', [
      { name: 'LAGU · VOCALS', clips: [clip('VOCALS', 2, 4)] },
      { name: 'LAGU · INST', clips: [clip('INST', 2, 4)] },
    ]);

    expect(ids).toHaveLength(2);
    expect(laneIds()).toEqual([before[0], 'l2', ids[0], ids[1], ...before.slice(2)]);
    expect(lane(ids[0]!)?.name).toBe('LAGU · VOCALS');
    expect(lane(ids[1]!)?.name).toBe('LAGU · INST');
  });

  it('id lane dan clip unik, tidak menabrak yang sudah ada', () => {
    const ids = studioActions.insertLanesBelow('l1', [
      { name: 'A', clips: [clip('a1', 0, 1), clip('a2', 5, 1)] },
      { name: 'B', clips: [clip('b1', 0, 1)] },
    ]);
    const all = studioStore.getState().lanes;
    const laneSet = new Set(all.map((l) => l.id));
    expect(laneSet.size).toBe(all.length);
    const clipIds = all.flatMap((l) => l.clips.map((c) => c.id));
    expect(new Set(clipIds).size).toBe(clipIds.length);
    expect(ids[0]).not.toBe(ids[1]);
    for (const c of lane(ids[0]!)!.clips) expect(c.id).toMatch(/^clip-/);
  });

  it('default lane sama dengan addLane dan clip diurutkan menurut start', () => {
    const [id] = studioActions.insertLanesBelow('l1', [
      { name: 'X', clips: [clip('kedua', 10, 1), clip('pertama', 1, 1)] },
    ]);
    const l = lane(id!)!;
    expect(l).toMatchObject({ mute: false, solo: false, gainDb: 0, speedRatio: 1, chain: [] });
    expect(l.color).toMatch(/^#/);
    expect(l.clips.map((c) => c.label)).toEqual(['pertama', 'kedua']);
  });

  it('warna eksplisit dihormati', () => {
    const [id] = studioActions.insertLanesBelow('l1', [{ name: 'X', color: '#123456', clips: [] }]);
    expect(lane(id!)?.color).toBe('#123456');
  });

  it('muteSource membisukan lane sumber dalam mutasi yang sama', () => {
    expect(lane('l1')?.mute).toBe(false);
    studioActions.insertLanesBelow('l1', [{ name: 'X', clips: [] }], { muteSource: true });
    expect(lane('l1')?.mute).toBe(true);
  });

  it('memilih lane baru pertama dan clip pertamanya', () => {
    const ids = studioActions.insertLanesBelow('l1', [
      { name: 'A', clips: [clip('a2', 5, 1), clip('a1', 0, 1)] },
      { name: 'B', clips: [clip('b1', 0, 1)] },
    ]);
    const s = studioStore.getState();
    expect(s.selectedLaneId).toBe(ids[0]);
    expect(s.selectedClipId).toBe(lane(ids[0]!)!.clips[0]!.id);
    expect(s.selectedClipIds).toEqual([s.selectedClipId]);
  });

  it('satu undo mengembalikan lane baru hilang DAN mute sumber; redo mengulang', () => {
    const before = laneIds();
    const ids = studioActions.insertLanesBelow(
      'l3',
      [
        { name: 'V', clips: [clip('v', 0, 2)] },
        { name: 'I', clips: [clip('i', 0, 2)] },
      ],
      { muteSource: true },
    );
    expect(laneIds()).toHaveLength(before.length + 2);
    expect(lane('l3')?.mute).toBe(true);

    expect(studioActions.undo()).toBe(true);
    expect(laneIds()).toEqual(before);
    expect(lane('l3')?.mute).toBe(false);
    // Tidak ada langkah tersisa: sisip + mute memang satu.
    expect(studioActions.undo()).toBe(false);

    expect(studioActions.redo()).toBe(true);
    expect(laneIds()).toContain(ids[0]);
    expect(laneIds()).toContain(ids[1]);
    expect(laneIds().indexOf(ids[0]!)).toBe(laneIds().indexOf('l3') + 1);
    expect(lane('l3')?.mute).toBe(true);
  });

  it('laneId tak dikenal: tidak ada perubahan, kembalikan []', () => {
    const before = studioStore.getState();
    const ids = studioActions.insertLanesBelow('lane-tidak-ada', [{ name: 'X', clips: [clip('x', 0, 1)] }], {
      muteSource: true,
    });
    expect(ids).toEqual([]);
    expect(studioStore.getState().lanes).toBe(before.lanes);
    expect(studioActions.canUndo()).toBe(false);
  });
});
