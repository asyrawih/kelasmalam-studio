/**
 * SCRUB AUDIO — butiran materi di bawah playhead.
 *
 * Menggeser playhead sambil membiarkan mix berjalan tidak mungkin: mix
 * dijadwalkan di muka dan maju sendiri, sedangkan tangan bisa diam atau mundur.
 * Yang dilakukan `scrubTo` sama dengan yang dilakukan pita: setiap beberapa
 * milidetik, satu potongan pendek DI POSISI PLAYHEAD dibunyikan. Berbaris maju
 * = bunyi forward, berbaris mundur = bunyi rewind, tangan diam = senyap.
 *
 * Tiga hal yang gagalnya tidak kelihatan dari layar dikunci di sini: butirnya
 * memang pendek (kalau sepanjang clip, satu gerakan kecil membunyikan sisa
 * lagu), tangan yang diam tidak menghasilkan butir baru (kalau tidak, ia
 * berbunyi seperti nada yang ditahan), dan butir baru tidak dibuat lebih rapat
 * dari jarak minimum (kalau tidak, satu drag cepat membuat ratusan voice).
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

interface FakeSource {
  buffer: unknown;
  playbackRate: ReturnType<typeof param>;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  connect: (n: unknown) => unknown;
  disconnect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  onended: unknown;
}
let sources: FakeSource[] = [];

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
  createBufferSource(): FakeSource {
    const src: FakeSource = {
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
    sources.push(src);
    return src;
  }
}

let ctx: FakeCtx;

async function setup() {
  const preview = await import('./audio-preview');
  const { studioStore, studioActions } = await import('../store');
  studioActions.__resetForTest();
  // Satu clip saja yang tersisa: tiap lane yang berbunyi menghasilkan butirnya
  // sendiri (memang begitu — scrub harus terdengar dari seluruh mix), dan tes
  // ini menghitung butir, jadi lane lain hanya membuat angkanya berlipat.
  const clip = studioStore.getState().lanes[0]!.clips[0]!;
  for (const lane of studioStore.getState().lanes) {
    for (const c of lane.clips) if (c.id !== clip.id) studioActions.removeClip(c.id);
  }
  studioActions.updateClip(clip.id, {
    start: 0,
    len: 120 * SR,
    sourceStart: 0,
    sourceLen: 120 * SR,
  });
  preview.registerBuffer(clip.assetId, {
    length: 120 * SR,
    duration: 120,
    numberOfChannels: 2,
  } as unknown as AudioBuffer);
  return { preview, studioStore, studioActions };
}

/** Argumen `start(when, offset, duration)` dari butir terakhir. */
const lastGrain = (): { when: number; offset: number; duration: number } => {
  const call = sources.at(-1)!.start.mock.calls[0]!;
  return { when: call[0] as number, offset: call[1] as number, duration: call[2] as number };
};

describe('butiran scrub', () => {
  beforeEach(() => {
    vi.resetModules();
    sources = [];
    ctx = new FakeCtx();
    (globalThis as { AudioContext?: unknown }).AudioContext = class {
      constructor() {
        return ctx;
      }
    };
  });

  it('membunyikan potongan PENDEK dari posisi playhead, bukan sisa clip', async () => {
    const { preview, studioStore, studioActions } = await setup();
    studioActions.setPlayhead(30 * SR);
    preview.scrubTo(studioStore.getState());

    expect(sources).toHaveLength(1);
    const g = lastGrain();
    expect(g.offset).toBeCloseTo(30, 6); // materi di bawah playhead
    expect(g.duration).toBeGreaterThan(0);
    expect(g.duration).toBeLessThan(0.2); // butir, bukan sisa lagu
    expect(g.when).toBeGreaterThanOrEqual(ctx.currentTime);
  });

  it('tangan yang DIAM tidak menghasilkan butir baru — pita berhenti memang senyap', async () => {
    const { preview, studioStore, studioActions } = await setup();
    studioActions.setPlayhead(30 * SR);
    preview.scrubTo(studioStore.getState());
    expect(sources).toHaveLength(1);

    // Waktu berjalan jauh melewati jarak antar butir, tapi posisinya sama.
    ctx.currentTime += 1;
    preview.scrubTo(studioStore.getState());
    expect(sources).toHaveLength(1);
  });

  it('gerakan cepat dibatasi jarak antar butir, bukan jumlah pointermove', async () => {
    const { preview, studioStore, studioActions } = await setup();
    // 20 pointermove dalam satu frame — tanpa pembatasan, 20 voice.
    for (let i = 1; i <= 20; i++) {
      studioActions.setPlayhead((30 + i * 0.01) * SR);
      preview.scrubTo(studioStore.getState());
    }
    expect(sources).toHaveLength(1);

    // Setelah jarak antar butir terlewati, butir berikutnya boleh berbunyi.
    ctx.currentTime += 0.05;
    studioActions.setPlayhead(31 * SR);
    preview.scrubTo(studioStore.getState());
    expect(sources).toHaveLength(2);
    expect(lastGrain().offset).toBeCloseTo(31, 6);
  });

  it('mundur pun berbunyi: butirnya berbaris mundur — itu bunyi rewind', async () => {
    const { preview, studioStore, studioActions } = await setup();
    studioActions.setPlayhead(30 * SR);
    preview.scrubTo(studioStore.getState());
    ctx.currentTime += 0.05;
    studioActions.setPlayhead(29 * SR);
    preview.scrubTo(studioStore.getState());

    expect(sources).toHaveLength(2);
    expect(lastGrain().offset).toBeCloseTo(29, 6);
  });

  it('stopScrub() memotong butir yang masih berbunyi', async () => {
    const { preview, studioStore, studioActions } = await setup();
    studioActions.setPlayhead(30 * SR);
    preview.scrubTo(studioStore.getState());
    preview.stopScrub();
    expect(sources.at(-1)!.stop).toHaveBeenCalled();
  });
});
