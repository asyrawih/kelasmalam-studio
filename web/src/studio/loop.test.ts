import { beforeEach, describe, expect, it } from 'vitest';

import { studioActions, studioStore } from './store';

const SR = 48_000;

/** Majukan transport dengan tick 60 ms sampai kondisi tercapai atau habis. */
function run(steps: number): void {
  for (let i = 0; i < steps; i += 1) studioActions.tick(60);
}

describe('loop & ujung materi', () => {
  beforeEach(() => {
    studioActions.__resetForTest();
  });

  it('contentEnd = clip terjauh, TANPA ekor kosong', () => {
    const s = studioStore.getState();
    const farthest = Math.max(
      ...s.lanes.flatMap((l) => l.clips.map((c) => c.start + c.len)),
    );
    expect(s.contentEnd).toBe(farthest);
    // duration selalu lebih panjang karena menyisakan ruang untuk clip baru.
    expect(s.duration).toBeGreaterThan(s.contentEnd);
  });

  it('dengan loop: kembali ke 0 DAN menaikkan seekEpoch agar audio ikut mengulang', () => {
    const s0 = studioStore.getState();
    expect(s0.loop).toBe(true);
    studioActions.setPlayhead(s0.contentEnd - SR); // 1 detik sebelum habis
    const epochBefore = studioStore.getState().seekEpoch;
    studioActions.togglePlay();

    run(40); // 2.4 detik — cukup melewati ujung

    const s1 = studioStore.getState();
    expect(s1.playing).toBe(true);
    expect(s1.playhead).toBeLessThan(s0.contentEnd);
    // Inilah yang membuat loop TERDENGAR, bukan cuma terlihat.
    expect(s1.seekEpoch).toBeGreaterThan(epochBefore);
  });

  it('tanpa loop: berhenti tepat di ujung materi, tidak menembus ekor kosong', () => {
    studioActions.toggleLoop();
    const s0 = studioStore.getState();
    expect(s0.loop).toBe(false);

    studioActions.setPlayhead(s0.contentEnd - SR);
    studioActions.togglePlay();
    run(60);

    const s1 = studioStore.getState();
    expect(s1.playing).toBe(false);
    expect(s1.playhead).toBe(s0.contentEnd);
    // Tidak berjalan sampai `duration` (yang 30 detik lebih panjang).
    expect(s1.playhead).toBeLessThan(s1.duration);
  });

  it('project kosong tetap bisa diputar (pakai duration sebagai batas)', () => {
    for (const lane of studioStore.getState().lanes) {
      for (const clip of lane.clips) studioActions.removeClip(clip.id);
    }
    expect(studioStore.getState().contentEnd).toBe(0);
    studioActions.togglePlay();
    run(5);
    expect(studioStore.getState().playhead).toBeGreaterThan(0);
  });
});
