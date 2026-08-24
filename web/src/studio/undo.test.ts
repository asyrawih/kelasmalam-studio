import { beforeEach, describe, expect, it } from 'vitest';

import { findClip } from './model';
import { studioActions, studioStore } from './store';

describe('studio undo / redo', () => {
  beforeEach(() => studioActions.__resetForTest());

  it('mengembalikan edit tanpa mengubah playhead saat ini', () => {
    const before = findClip(studioStore.getState().lanes, 'c1')!.clip.start;
    studioActions.moveClip('c1', before + 12_000);
    studioActions.setPlayhead(96_000);
    expect(studioActions.undo()).toBe(true);
    expect(findClip(studioStore.getState().lanes, 'c1')!.clip.start).toBe(before);
    expect(studioStore.getState().playhead).toBe(96_000);
    expect(studioActions.redo()).toBe(true);
    expect(findClip(studioStore.getState().lanes, 'c1')!.clip.start).toBe(before + 12_000);
  });

  it('banyak pointermove dalam satu drag menjadi satu langkah undo', () => {
    const before = findClip(studioStore.getState().lanes, 'c1')!.clip.start;
    studioActions.setClipDragging(true);
    studioActions.moveClip('c1', before + 1_000);
    studioActions.moveClip('c1', before + 2_000);
    studioActions.moveClip('c1', before + 3_000);
    studioActions.setClipDragging(false);
    expect(studioActions.undo()).toBe(true);
    expect(findClip(studioStore.getState().lanes, 'c1')!.clip.start).toBe(before);
    expect(studioActions.undo()).toBe(false);
  });

  it('edit baru setelah undo membuang redo', () => {
    studioActions.addLane();
    studioActions.undo();
    studioActions.setMasterGain(3);
    expect(studioActions.redo()).toBe(false);
  });
});
