import { beforeEach, describe, expect, it } from 'vitest';

import { studioActions, studioStore } from './store';

/**
 * Menggeser playhead TIDAK menghentikan transport.
 *
 * Dulu iya, dan alasannya masuk akal saat itu: kalau audio langsung lanjut dari
 * titik yang baru digeser, sulit menilai apakah titiknya sudah tepat. Yang
 * menjawab keberatan itu sekarang bukan diam, melainkan scrub audio — selama
 * digeser, yang terdengar adalah butiran materi DI BAWAH playhead
 * (`preview/audio-preview.ts`), jadi posisinya justru dinilai dengan telinga.
 * Menghentikan transport di sini berarti user harus menekan PLAY lagi setiap
 * kali memindahkan posisi.
 *
 * Yang menggantikannya: selama scrub, TANGAN yang memegang playhead — `tick`
 * tidak boleh ikut memajukannya.
 */
describe('scrub tidak menghentikan transport', () => {
  beforeEach(() => studioActions.__resetForTest());

  it('tetap play setelah dilepas, di posisi yang baru', () => {
    studioActions.togglePlay();
    expect(studioStore.getState().playing).toBe(true);

    // Urutan yang dipakai TimelinePanel saat pointerdown di ruler.
    studioActions.beginScrub();
    studioActions.setPlayhead(48_000 * 20);
    studioActions.endScrub();

    expect(studioStore.getState().playing).toBe(true);
    expect(studioStore.getState().scrubbing).toBe(false);
    expect(studioStore.getState().playhead).toBe(48_000 * 20);
  });

  it('tick tidak melawan tangan selama scrub', () => {
    studioActions.togglePlay();
    studioActions.beginScrub();
    studioActions.setPlayhead(48_000 * 10);

    studioActions.tick(60);
    studioActions.tick(60);
    expect(studioStore.getState().playhead).toBe(48_000 * 10);

    // Dilepas, dan playhead jalan lagi sendiri.
    studioActions.endScrub();
    studioActions.tick(60);
    expect(studioStore.getState().playhead).toBeGreaterThan(48_000 * 10);
  });

  it('endScrub menaikkan seekEpoch, jadi mix menyala lagi dari posisi baru', () => {
    const before = studioStore.getState().seekEpoch;
    studioActions.beginScrub();
    studioActions.setPlayhead(48_000 * 5);
    studioActions.endScrub();
    expect(studioStore.getState().seekEpoch).toBeGreaterThan(before);
  });
});
