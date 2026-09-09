/**
 * Mengganti susunan SAAT berbunyi — tanpa senyap dan tanpa mundur.
 *
 * Ini yang dulu terdengar sebagai "kok jadi stop dulu baru play" tiap kali lane
 * ditambah atau clip digeser. Dua sebabnya berbeda dan dua-duanya dikunci di
 * sini:
 *
 *   1. TITIK MULAI. `state.playhead` hanya di-tick 16×/detik, jadi ia
 *      tertinggal sampai 60 ms dari yang benar-benar keluar dari speaker.
 *      Menjadwalkan ulang dari sana membuat lagu melompat MUNDUR sedikit setiap
 *      kali. `reschedule()` menghitung titiknya dari jam audio.
 *   2. LUBANG. Generasi lama harus dipotong PERSIS di titik generasi baru
 *      mulai — bukan seketika, karena perakitan graf baru berlangsung di JS dan
 *      butuh waktu.
 *
 * Web Audio dipalsukan seminimal mungkin, sama seperti tes preview lainnya.
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

/** Clip demo pertama dipanjangkan jadi 2 menit, supaya posisi mana pun dalam
 *  tes ini jatuh di dalamnya. Pola yang sama dengan `preview-position.test.ts`. */
async function setup() {
  const preview = await import('./audio-preview');
  const { studioStore, studioActions } = await import('../store');
  studioActions.__resetForTest();
  const clip = studioStore.getState().lanes[0]!.clips[0]!;
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

describe('mengganti susunan saat berbunyi', () => {
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

  it('melanjutkan dari posisi yang TERDENGAR, bukan dari playhead yang tertinggal', async () => {
    const { preview, studioStore, studioActions } = await setup();
    studioActions.setPlayhead(10 * SR);
    preview.play(studioStore.getState());
    expect(preview.previewPositionSec()).toBe(10);

    // 5 detik berlalu di jam audio, tapi playhead di store SENGAJA dibiarkan
    // tertinggal — persis keadaan di antara dua tick 60 ms.
    ctx.currentTime = 105;
    expect(preview.previewPositionSec()).toBeCloseTo(14.95, 9);

    preview.reschedule(studioStore.getState());
    // Titik silangnya sedikit di depan (lookahead), dan itu memang maju — yang
    // tidak boleh adalah mundur ke 10.
    const after = preview.previewPositionSec();
    expect(after).not.toBeNull();
    expect(after!).toBeGreaterThan(14.95);
    expect(after!).toBeLessThan(15.2);

    // Pembandingnya: `play()` memang kembali ke playhead — itu sebabnya ia
    // salah untuk "susunan berubah" dan benar untuk "user melompat".
    preview.play(studioStore.getState());
    expect(preview.previewPositionSec()).toBe(10);
  });

  it('memotong generasi lama di MASA DEPAN, bukan seketika — kalau tidak, ada lubang', async () => {
    const { preview, studioStore, studioActions } = await setup();
    studioActions.setPlayhead(10 * SR);
    preview.play(studioStore.getState());
    const old = sources.at(-1)!;
    expect(old.start).toHaveBeenCalled();
    expect(old.stop).not.toHaveBeenCalled();

    ctx.currentTime = 105;
    preview.reschedule(studioStore.getState());

    expect(old.stop).toHaveBeenCalled();
    const stopAt = old.stop.mock.calls[0]![0] as number;
    expect(stopAt).toBeGreaterThan(ctx.currentTime);

    // Dan yang baru mulai SEBELUM yang lama berhenti — bertindih, tidak berjeda.
    const fresh = sources.at(-1)!;
    const startAt = fresh.start.mock.calls[0]![0] as number;
    expect(startAt).toBeLessThanOrEqual(stopAt);
    expect(startAt).toBeGreaterThan(ctx.currentTime);
  });

  it('stop() membongkar semua generasi', async () => {
    const { preview, studioStore } = await setup();
    preview.play(studioStore.getState());
    ctx.currentTime = 101;
    preview.reschedule(studioStore.getState());
    preview.stop();
    expect(preview.previewPositionSec()).toBeNull();
  });
});
