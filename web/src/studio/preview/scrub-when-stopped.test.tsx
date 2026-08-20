/**
 * SCRUB BERBUNYI JUGA SAAT TRANSPORT BERHENTI.
 *
 * Dulu butir scrub disyaratkan `state.playing`, dengan alasan "menggeser
 * playhead untuk menaruh posisi bukan permintaan untuk mendengar apa pun".
 * Justru sebaliknya: mencari titik potong dilakukan dengan transport DIAM, dan
 * kalau scrub baru bersuara setelah PLAY ditekan, posisi awalnya sudah ikut
 * berjalan sebelum tangan sempat menaruhnya. Deck DJ (`dj/audio/deck-player.ts`)
 * sudah begitu sejak awal — jog berbunyi walau deck pause — dan tidak ada
 * alasan telinga harus belajar dua aturan di dua halaman aplikasi yang sama.
 *
 * Yang dikunci di sini adalah keputusannya, bukan bunyinya: `scrubTo` dipanggil
 * saat berhenti, MIX tetap tidak ikut menyala (tidak ada `play()` sesudah tangan
 * diangkat kalau transport memang berhenti), dan butirnya dibersihkan saat
 * dilepas.
 */
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./audio-preview', () => ({
  play: vi.fn(),
  reschedule: vi.fn(),
  scrubTo: vi.fn(),
  startAudition: vi.fn(),
  stop: vi.fn(),
  stopAudition: vi.fn(),
  stopScrub: vi.fn(),
  updateLaneParams: vi.fn(),
}));

import { play, scrubTo, stopScrub } from './audio-preview';
import { studioActions, studioStore } from '../store';
import { usePreviewPlayback } from './usePreviewPlayback';

function Harness(): null {
  usePreviewPlayback();
  return null;
}

describe('scrub audio saat transport berhenti', () => {
  beforeEach(() => {
    studioActions.__resetForTest();
    vi.mocked(play).mockClear();
    vi.mocked(scrubTo).mockClear();
    vi.mocked(stopScrub).mockClear();
  });

  it('berbunyi walau tidak sedang play', () => {
    render(<Harness />);
    expect(studioStore.getState().playing).toBe(false);

    studioActions.beginScrub();
    studioActions.setPlayhead(48_000 * 7);

    expect(vi.mocked(scrubTo)).toHaveBeenCalled();
  });

  it('tangan diangkat: butir dibersihkan, mix TIDAK ikut menyala', () => {
    render(<Harness />);
    studioActions.beginScrub();
    studioActions.setPlayhead(48_000 * 7);
    vi.mocked(play).mockClear();
    studioActions.endScrub();

    expect(vi.mocked(stopScrub)).toHaveBeenCalled();
    // `endScrub` menaikkan `seekEpoch`, tapi transport berhenti — lompatan itu
    // tidak boleh diterjemahkan jadi PLAY.
    expect(vi.mocked(play)).not.toHaveBeenCalled();
    expect(studioStore.getState().playing).toBe(false);
  });

  it('saat play, perilakunya tidak berubah', () => {
    render(<Harness />);
    studioActions.togglePlay();
    vi.mocked(scrubTo).mockClear();

    studioActions.beginScrub();
    studioActions.setPlayhead(48_000 * 12);

    expect(vi.mocked(scrubTo)).toHaveBeenCalled();
    expect(studioStore.getState().playing).toBe(true);
  });
});
