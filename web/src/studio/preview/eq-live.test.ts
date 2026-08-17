/**
 * Tes ini membuktikan rantai EQ benar-benar terbentuk dan nilainya berubah
 * live — bukan sekadar tersimpan di store. Web Audio tidak ada di jsdom, jadi
 * AudioContext-nya dipalsukan seminimal mungkin: yang diperiksa adalah node
 * apa yang dibuat, bagaimana disambungkan, dan parameter apa yang di-set.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeParam {
  value: number;
  setTargetAtTime: ReturnType<typeof vi.fn>;
  setValueAtTime: ReturnType<typeof vi.fn>;
  linearRampToValueAtTime: ReturnType<typeof vi.fn>;
  cancelScheduledValues: ReturnType<typeof vi.fn>;
}

const param = (v = 0): FakeParam => ({
  value: v,
  setTargetAtTime: vi.fn(),
  setValueAtTime: vi.fn(),
  linearRampToValueAtTime: vi.fn(),
  cancelScheduledValues: vi.fn(),
});

const filters: { type: string; frequency: FakeParam; Q: FakeParam; gain: FakeParam }[] = [];
const gains: FakeParam[] = [];

class FakeCtx {
  currentTime = 0;
  sampleRate = 48_000;
  destination = { name: 'dest' };
  resume = vi.fn().mockResolvedValue(undefined);
  createGain() {
    const g = param(1);
    gains.push(g);
    return { gain: g, connect: (n: unknown) => n, disconnect: vi.fn() };
  }
  createBiquadFilter() {
    const f = { type: '', frequency: param(), Q: param(), gain: param(), connect: (n: unknown) => n, disconnect: vi.fn() };
    filters.push(f as unknown as (typeof filters)[number]);
    return f;
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
}

describe('EQ lane', () => {
  beforeEach(() => {
    filters.length = 0;
    gains.length = 0;
    vi.resetModules();
    (globalThis as { AudioContext?: unknown }).AudioContext = FakeCtx;
  });

  it('membangun 4 band parametrik (90/620/3800/11000 Hz) per lane', async () => {
    const { play, registerBuffer } = await import('./audio-preview');
    const { studioStore, studioActions } = await import('../store');
    studioActions.__resetForTest();

    const state = studioStore.getState();
    // Daftarkan buffer palsu untuk setiap asset supaya clip ikut dijadwalkan.
    for (const lane of state.lanes) {
      for (const clip of lane.clips) {
        registerBuffer(clip.assetId, { length: 48_000, duration: 1 } as unknown as AudioBuffer);
      }
    }

    play(studioStore.getState());

    // Rantai dibuat untuk SETIAP lane yang terdengar, termasuk yang masih
    // kosong — supaya EQ-nya sudah siap begitu clip pertama dijatuhkan.
    const audibleLanes = studioStore.getState().lanes.length;
    expect(filters.length).toBe(audibleLanes * 4);
    expect(filters.slice(0, 4).map((f) => f.type)).toEqual([
      'lowshelf',
      'peaking',
      'peaking',
      'highshelf',
    ]);
    expect(filters.slice(0, 4).map((f) => f.frequency.value)).toEqual([90, 620, 3800, 11000]);
  });

  it('menggeser slider EQ mengubah gain filter TANPA menjadwalkan ulang', async () => {
    const { play, updateLaneParams, registerBuffer } = await import('./audio-preview');
    const { studioStore, studioActions } = await import('../store');
    studioActions.__resetForTest();

    const first = studioStore.getState().lanes.find((l) => l.clips.length > 0)!;
    for (const clip of first.clips) {
      registerBuffer(clip.assetId, { length: 48_000, duration: 1 } as unknown as AudioBuffer);
    }
    play(studioStore.getState());
    const createdBefore = filters.length;

    // Geser node: gain DAN frekuensi berubah sekaligus, seperti drag di kurva.
    studioActions.setLaneEqBand(first.id, 'low', { gainDb: 6, freq: 150 });
    studioActions.setLaneEqBand(first.id, 'mid', { gainDb: -3 });
    studioActions.setLaneEqBand(first.id, 'air', { gainDb: 2 });
    updateLaneParams(studioStore.getState());

    // Tidak ada node baru: parameter diubah di tempat.
    expect(filters.length).toBe(createdBefore);
    const num = expect.any(Number) as unknown as number;
    expect(filters[0]?.gain.setTargetAtTime).toHaveBeenCalledWith(6, num, num);
    expect(filters[0]?.frequency.setTargetAtTime).toHaveBeenCalledWith(150, num, num);
    expect(filters[1]?.gain.setTargetAtTime).toHaveBeenCalledWith(-3, num, num);
    expect(filters[3]?.gain.setTargetAtTime).toHaveBeenCalledWith(2, num, num);
  });
});
