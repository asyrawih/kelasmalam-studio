/**
 * Amplify master di jalur preview.
 *
 * Yang dibuktikan di sini bukan "nilainya tersimpan" (itu tes store), melainkan
 * tiga hal yang hanya bisa salah di Web Audio: (a) TIDAK ADA lane yang
 * menyambung langsung ke destination, jadi tidak ada yang bisa lolos dari
 * amplify; (b) menggeser slider hanya menyentuh AudioParam node yang SUDAH ADA
 * — begitu ia membangun ulang graf, tiap piksel gerakan jadi klik; dan (c)
 * peak master benar-benar dibaca dari tap, bukan diperkirakan.
 *
 * Web Audio tidak ada di jsdom, jadi AudioContext-nya dipalsukan seminimal
 * mungkin, sama seperti `eq-live.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeParam {
  value: number;
  setTargetAtTime: ReturnType<typeof vi.fn>;
  setValueAtTime: ReturnType<typeof vi.fn>;
  setValueCurveAtTime: ReturnType<typeof vi.fn>;
  cancelScheduledValues: ReturnType<typeof vi.fn>;
}

const param = (v = 0): FakeParam => ({
  value: v,
  setTargetAtTime: vi.fn(),
  setValueAtTime: vi.fn(),
  setValueCurveAtTime: vi.fn(),
  cancelScheduledValues: vi.fn(),
});

interface Wiring {
  readonly kind: string;
  /** Semua tujuan `connect()` — inilah yang membuktikan topologinya. */
  readonly out: unknown[];
  connect: (n: unknown) => unknown;
  disconnect: ReturnType<typeof vi.fn>;
}

type FakeGain = Wiring & { gain: FakeParam };

const DEST = { name: 'destination' };
/** Amplitudo yang dikembalikan analyser palsu — dipakai memeriksa peak. */
const TAP_PEAK = 0.75;

let gains: FakeGain[] = [];

function wiring<T extends object>(kind: string, extra: T): Wiring & T {
  const out: unknown[] = [];
  return {
    kind,
    out,
    connect: (n: unknown) => {
      out.push(n);
      return n;
    },
    disconnect: vi.fn(),
    ...extra,
  };
}

class FakeCtx {
  currentTime = 0;
  sampleRate = 48_000;
  destination = DEST;
  resume = vi.fn().mockResolvedValue(undefined);
  createGain(): FakeGain {
    const g = wiring('gain', { gain: param(1) });
    gains.push(g);
    return g;
  }
  createBiquadFilter(): unknown {
    return wiring('filter', { type: '', frequency: param(), Q: param(), gain: param() });
  }
  createBufferSource(): unknown {
    return {
      ...wiring('source', { buffer: null as unknown, playbackRate: param(1) }),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null,
    };
  }
  createAnalyser(): unknown {
    return {
      ...wiring('analyser', {
        fftSize: 0,
        getFloatTimeDomainData(buf: Float32Array) {
          buf.fill(0);
          buf[3] = -TAP_PEAK; // peak boleh negatif — yang diukur nilai mutlaknya
        },
      }),
    };
  }
}

/** Browser/jsdom tanpa AnalyserNode: field instance menutupi method prototype. */
class FakeCtxNoAnalyser extends FakeCtx {
  override createAnalyser = undefined as unknown as () => unknown;
}

function useCtx(Ctor: unknown): void {
  (globalThis as { AudioContext?: unknown }).AudioContext = Ctor;
}

/** Node yang menyambung ke `audio.destination` — harus tepat satu: master. */
const toDestination = (): FakeGain[] => gains.filter((g) => g.out.includes(DEST));

const lin = (db: number): number => 10 ** (db / 20);

