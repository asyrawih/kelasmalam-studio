/**
 * Dua janji yang dibuat modul stem, diuji lewat jalur nyatanya:
 *
 *  1. Clip tanpa REMOVE tidak membayar apa pun — rantainya tidak dibangun.
 *  2. Menggeser REMOVE saat berbunyi mengubah node yang SUDAH ADA, bukan
 *     membangun ulang graf. Kalau yang kedua rusak, gejalanya bukan "salah
 *     nilai" melainkan deretan klik di setiap gerakan slider.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const param = (v = 0) => ({
  value: v,
  setTargetAtTime: vi.fn(),
  setValueAtTime: vi.fn(),
  linearRampToValueAtTime: vi.fn(),
  setValueCurveAtTime: vi.fn(),
  cancelScheduledValues: vi.fn(),
});

let splitters = 0;
let mergers = 0;
const gains: ReturnType<typeof param>[] = [];

class FakeCtx {
  currentTime = 0;
  sampleRate = 48_000;
  destination = { name: 'dest' };
  resume = vi.fn().mockResolvedValue(undefined);
  createGain() {
    const g = param(1);
    gains.push(g);
    return {
      gain: g,
      channelCount: 1,
      channelCountMode: 'max',
      channelInterpretation: 'speakers',
      connect: (n: unknown) => n,
      disconnect: vi.fn(),
    };
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
  createChannelSplitter() {
    splitters += 1;
    return { connect: (n: unknown) => n, disconnect: vi.fn() };
  }
  createChannelMerger() {
    mergers += 1;
    return { connect: (n: unknown) => n, disconnect: vi.fn() };
  }
  createBufferSource() {
    return {
      buffer: null as unknown,
      playbackRate: param(1),
      connect: (n: unknown) => n,
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null,
    };
  }
  createAnalyser() {
    return {
      fftSize: 2048,
      connect: (n: unknown) => n,
      disconnect: vi.fn(),
      getFloatTimeDomainData: vi.fn(),
    };
  }
}

async function setup() {
  const preview = await import('./audio-preview');
  const { studioStore, studioActions } = await import('../store');
  studioActions.__resetForTest();
  const state = studioStore.getState();
  for (const lane of state.lanes) {
    for (const clip of lane.clips) {
      preview.registerBuffer(clip.assetId, {
        length: 48_000,
        duration: 1,
        numberOfChannels: 2,
      } as unknown as AudioBuffer);
    }
  }
  return { preview, studioStore, studioActions };
}

describe('stem di jalur preview', () => {
  beforeEach(() => {
    splitters = 0;
    mergers = 0;
    gains.length = 0;
    vi.resetModules();
    (globalThis as { AudioContext?: unknown }).AudioContext = FakeCtx;
  });

  it('clip tanpa REMOVE tidak membangun rantai stem sama sekali', async () => {
    const { preview, studioStore } = await setup();
    preview.play(studioStore.getState());
    expect(splitters).toBe(0);
    expect(mergers).toBe(0);
  });

  it('clip dengan REMOVE VOCAL membangun tepat satu rantai', async () => {
    const { preview, studioStore, studioActions } = await setup();
    const clipId = studioStore.getState().lanes.flatMap((l) => l.clips)[0]!.id;
    studioActions.setClipStem(clipId, { vocal: 0 });
    preview.play(studioStore.getState());
    expect(splitters).toBe(1);
    expect(mergers).toBe(1);
  });

  it('menggeser jumlah REMOVE saat berbunyi mengubah node yang sudah ada', async () => {
    const { preview, studioStore, studioActions } = await setup();
    const clipId = studioStore.getState().lanes.flatMap((l) => l.clips)[0]!.id;
    studioActions.setClipStem(clipId, { vocal: 0 });
    preview.play(studioStore.getState());
    const built = splitters;

    studioActions.setClipStem(clipId, { vocal: 0.5 });
    preview.updateLaneParams(studioStore.getState());

    // Tidak ada rantai baru: graf yang sama dipakai ulang.
    expect(splitters).toBe(built);
    // Dan nilainya benar-benar diramp ke node hidup.
    const ramped = gains.filter((g) => g.setTargetAtTime.mock.calls.some((c) => c[0] === 0.5));
    expect(ramped.length).toBeGreaterThan(0);
  });

  it('mematikan semua REMOVE membuang field stem dari clip', async () => {
    const { studioStore, studioActions } = await setup();
    const clipId = studioStore.getState().lanes.flatMap((l) => l.clips)[0]!.id;
    studioActions.setClipStem(clipId, { vocal: 0 });
    studioActions.setClipStem(clipId, { vocal: 1 });
    const clip = studioStore.getState().lanes.flatMap((l) => l.clips).find((c) => c.id === clipId)!;
    expect(clip.stem).toBeUndefined();
  });
});
