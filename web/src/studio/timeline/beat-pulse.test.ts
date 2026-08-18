/**
 * Denyut ketukan di strip lane.
 *
 * Yang dites adalah bagian yang bisa salah tanpa terlihat sebagai error:
 * konversi timeline→source lewat rasio lane, downbeat vs ketukan biasa, dan
 * lane yang seharusnya DIAM (mute, tidak ada clip, tanpa BPM).
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_FADE_CURVE, defaultEq, type StudioClip, type StudioLane } from '../model';
import type { StudioAsset } from '../store';
import { FLASH_FRACTION, OFFBEAT_LEVEL, lanePulse } from './beat-pulse';

const SR = 48_000;
const ASSET_ID = 1;

function asset(over: Partial<StudioAsset> = {}): StudioAsset {
  return {
    id: ASSET_ID,
    name: 'a',
    envelope: { levels: [], frames: 0 } as unknown as StudioAsset['envelope'],
    frames: 120 * SR,
    sampleRate: SR,
    // 120 BPM, downbeat di 0 → satu ketukan tiap 0,5 detik.
    tempo: { bpm: 120, confidence: 0.5, beatOffsetSec: 0 },
    tempoPending: false,
    tempoOctave: 0,
    bpmOverride: null,
    beatOffsetOverride: null,
    ...over,
  };
}

function clip(over: Partial<StudioClip> = {}): StudioClip {
  return {
    id: 'c1',
    assetId: ASSET_ID,
    start: 0,
    len: 60 * SR,
    sourceStart: 0,
    sourceLen: 60 * SR,
    label: 'c1',
    gainDb: 0,
    fadeInMs: 0,
    fadeOutMs: 0,
    fadeCurve: DEFAULT_FADE_CURVE,
    seed: 1,
    ...over,
  };
}

function lane(over: Partial<StudioLane> = {}): StudioLane {
  return {
    id: 'l1',
    name: 'A',
    color: '#ffd400',
    mute: false,
    solo: false,
    gainDb: 0,
    speedRatio: 1,
    eq: defaultEq(),
    chain: [],
    clips: [clip()],
    ...over,
  };
}

const ASSETS = { [ASSET_ID]: asset() };
const pulse = (l: StudioLane, sec: number, lanes: StudioLane[] = [l], audition = null) =>
  lanePulse(l, lanes, ASSETS, SR, sec, audition);

describe('denyut ketukan', () => {
  it('paling terang tepat di downbeat', () => {
    expect(pulse(lane(), 0)).toBe(1);
    expect(pulse(lane(), 2)).toBe(1); // bar berikutnya @120 BPM 4/4
  });

  it('ketukan biasa lebih redup dari downbeat', () => {
    expect(pulse(lane(), 0.5)).toBeCloseTo(OFFBEAT_LEVEL, 9);
    expect(pulse(lane(), 1)).toBeCloseTo(OFFBEAT_LEVEL, 9);
    expect(pulse(lane(), 1.5)).toBeCloseTo(OFFBEAT_LEVEL, 9);
  });

  it('padam sebelum ketukan berikutnya, bukan meredup terus', () => {
    // Kilatan hanya memakai sepertiga ketukan; sisanya gelap, dan itu yang
    // membuatnya terbaca sebagai ketukan, bukan lampu yang diredupkan.
    const beatSec = 0.5;
    expect(pulse(lane(), beatSec * FLASH_FRACTION * 0.99)).toBeGreaterThan(0);
    // Tepat di batas: nol untuk semua maksud praktis (sisa float-nya ~1e-32).
    expect(pulse(lane(), beatSec * FLASH_FRACTION)).toBeCloseTo(0, 9);
    expect(pulse(lane(), beatSec * 0.9)).toBe(0);
  });

  it('meluruh, bukan menyala penuh sepanjang kilatan', () => {
    const early = pulse(lane(), 0.02);
    const late = pulse(lane(), 0.12);
    expect(early).toBeGreaterThan(late);
    expect(late).toBeGreaterThan(0);
  });

  it('kecepatan lane merapatkan ketukannya', () => {
    // Lane 2× lebih cepat: satu detik timeline memakan dua detik materi, jadi
    // downbeat berikutnya jatuh di 1 detik timeline, bukan 2.
    const fast = lane({ speedRatio: 2 });
    expect(pulse(fast, 1)).toBe(1);
    expect(pulse(fast, 0.25)).toBeCloseTo(OFFBEAT_LEVEL, 9);
  });

  it('posisi clip di timeline ikut diperhitungkan', () => {
    const shifted = lane({ clips: [clip({ start: 10 * SR })] });
    expect(pulse(shifted, 10)).toBe(1);
    expect(pulse(shifted, 10.5)).toBeCloseTo(OFFBEAT_LEVEL, 9);
  });

  it('trim di dalam materi menggeser fase ketukannya', () => {
    // Clip mulai dari 0,25 detik materi: downbeat materi jatuh di 0,25 detik
    // sebelum awal clip, jadi di timeline 0 kita berada di tengah ketukan.
    const trimmed = lane({ clips: [clip({ sourceStart: 0.25 * SR })] });
    expect(pulse(trimmed, 0)).toBe(0);
    expect(pulse(trimmed, 0.25)).toBeCloseTo(OFFBEAT_LEVEL, 9);
  });

  it('DIAM di lane yang di-mute', () => {
    expect(pulse(lane({ mute: true }), 0)).toBe(0);
  });

  it('DIAM di lane yang dibungkam solo lane lain', () => {
    const a = lane();
    const b = lane({ id: 'l2', solo: true });
    expect(pulse(a, 0, [a, b])).toBe(0);
    expect(pulse(b, 0, [a, b])).toBe(1);
  });

  it('DIAM kalau playhead tidak menyentuh clip apa pun', () => {
    expect(pulse(lane(), 90)).toBe(0);
    expect(pulse(lane({ clips: [] }), 0)).toBe(0);
  });

  it('DIAM kalau materinya tidak punya BPM', () => {
    const l = lane();
    expect(lanePulse(l, [l], { [ASSET_ID]: asset({ tempo: null }) }, SR, 0, null)).toBe(0);
  });

  it('lane yang diaudisi mengikuti pemutar audisi, bukan playhead timeline', () => {
    const l = lane();
    // Playhead timeline di 0,25 detik (gelap), tapi audisi ada di downbeat.
    expect(lanePulse(l, [l], ASSETS, SR, 0.25, { clipId: 'c1', sourceSec: 0 })).toBe(1);
    // Dan sebaliknya: playhead di downbeat, audisi di tengah ketukan.
    expect(lanePulse(l, [l], ASSETS, SR, 0, { clipId: 'c1', sourceSec: 0.25 })).toBe(0);
  });

  it('audisi di clip lain tidak mempengaruhi lane ini', () => {
    const l = lane();
    expect(lanePulse(l, [l], ASSETS, SR, 0, { clipId: 'lain', sourceSec: 0.25 })).toBe(1);
  });
});
