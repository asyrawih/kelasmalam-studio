/**
 * AUDISI LOOP sebagai PEMUTAR KEDUA.
 *
 * Versi pertama fitur ini membajak transport: LOOP PLAY memindahkan playhead,
 * menyalakan play, dan membisukan semua lane lain. Akibatnya mendengar dua bar
 * dari satu clip menghentikan lagu di lane 2 dan menyeret playhead timeline ke
 * dalam loop. Yang benar adalah dua pemutar berdampingan — dan itu yang dikunci
 * tes di sini:
 *
 *   1. LOOP PLAY tidak menyentuh playhead maupun `playing`.
 *   2. `tick()` tidak lagi mengenal loop; playhead terus maju seperti biasa.
 *   3. Mix utama tetap lengkap, MINUS clip yang sedang diaudisi — ia berbunyi
 *      dari pemutar audisi, dan tidak boleh terdengar dua kali.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { clipLoopRange, studioActions, studioStore } from '../store';
import { buildProjectGraph } from './graph-builder';

const SR = 48_000;

const param = (v = 0) => ({
  value: v,
  setTargetAtTime: vi.fn(),
  setValueAtTime: vi.fn(),
  linearRampToValueAtTime: vi.fn(),
  setValueCurveAtTime: vi.fn(),
  cancelScheduledValues: vi.fn(),
});

interface FakeSource {
  buffer: unknown;
  playbackRate: ReturnType<typeof param>;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  start: ReturnType<typeof vi.fn>;
  connect: (n: unknown) => unknown;
}

let sources: FakeSource[] = [];

const ctx = {
  currentTime: 0,
  sampleRate: SR,
  destination: { name: 'dest' },
  createGain: () => ({ gain: param(1), connect: (n: unknown) => n, disconnect: vi.fn() }),
  createBiquadFilter: () => ({
    type: '',
    frequency: param(),
    Q: param(),
    gain: param(),
    connect: (n: unknown) => n,
    disconnect: vi.fn(),
  }),
  createBufferSource: () => {
    const s: FakeSource = {
      buffer: null,
      playbackRate: param(1),
      loop: false,
      loopStart: 0,
      loopEnd: 0,
      start: vi.fn(),
      connect: (n: unknown) => n,
    };
    sources.push(s);
    return s;
  },
} as unknown as BaseAudioContext;

const BUFFER = { length: 60 * SR, duration: 60, numberOfChannels: 2 } as unknown as AudioBuffer;

function buildMix() {
  const s = studioStore.getState();
  sources = [];
  return buildProjectGraph(ctx, s, {
    playheadSec: s.playhead / s.sampleRate,
    startAt: 0,
    getBuffer: () => BUFFER,
    skipClipId: s.clipLoop?.clipId,
  });
}

function allClips() {
  return studioStore.getState().lanes.flatMap((l) => l.clips);
}

beforeEach(() => {
  studioActions.__resetForTest();
  studioActions.setPlayhead(0);
  const lane = studioStore.getState().lanes[0]!;
  const clip = lane.clips[0]!;
  studioActions.updateClip(clip.id, {
    start: 10 * SR,
    len: 16 * SR,
    sourceStart: 0,
    sourceLen: 16 * SR,
  });
});

describe('audisi tidak menyentuh transport', () => {
  it('LOOP PLAY tidak memindahkan playhead dan tidak menyalakan play', () => {
    const clip = allClips()[0]!;
    studioActions.setPlayhead(30 * SR);
    studioActions.startClipLoop(clip.id, 4 * SR, 4 * SR);
    const s = studioStore.getState();
    expect(s.playhead).toBe(30 * SR);
    expect(s.playing).toBe(false);
    expect(s.clipLoop).toEqual({ clipId: clip.id, sourceStart: 4 * SR, sourceLen: 4 * SR });
  });

  it('STOP LOOP tidak menghentikan transport', () => {
    const clip = allClips()[0]!;
    studioActions.togglePlay();
    studioActions.startClipLoop(clip.id, 0, 2 * SR);
    studioActions.stopClipLoop();
    expect(studioStore.getState().playing).toBe(true);
    expect(studioStore.getState().clipLoop).toBeNull();
  });

  it('playhead terus maju lurus selama audisi — tidak terkurung di region', () => {
    const clip = allClips()[0]!;
    studioActions.startClipLoop(clip.id, 4 * SR, 2 * SR);
    studioActions.setPlayhead(14 * SR);
    studioActions.setPlaying(true);
    studioActions.tick(1000);
    studioActions.tick(1000);
    studioActions.tick(1000);
    // Kalau loop masih membajak tick(), angka ini akan terbungkus di 16 s.
    expect(studioStore.getState().playhead).toBe(17 * SR);
  });

  it('memindahkan region tidak menggeser playhead', () => {
    const clip = allClips()[0]!;
    studioActions.setPlayhead(30 * SR);
    studioActions.startClipLoop(clip.id, 0, 2 * SR);
    studioActions.moveClipLoop(8 * SR, 2 * SR);
    expect(studioStore.getState().playhead).toBe(30 * SR);
    expect(studioStore.getState().clipLoop!.sourceStart).toBe(8 * SR);
  });

  it('batas timeline region tetap bisa diturunkan, mengikuti kecepatan lane', () => {
    const clip = allClips()[0]!;
    const laneId = studioStore.getState().lanes[0]!.id;
    studioActions.startClipLoop(clip.id, 4 * SR, 4 * SR);
    studioActions.setLaneSpeed(laneId, 2);
    const r = clipLoopRange(studioStore.getState())!;
    expect(r.end - r.start).toBe(2 * SR);
  });

  it('menghapus clip ikut mematikan audisinya', () => {
    const clip = allClips()[0]!;
    studioActions.startClipLoop(clip.id, 0, 2 * SR);
    studioActions.removeClip(clip.id);
    expect(studioStore.getState().clipLoop).toBeNull();
  });

  it('LOOP CUT mematikan audisi — region-nya baru saja jadi clip', () => {
    const clip = allClips()[0]!;
    studioActions.startClipLoop(clip.id, 4 * SR, 2 * SR);
    studioActions.beatLoopCut(clip.id, { sourceStart: 4 * SR, sourceLen: 2 * SR, repeat: 2 });
    expect(studioStore.getState().clipLoop).toBeNull();
  });
});

describe('mix utama selama audisi', () => {
  it('clip lain TETAP dijadwalkan — lagu di lane lain tidak ikut berhenti', () => {
    const before = buildMix().voices.length;
    expect(before).toBeGreaterThan(1);

    const clip = allClips()[0]!;
    studioActions.startClipLoop(clip.id, 4 * SR, 2 * SR);
    const after = buildMix().voices.length;
    // Tepat satu clip yang hilang: yang sedang diaudisi.
    expect(after).toBe(before - 1);
  });

  it('clip yang diaudisi dilewati supaya tidak terdengar dua kali', () => {
    const clip = allClips()[0]!;
    studioActions.startClipLoop(clip.id, 4 * SR, 2 * SR);
    buildMix();
    // Tidak ada satu pun voice mix utama yang mengulang: pengulangan adalah
    // urusan pemutar audisi.
    expect(sources.every((s) => !s.loop)).toBe(true);
  });

  it('tanpa audisi, tidak ada clip yang dilewati', () => {
    const graph = buildMix();
    expect(graph.voices.length).toBe(allClips().length);
  });
});
