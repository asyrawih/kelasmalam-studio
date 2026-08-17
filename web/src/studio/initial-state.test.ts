import { beforeEach, describe, expect, it } from 'vitest';

import { createInitialStudio } from './demo';
import { studioActions, studioStore } from './store';

describe('kondisi awal aplikasi', () => {
  beforeEach(() => studioActions.__resetForTest('empty'));

  it('satu lane bernama FIRST, tanpa clip', () => {
    const s = studioStore.getState();
    expect(s.lanes).toHaveLength(1);
    expect(s.lanes[0]!.name).toBe('FIRST');
    expect(s.lanes[0]!.clips).toHaveLength(0);
  });

  it('tidak ada clip mock sama sekali — project baru harus benar-benar kosong', () => {
    const clips = studioStore.getState().lanes.flatMap((l) => l.clips);
    expect(clips).toHaveLength(0);
    expect(studioStore.getState().contentEnd).toBe(0);
    expect(studioStore.getState().selectedClipId).toBeNull();
  });

  it('playhead mulai dari 0', () => {
    expect(studioStore.getState().playhead).toBe(0);
  });

  it('lane awal langsung terpilih, jadi paste/EQ punya sasaran', () => {
    expect(studioStore.getState().selectedLaneId).toBe('first');
  });

  it('createInitialStudio() murni — memanggil dua kali tidak berbagi objek lane', () => {
    const a = createInitialStudio();
    const b = createInitialStudio();
    expect(a.lanes[0]).not.toBe(b.lanes[0]);
    a.lanes[0]!.name = 'DIUBAH';
    expect(b.lanes[0]!.name).toBe('FIRST');
  });
});
