/**
 * CLIP YANG LOOP DI MIX UTAMA.
 *
 * Beda dengan `clip-loop.test.ts` di sebelah, yang menguji AUDISI (pemutar
 * kedua, hidup dari tombol LOOP PLAY). Di sini yang diuji adalah clip biasa di
 * timeline yang region loop-nya sudah DIPASANG: ia ikut transport, ikut mute/
 * solo, ikut export — dan yang membuatnya berulang bukan penjadwalan per
 * putaran, melainkan `loop` milik `AudioBufferSourceNode`.
 *
 * Dua hal yang benar-benar bisa salah dan dikunci di sini:
 *   1. batas putaran (`loopStart`/`loopEnd`) diambil dari region, bukan dari
 *      seluruh jendela clip;
 *   2. mulai dari TENGAH clip masuk di tengah putaran yang sedang berjalan.
 *      Kalau ini salah, mendengarkan lurus dan melompat ke detik yang sama
 *      akan menghasilkan bunyi yang berbeda.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { studioActions, studioStore, type StudioAsset } from '../store';
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
  buildProjectGraph(ctx, s, {
    playheadSec: s.playhead / s.sampleRate,
    startAt: 0,
    getBuffer: () => BUFFER,
  });
  return sources;
}

function theClip() {
  return studioStore.getState().lanes.flatMap((l) => l.clips)[0]!;
}

beforeEach(() => {
  studioActions.__resetForTest();
  studioActions.setPlayhead(0);
  // Satu clip saja di project, supaya `sources[0]` tidak ambigu.
  const s = studioStore.getState();
  for (const lane of s.lanes) {
    for (const c of lane.clips.slice(1)) studioActions.removeClip(c.id);
  }
  for (const lane of s.lanes.slice(1)) studioActions.removeLane(lane.id);
  const clip = theClip();
  studioActions.updateClip(clip.id, {
    start: 0,
    len: 16 * SR,
    sourceStart: 0,
    sourceLen: 16 * SR,
  });
});

describe('clip tanpa loop', () => {
  it('sourcenya tidak pernah diberi loop', () => {
    const [src] = buildMix();
    expect(src!.loop).toBe(false);
  });
});

describe('clip dengan region loop terpasang', () => {
  beforeEach(() => {
    // Region 2 detik yang mulai di detik ke-4 dalam materi.
    studioActions.setClipLoopRegion(theClip().id, { sourceStart: 4 * SR, sourceLen: 2 * SR });
  });

  it('clip tetap di tempat dan sepanjang semula', () => {
    const c = theClip();
    expect(c.start).toBe(0);
    expect(c.len).toBe(16 * SR);
    expect(c.sourceStart).toBe(4 * SR);
    expect(c.loopLen).toBe(2 * SR);
  });

  it('batas putaran diambil dari REGION, bukan dari seluruh jendela clip', () => {
    const [src] = buildMix();
    expect(src!.loop).toBe(true);
    expect(src!.loopStart).toBeCloseTo(4, 6);
    expect(src!.loopEnd).toBeCloseTo(6, 6);
  });

  it('mulai dari awal clip = mulai dari awal region', () => {
    const [src] = buildMix();
    const [, offsetSec] = src!.start.mock.calls[0]!;
    expect(offsetSec).toBeCloseTo(4, 6);
  });

  it('mulai dari TENGAH clip masuk di tengah putaran yang sedang berjalan', () => {
    // 5 detik ke dalam clip: dua putaran penuh + 1 detik.
    studioActions.setPlayhead(5 * SR);
    const [src] = buildMix();
    const [, offsetSec, durationSec] = src!.start.mock.calls[0]!;
    expect(offsetSec).toBeCloseTo(5, 6);
    // Durasi tetap "sampai clip habis" — untuk source yang loop, angka ini
    // menghitung total materi termasuk putarannya.
    expect(durationSec).toBeCloseTo(11, 6);
  });

  it('LEPAS LOOP memangkas clip yang sudah melewati ujung materi — kalau tidak, ia jadi BISU', () => {
    // Clip yang loop boleh lebih panjang dari file-nya; sesudah loop dilepas
    // panjang itu tidak lagi punya materi, dan `src.start()` yang melempar
    // membuat `buildProjectGraph` MELEWATI clip tanpa satu pun tanda di layar.
    const asset = studioStore.getState().assets[theClip().assetId];
    if (asset === undefined) {
      studioActions.registerAsset({
        id: theClip().assetId,
        name: 'uji',
        envelope: { levels: [], frames: 10 * SR } as unknown as StudioAsset['envelope'],
        frames: 10 * SR,
        sampleRate: SR,
        tempo: null,
        tempoPending: false,
      } as StudioAsset);
    }
    studioActions.trimClip(theClip().id, 'right', 40 * SR);
    expect(theClip().len).toBe(40 * SR);
    studioActions.removeClipLoopRegion(theClip().id);
    const c = theClip();
    expect(c.sourceStart + c.sourceLen).toBeLessThanOrEqual(10 * SR);
    const [src] = buildMix();
    expect(src!.loop).toBe(false);
    expect(src!.start).toHaveBeenCalled();
  });

  it('membelah clip yang loop menghasilkan dua clip yang memutar REGION YANG SAMA', () => {
    studioActions.splitClipAt(theClip().id, 6 * SR);
    const parts = studioStore.getState().lanes.flatMap((l) => l.clips);
    expect(parts).toHaveLength(2);
    for (const p of parts) {
      expect(p.sourceStart).toBe(4 * SR);
      expect(p.loopLen).toBe(2 * SR);
    }
  });

  it('LEPAS LOOP mengembalikan pemutaran lurus', () => {
    studioActions.removeClipLoopRegion(theClip().id);
    const [src] = buildMix();
    expect(src!.loop).toBe(false);
    expect(theClip().loopLen).toBeUndefined();
  });
});