describe('Amplify master (preview)', () => {
  beforeEach(() => {
    gains = [];
    vi.resetModules();
    useCtx(FakeCtx);
  });

  it('semua lane masuk lewat SATU gain master, bukan langsung ke destination', async () => {
    const { play } = await import('./audio-preview');
    const { studioStore, studioActions } = await import('../store');
    studioActions.__resetForTest();
    studioActions.setMasterGain(-6);

    play(studioStore.getState());

    const masters = toDestination();
    expect(masters).toHaveLength(1);
    const master = masters[0]!;
    expect(master.gain.value).toBeCloseTo(lin(-6), 6);

    // Rantainya sekarang lane → BUS generasi → master. Bus itu ada supaya
    // susunan bisa diganti dengan crossfade tanpa senyap (lihat `Generation`
    // di audio-preview). Yang dijaga tes ini tidak berubah: tidak ada satu pun
    // node yang sampai ke destination tanpa lewat master.
    const buses = gains.filter((g) => g !== master && g.out.includes(master));
    expect(buses).toHaveLength(1);
    const bus = buses[0]!;
    const laneGains = gains.filter((g) => g !== bus && g.out.includes(bus));
    expect(laneGains.length).toBe(studioStore.getState().lanes.length);
    for (const g of gains) {
      if (g === master) continue;
      expect(g.out).not.toContain(DEST);
    }
  });

  it('menggeser slider amplify mengubah gain master TANPA membuat node baru', async () => {
    const { play, updateLaneParams } = await import('./audio-preview');
    const { studioStore, studioActions } = await import('../store');
    studioActions.__resetForTest();

    play(studioStore.getState());
    const master = toDestination()[0]!;
    const createdBefore = gains.length;

    studioActions.setMasterGain(-6);
    updateLaneParams(studioStore.getState());

    expect(gains.length).toBe(createdBefore);
    expect(toDestination()).toHaveLength(1);
    const num = expect.any(Number) as unknown as number;
    expect(master.gain.setTargetAtTime).toHaveBeenCalledWith(lin(-6), num, num);

    // Dan lagi, ke node yang sama — bukan node baru untuk nilai baru.
    studioActions.setMasterGain(4.5);
    updateLaneParams(studioStore.getState());
    expect(gains.length).toBe(createdBefore);
    expect(master.gain.setTargetAtTime).toHaveBeenLastCalledWith(lin(4.5), num, num);
  });

  it('nilai di luar rentang dijepit di kedua ujung sebelum sampai ke node', async () => {
    const { play, updateLaneParams } = await import('./audio-preview');
    const { studioStore, studioActions } = await import('../store');
    const { MIN_MASTER_GAIN_DB, MAX_MASTER_GAIN_DB } = await import('../model');
    studioActions.__resetForTest();
    play(studioStore.getState());
    const master = toDestination()[0]!;
    const num = expect.any(Number) as unknown as number;

    studioActions.setMasterGain(-500);
    updateLaneParams(studioStore.getState());
    expect(master.gain.setTargetAtTime).toHaveBeenLastCalledWith(
      lin(MIN_MASTER_GAIN_DB),
      num,
      num,
    );

    studioActions.setMasterGain(500);
    updateLaneParams(studioStore.getState());
    expect(master.gain.setTargetAtTime).toHaveBeenLastCalledWith(
      lin(MAX_MASTER_GAIN_DB),
      num,
      num,
    );
  });

  it('peak master dibaca dari tap sesudah amplify, dan hilang saat dibongkar', async () => {
    const { play, stop, teardown, readMasterPeak } = await import('./audio-preview');
    const { studioStore, studioActions } = await import('../store');
    studioActions.__resetForTest();

    expect(readMasterPeak()).toBeNull(); // belum berbunyi = belum terukur
    play(studioStore.getState());
    expect(readMasterPeak()).toBeCloseTo(TAP_PEAK, 6);

    // `stop()` TIDAK lagi membongkar master: pemutar audisi menyambung ke sana
    // dan hidupnya tidak terikat transport. Membongkarnya di stop berarti
    // menekan STOP di timeline membisukan loop yang sedang didengarkan.
    stop();
    expect(readMasterPeak()).toBeCloseTo(TAP_PEAK, 6);

    teardown();
    expect(readMasterPeak()).toBeNull();
  });

  it('tanpa AnalyserNode preview tetap berbunyi; peak-nya yang tidak ada', async () => {
    useCtx(FakeCtxNoAnalyser);
    const { play, readMasterPeak } = await import('./audio-preview');
    const { studioStore, studioActions } = await import('../store');
    studioActions.__resetForTest();

    play(studioStore.getState());
    expect(toDestination()).toHaveLength(1);
    expect(readMasterPeak()).toBeNull();
  });
});
