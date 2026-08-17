import { beforeEach, describe, expect, it } from 'vitest';

import { studioActions, studioStore } from './store';

/**
 * Menggeser playhead harus MENGHENTIKAN transport, bukan sekadar membisukan
 * audio sementara. Tanpa ini, audio langsung lanjut dari titik yang baru saja
 * digeser dan sulit menilai apakah posisinya sudah tepat.
 */
describe('scrub menghentikan transport', () => {
  beforeEach(() => studioActions.__resetForTest());

  it('beginScrub tidak melanjutkan playback setelah dilepas', () => {
    studioActions.togglePlay();
    expect(studioStore.getState().playing).toBe(true);

    // Urutan yang dipakai TimelinePanel saat pointerdown di ruler.
    studioActions.setPlaying(false);
    studioActions.beginScrub();
    studioActions.setPlayhead(48_000 * 20);
    studioActions.endScrub();

    expect(studioStore.getState().playing).toBe(false);
    expect(studioStore.getState().scrubbing).toBe(false);
    expect(studioStore.getState().playhead).toBe(48_000 * 20);
  });

  it('endScrub menaikkan seekEpoch, jadi posisi baru berlaku saat play lagi', () => {
    const before = studioStore.getState().seekEpoch;
    studioActions.beginScrub();
    studioActions.setPlayhead(48_000 * 5);
    studioActions.endScrub();
    expect(studioStore.getState().seekEpoch).toBeGreaterThan(before);
  });
});
