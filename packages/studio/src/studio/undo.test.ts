import { beforeEach, describe, expect, it } from 'vitest';

import type { StudioAsset } from '@kelasmalam/studio-core/assets/model';
import { assetActions, assetStore } from '@kelasmalam/studio-core/assets/store';
import { findClip } from './model';
import { selectProjectDirty, studioActions, studioStore } from './store';

const SR = 48_000;
const asset = (id: number): StudioAsset => ({
  id,
  name: `LAGU ${id}`,
  contentHash: '',
  envelope: { frames: SR, levels: [] },
  frames: SR,
  sampleRate: SR,
  tempo: null,
  tempoPending: false,
  tempoOctave: 0,
  bpmOverride: null,
  beatOffsetOverride: null,
  analysisLock: false,
});

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

/**
 * Registry aset hidup di `studio-core` (docs/25 P4), tapi perubahannya tetap
 * bagian karya: ia bisa di-undo dan mengotori project — persis seperti saat
 * `assets` masih field store ini. Ini yang dijaga snapshot gabungan
 * (`HistoryEntry`) dan langganan `assetStore` di `store.ts`.
 */
describe('aset dalam riwayat undo dan penanda kotor', () => {
  beforeEach(() => {
    studioActions.__resetForTest();
    studioActions.markSaved();
  });

  it('mendaftarkan aset bisa di-undo — dan redo mengembalikannya', () => {
    assetActions.registerAsset(asset(9));
    expect(assetStore.getState().assets[9]).toBeDefined();
    expect(studioActions.undo()).toBe(true);
    expect(assetStore.getState().assets[9]).toBeUndefined();
    expect(studioActions.redo()).toBe(true);
    expect(assetStore.getState().assets[9]?.name).toBe('LAGU 9');
  });

  it('koreksi grid adalah satu langkah undo, tanpa menyentuh clip', () => {
    assetActions.registerAsset(asset(9));
    const before = findClip(studioStore.getState().lanes, 'c1')!.clip.start;
    assetActions.setAssetBeatGrid(9, { bpm: 128 });
    studioActions.moveClip('c1', before + 12_000);
    expect(studioActions.undo()).toBe(true);
    expect(assetStore.getState().assets[9]!.bpmOverride).toBe(128);
    expect(findClip(studioStore.getState().lanes, 'c1')!.clip.start).toBe(before);
    expect(studioActions.undo()).toBe(true);
    expect(assetStore.getState().assets[9]!.bpmOverride).toBeNull();
  });

  it('perubahan aset mengotori project; undo tetap kotor (definisi yang sama dengan clip)', () => {
    expect(selectProjectDirty(studioStore.getState())).toBe(false);
    assetActions.registerAsset(asset(9));
    expect(selectProjectDirty(studioStore.getState())).toBe(true);
    studioActions.markSaved();
    expect(selectProjectDirty(studioStore.getState())).toBe(false);
    studioActions.undo();
    expect(selectProjectDirty(studioStore.getState())).toBe(true);
  });

  it('aksi aset tanpa perubahan tidak menambah langkah undo', () => {
    assetActions.registerAsset(asset(9));
    studioActions.undo();
    expect(studioActions.canUndo()).toBe(false);
    assetActions.setAnalysisLock(404, true);
    assetActions.removeAsset(404);
    expect(studioActions.canUndo()).toBe(false);
  });

  it('hydrate mengosongkan riwayat termasuk langkah aset', () => {
    assetActions.registerAsset(asset(9));
    studioActions.hydrate({ playhead: 10 });
    expect(studioActions.canUndo()).toBe(false);
    expect(assetStore.getState().assets[9]).toBeDefined();
  });
});
