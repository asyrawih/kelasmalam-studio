import { beforeEach, describe, expect, it } from 'vitest';

import { MIN_DURATION_SEC, studioActions, studioStore, TAIL_ROOM_SEC } from './store';
import { DEFAULT_FADE_CURVE, type StudioClip } from './model';

const SR = 48_000;

function makeClip(id: string, startSec: number, lenSec: number): StudioClip {
  return {
    id,
    assetId: 1,
    start: startSec * SR,
    len: lenSec * SR,
    sourceStart: 0,
    sourceLen: lenSec * SR,
    label: id.toUpperCase(),
    gainDb: 0,
    fadeInMs: 0,
    fadeOutMs: 0,
    fadeCurve: DEFAULT_FADE_CURVE,
    seed: 1,
    chain: [],
  };
}

describe('pertumbuhan timeline', () => {
  beforeEach(() => {
    studioActions.__resetForTest();
  });

  it('selalu menyediakan ekor kosong setelah clip terakhir', () => {
    const s = studioStore.getState();
    const laneId = s.lanes[0]!.id;
    studioActions.addClip(laneId, makeClip('a', 0, 200));

    const { duration, sampleRate } = studioStore.getState();
    expect(duration / sampleRate).toBeCloseTo(200 + TAIL_ROOM_SEC, 3);
  });

  it('tidak pernah lebih pendek dari minimum walau kosong', () => {
    const s = studioStore.getState();
    for (const lane of s.lanes) {
      for (const clip of lane.clips) studioActions.removeClip(clip.id);
    }
    const { duration, sampleRate } = studioStore.getState();
    expect(duration / sampleRate).toBe(MIN_DURATION_SEC);
  });

  it('memanjang saat clip digeser ke kanan — bukan menjepitnya', () => {
    const s = studioStore.getState();
    const laneId = s.lanes[0]!.id;
    studioActions.addClip(laneId, makeClip('b', 0, 60));
    const before = studioStore.getState().duration;

    // Geser jauh melewati ujung timeline saat ini.
    studioActions.moveClip('b', 300 * SR);

    const after = studioStore.getState();
    const moved = after.lanes.flatMap((l) => l.clips).find((c) => c.id === 'b');
    expect(moved?.start).toBe(300 * SR); // posisinya TIDAK dipotong
    expect(after.duration).toBeGreaterThan(before);
    expect(after.duration / SR).toBeCloseTo(360 + TAIL_ROOM_SEC, 3);
  });

  it('banyak clip dalam satu lane menentukan panjang dari yang terjauh', () => {
    const s = studioStore.getState();
    const laneId = s.lanes[0]!.id;
    studioActions.addClip(laneId, makeClip('c1', 0, 30));
    studioActions.addClip(laneId, makeClip('c2', 100, 30));
    studioActions.addClip(laneId, makeClip('c3', 50, 30));

    const { duration } = studioStore.getState();
    expect(duration / SR).toBeCloseTo(130 + TAIL_ROOM_SEC, 3);
  });
});

describe('batas panjang manual', () => {
  beforeEach(() => {
    studioActions.__resetForTest();
  });

  it('MIN memaksa timeline lebih panjang walau konten pendek', () => {
    for (const lane of studioStore.getState().lanes) {
      for (const clip of lane.clips) studioActions.removeClip(clip.id);
    }
    studioActions.setDurationBounds(600, null);
    expect(studioStore.getState().duration / SR).toBe(600);
  });

  it('MAX memangkas ekor, tapi tidak pernah memangkas konten', () => {
    const laneId = studioStore.getState().lanes[0]!.id;
    for (const lane of studioStore.getState().lanes) {
      for (const clip of lane.clips) studioActions.removeClip(clip.id);
    }
    // Turunkan MIN dulu — default-nya 120 s dan akan menutupi efek yang diuji.
    studioActions.setDurationBounds(10, null);
    // Konten 50 s → otomatis jadi 50 + 30 (ekor) = 80 s.
    studioActions.addClip(laneId, makeClip('mid', 0, 50));
    expect(studioStore.getState().duration / SR).toBeCloseTo(80, 3);

    // MAX 60 memangkas ekor jadi 60 — masih di atas konten (50), jadi sah.
    studioActions.setDurationBounds(10, 60);
    expect(studioStore.getState().duration / SR).toBe(60);
  });

  it('MAX tidak memanjangkan timeline yang sudah lebih pendek', () => {
    for (const lane of studioStore.getState().lanes) {
      for (const clip of lane.clips) studioActions.removeClip(clip.id);
    }
    // MAX adalah batas atas, bukan target. Kosong + min 60 tetap 60, bukan 90.
    studioActions.setDurationBounds(60, 90);
    expect(studioStore.getState().duration / SR).toBe(60);
  });

  it('MAX TIDAK boleh memotong clip yang melewatinya', () => {
    const laneId = studioStore.getState().lanes[0]!.id;
    for (const lane of studioStore.getState().lanes) {
      for (const clip of lane.clips) studioActions.removeClip(clip.id);
    }
    studioActions.addClip(laneId, makeClip('long', 0, 300));
    studioActions.setDurationBounds(60, 90);

    // Konten menang: 300 detik audio tidak boleh disembunyikan oleh batas 90.
    expect(studioStore.getState().duration / SR).toBe(300);
  });
});
