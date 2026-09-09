/**
 * `previewPositionSec()` — posisi yang BENAR-BENAR terdengar, dibaca dari jam
 * audio.
 *
 * Ini yang menggerakkan waveform geser. Playhead di store maju 16×/detik dari
 * `setInterval`; kalau gambar digeser dengan angka itu, gerakannya tersendat
 * DAN tidak pernah persis di posisi yang keluar dari speaker. Tiga cara gagal
 * di sini semuanya tidak kelihatan dari layar, hanya terasa: mundur di bawah
 * nol karena lookahead, lupa mengalikan kecepatan transport, dan lupa
 * membungkus saat audisi loop (jam audio terus maju lurus walau bunyinya
 * mengulang).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SR = 48_000;

const param = (v = 0) => ({
  value: v,
  setTargetAtTime: vi.fn(),
  setValueAtTime: vi.fn(),
  linearRampToValueAtTime: vi.fn(),
  setValueCurveAtTime: vi.fn(),
  cancelScheduledValues: vi.fn(),
});

class FakeCtx {
  currentTime = 100;
  sampleRate = SR;
  destination = { name: 'dest' };
  resume = vi.fn().mockResolvedValue(undefined);
  createGain() {
    return { gain: param(1), connect: (n: unknown) => n, disconnect: vi.fn() };
  }
  createBiquadFilter() {
    return {
      type: '',
      frequency: param(),
      Q: param(),
      gain: param(),
      connect: (n: unknown) => n,
      disconnect: vi.fn(),
    };
  }
  createBufferSource() {
    return {
      buffer: null as unknown,
      playbackRate: param(1),
      loop: false,
      loopStart: 0,
      loopEnd: 0,
      connect: (n: unknown) => n,
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null,
    };
  }
}

let ctx: FakeCtx;

async function setup() {
  const preview = await import('./audio-preview');
  const { studioStore, studioActions } = await import('../store');
  studioActions.__resetForTest();
  const lane = studioStore.getState().lanes[0]!;
  const clip = lane.clips[0]!;
  studioActions.updateClip(clip.id, {
    start: 0,
    len: 60 * SR,
    sourceStart: 0,
    sourceLen: 60 * SR,
  });
  preview.registerBuffer(clip.assetId, {
    length: 60 * SR,
    duration: 60,
    numberOfChannels: 2,
  } as unknown as AudioBuffer);
  return { preview, studioStore, studioActions, clipId: clip.id };
}

describe('posisi dari jam audio', () => {
  beforeEach(() => {
    vi.resetModules();
    ctx = new FakeCtx();
    (globalThis as { AudioContext?: unknown }).AudioContext = class {
      constructor() {
        return ctx;
      }
    };
  });

  it('null saat tidak ada yang berbunyi — bukan 0', async () => {
    const { preview } = await setup();
    expect(preview.previewPositionSec()).toBeNull();
    preview.stop();
    expect(preview.previewPositionSec()).toBeNull();
  });

  it('tidak mundur ke belakang posisi awal selama lookahead', async () => {
    const { preview, studioStore, studioActions } = await setup();
    studioActions.setPlayhead(10 * SR);
    preview.play(studioStore.getState());
    // Masih di dalam lookahead 50 ms: belum ada sample yang keluar.
    expect(preview.previewPositionSec()).toBe(10);
    ctx.currentTime += 0.02;
    expect(preview.previewPositionSec()).toBe(10);
  });

  it('maju mengikuti jam audio', async () => {
    const { preview, studioStore, studioActions } = await setup();
    studioActions.setPlayhead(10 * SR);
    preview.play(studioStore.getState());
    ctx.currentTime += 0.05 + 1.25; // lewati lookahead, lalu 1,25 detik
    expect(preview.previewPositionSec()).toBeCloseTo(11.25, 9);
  });

  it('kecepatan transport ikut diperhitungkan', async () => {
    const { preview, studioStore, studioActions } = await setup();
    studioActions.setSpeed(2);
    studioActions.setPlayhead(10 * SR);
    preview.play(studioStore.getState());
    ctx.currentTime += 0.05 + 1; // satu detik nyata pada 2×
    expect(preview.previewPositionSec()).toBeCloseTo(12, 9);
  });

  it('audisi loop TIDAK menyentuh posisi transport', async () => {
    const { preview, studioStore, studioActions, clipId } = await setup();
    studioActions.setPlayhead(10 * SR);
    studioActions.startClipLoop(clipId, 4 * SR, 2 * SR);
    preview.play(studioStore.getState());
    ctx.currentTime += 0.05 + 3;
    // Transport terus maju lurus; loop punya jamnya sendiri.
    expect(preview.previewPositionSec()).toBeCloseTo(13, 9);
  });
});

describe('posisi pemutar audisi', () => {
  it('null kalau tidak ada audisi', async () => {
    const { preview } = await setup();
    expect(preview.auditionPositionSourceSec()).toBeNull();
  });

  it('membungkus di dalam region — jam audio maju lurus, bunyinya yang mengulang', async () => {
    const { preview, studioStore, studioActions, clipId } = await setup();
    studioActions.startClipLoop(clipId, 4 * SR, 2 * SR); // region source 4 s → 6 s
    preview.startAudition(studioStore.getState());
    expect(preview.auditionPositionSourceSec()).toBeCloseTo(4, 9);

    ctx.currentTime += 0.05 + 1.5;
    expect(preview.auditionPositionSourceSec()).toBeCloseTo(5.5, 9);

    // Tanpa pembungkusan ini, waveform akan terus meluncur menjauh sementara
    // yang terdengar tetap dua bar yang sama.
    ctx.currentTime += 1;
    expect(preview.auditionPositionSourceSec()).toBeCloseTo(4.5, 9);
    ctx.currentTime += 10; // lima putaran penuh
    expect(preview.auditionPositionSourceSec()).toBeCloseTo(4.5, 9);
  });

  it('berbunyi walau transport BERHENTI — itu seluruh gunanya', async () => {
    const { preview, studioStore, studioActions, clipId } = await setup();
    expect(studioStore.getState().playing).toBe(false);
    studioActions.startClipLoop(clipId, 4 * SR, 2 * SR);
    preview.startAudition(studioStore.getState());
    expect(preview.isAuditionRunning()).toBe(true);
    ctx.currentTime += 0.05 + 0.5;
    expect(preview.auditionPositionSourceSec()).toBeCloseTo(4.5, 9);
  });

  it('stop() transport tidak mematikan audisi', async () => {
    const { preview, studioStore, studioActions, clipId } = await setup();
    studioActions.startClipLoop(clipId, 4 * SR, 2 * SR);
    preview.play(studioStore.getState());
    preview.startAudition(studioStore.getState());
    preview.stop();
    expect(preview.isAuditionRunning()).toBe(true);
    preview.stopAudition();
    expect(preview.isAuditionRunning()).toBe(false);
  });

  it('kecepatan lane mempercepat jalannya posisi audisi', async () => {
    const { preview, studioStore, studioActions, clipId } = await setup();
    const laneId = studioStore.getState().lanes[0]!.id;
    studioActions.setLaneSpeed(laneId, 2);
    studioActions.startClipLoop(clipId, 4 * SR, 8 * SR);
    preview.startAudition(studioStore.getState());
    ctx.currentTime += 0.05 + 1; // satu detik dinding = dua detik source
    expect(preview.auditionPositionSourceSec()).toBeCloseTo(6, 9);
  });
});
