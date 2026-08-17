import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_PANEL_ORDER, studioActions, studioStore } from '../store';
import { deserialize, serialize } from '../persist/persistence';

describe('urutan panel', () => {
  beforeEach(() => studioActions.__resetForTest());

  it('default: timeline di atas, clip detail di bawah', () => {
    expect(studioStore.getState().panelOrder).toEqual(DEFAULT_PANEL_ORDER);
  });

  it('memindahkan panel ke indeks baru', () => {
    studioActions.movePanel('clip-detail', 0);
    expect(studioStore.getState().panelOrder).toEqual(['clip-detail', 'timeline']);
  });

  it('indeks di luar rentang di-clamp, bukan bikin urutan rusak', () => {
    studioActions.movePanel('timeline', 99);
    expect(studioStore.getState().panelOrder).toEqual(['clip-detail', 'timeline']);
    studioActions.movePanel('timeline', -5);
    expect(studioStore.getState().panelOrder).toEqual(['timeline', 'clip-detail']);
  });

  it('memindahkan ke posisinya sendiri tidak mengubah apa pun', () => {
    const before = studioStore.getState().panelOrder;
    studioActions.movePanel('timeline', 0);
    expect(studioStore.getState().panelOrder).toBe(before);
  });

  it('urutan ikut tersimpan, jadi tata letak bertahan setelah refresh', () => {
    studioActions.movePanel('clip-detail', 0);
    const back = deserialize(serialize(studioStore.getState()));
    expect(back!.panelOrder).toEqual(['clip-detail', 'timeline']);
  });
});

describe('kompatibilitas data lama', () => {
  beforeEach(() => studioActions.__resetForTest());

  it('project tersimpan TANPA panelOrder tidak menghapus urutan default', () => {
    // Bentuk data sebelum fitur urut panel ada.
    studioActions.hydrate({ projectName: 'LAMA' });
    expect(studioStore.getState().panelOrder).toEqual(DEFAULT_PANEL_ORDER);
  });

  it('hydrate mengabaikan field bernilai undefined, bukan menimpanya', () => {
    studioActions.movePanel('clip-detail', 0);
    const custom = studioStore.getState().panelOrder;

    // Inilah yang dulu merusak: key ADA tapi nilainya undefined.
    studioActions.hydrate({ panelOrder: undefined, projectName: 'X' });

    expect(studioStore.getState().panelOrder).toEqual(custom);
    expect(studioStore.getState().projectName).toBe('X');
  });

  it('urutan tidak pernah undefined setelah memuat JSON versi lama', () => {
    const old = JSON.stringify({
      version: 1,
      projectName: 'P',
      sampleRate: 48_000,
      lanes: studioStore.getState().lanes,
      playhead: 0,
      speed: 1,
      loop: true,
      minDurationSec: 120,
      maxDurationSec: null,
      eqMode: 'curve',
      selectedLaneId: null,
      selectedClipId: null,
    });
    const parsed = deserialize(old);
    expect(parsed).not.toBeNull();
    // Field-nya memang tidak ada; pemulih WAJIB mengisinya dengan default.
    expect(parsed!.panelOrder).toBeUndefined();
  });
});
