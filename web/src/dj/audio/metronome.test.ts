/**
 * Penjadwalan metronom.
 *
 * Yang diuji di sini adalah KAPAN klik dijadwalkan, bukan bunyinya: rAF berjalan
 * 60×/detik dan sebuah penjadwal yang naif menghasilkan 60 klik per ketukan —
 * gejalanya bukan "waktunya meleset" melainkan dengung.
 *
 * Web Audio tidak ada di jsdom; contextnya dipalsukan seminimal mungkin, pola
 * yang sama dengan `dj-graph.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BEATS_PER_BAR, type BeatGrid } from '../../studio/analysis/beat-grid';
import { Metronome, type MetroLevel } from './metronome';

const SR = 48_000;
const GRID: BeatGrid = { bpm: 120, offsetSec: 0, beatsPerBar: BEATS_PER_BAR, manual: false };
/** 120 BPM → satu ketukan 0.5 detik → 24 000 sample. */
const SPB = SR / 2;

interface Started {
  readonly at: number;
  readonly hz: number;
}

let started: Started[] = [];

function fakeCtx(): BaseAudioContext {
  const param = (v = 0) => ({
    value: v,
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn(),
  });
  return {
    currentTime: 0,
    sampleRate: SR,
    createGain: () => ({ gain: param(1), connect: vi.fn(), disconnect: vi.fn() }),
    createOscillator: () => {
      const osc = {
        type: '',
        frequency: param(0),
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: (at: number) => started.push({ at, hz: osc.frequency.value }),
        stop: vi.fn(),
        onended: null,
      };
      return osc;
    },
  } as unknown as BaseAudioContext;
}

function makeMetro(): Metronome {
  const ctx = fakeCtx();
  const out = ctx.createGain();
  return new Metronome(ctx, out);
}

function tick(m: Metronome, opts: { pos: number; now: number; rate?: number; level?: MetroLevel }) {
  return m.schedule({
    grid: GRID,
    level: opts.level ?? 2,
    positionSamples: opts.pos,
    rate: opts.rate ?? 1,
    sampleRate: SR,
    now: opts.now,
  });
}

beforeEach(() => {
  started = [];
});

describe('penjadwalan', () => {
  it('tidak menjadwalkan apa pun saat tingkatnya 0', () => {
    const m = makeMetro();
    expect(tick(m, { pos: 0, now: 0, level: 0 })).toBe(0);
    expect(started).toHaveLength(0);
  });

  it('menjadwalkan hanya ketukan di dalam jendela lihat-ke-depan', () => {
    const m = makeMetro();
    // Jendelanya 150 ms, ketukannya 500 ms — jadi paling banyak satu.
    expect(tick(m, { pos: 0, now: 10 })).toBe(1);
  });

  it('rAF yang berjalan 60×/detik TIDAK menghasilkan 60 klik per ketukan', () => {
    const m = makeMetro();
    // Sepuluh frame berturut-turut di dalam ketukan yang sama, dimulai 50 ms
    // sebelum ketukan berikutnya — yaitu di dalam jendela.
    for (let i = 0; i < 10; i++) {
      tick(m, { pos: SPB * 0.9 + i * 100, now: 1 + i * 0.016 });
    }
    // Hanya ketukan ke-1 yang jatuh di depan; sisanya sudah dijadwalkan.
    expect(started).toHaveLength(1);
  });

  it('ketukan berikutnya dijadwalkan begitu ia masuk jendela', () => {
    const m = makeMetro();
    tick(m, { pos: 0, now: 0 });
    expect(started).toHaveLength(1);

    // Maju satu ketukan penuh: ketukan berikutnya kini di depan.
    tick(m, { pos: SPB, now: 0.5 });
    expect(started).toHaveLength(2);
  });

  it('waktunya benar: klik jatuh tepat di ketukan berikutnya', () => {
    const m = makeMetro();
    // Playhead 0.4 ketukan lewat; sisa 0.6 ketukan = 300 ms — di luar jendela.
    expect(tick(m, { pos: SPB * 0.4, now: 100 })).toBe(0);
    // Playhead 0.9 ketukan lewat; sisa 50 ms — masuk.
    expect(tick(m, { pos: SPB * 0.9, now: 100 })).toBe(1);
    expect(started[0]!.at).toBeCloseTo(100 + 0.05, 6);
  });

  it('LAJU BACA ikut: tempo fader +100% memberi klik dua kali lebih rapat', () => {
    const m = makeMetro();
    // Pada rate 2, sisa 0.5 ketukan (250 ms materi) jadi 125 ms nyata — masuk
    // jendela, padahal pada rate 1 ia berada di luarnya.
    expect(tick(m, { pos: SPB * 0.5, now: 0, rate: 1 })).toBe(0);

    const m2 = makeMetro();
    expect(tick(m2, { pos: SPB * 0.5, now: 0, rate: 2 })).toBe(1);
    expect(started[0]!.at).toBeCloseTo(0.125, 6);
  });

  it('downbeat berbunyi lebih tinggi daripada ketukan biasa', () => {
    const m = makeMetro();
    tick(m, { pos: SPB * 3.9, now: 0 }); // ketukan 4 → indeks 4 = downbeat
    const down = started[0]!.hz;

    started = [];
    const m2 = makeMetro();
    tick(m2, { pos: SPB * 0.9, now: 0 }); // ketukan 1 → bukan downbeat
    expect(down).toBeGreaterThan(started[0]!.hz);
  });

  it('melompat mundur memulai deretan lagi — bukan membisu sampai lagunya menyusul', () => {
    const m = makeMetro();
    tick(m, { pos: SPB * 40, now: 20 });
    expect(started).toHaveLength(1);

    // Lompat ke intro. Tanpa reset, `lastBeat` masih 41 dan tidak ada klik
    // yang akan dijadwalkan sampai lagunya kembali ke sana.
    started = [];
    tick(m, { pos: SPB * 0.9, now: 0.45 });
    expect(started).toHaveLength(1);
  });

  it('reset() membuat ketukan yang sama dijadwalkan lagi', () => {
    const m = makeMetro();
    tick(m, { pos: SPB * 0.9, now: 0 });
    expect(started).toHaveLength(1);

    // Frame berikutnya: ketukan itu sudah dijadwalkan, jadi tidak ada yang baru.
    started = [];
    tick(m, { pos: SPB * 0.9 + 100, now: 0.002 });
    expect(started).toHaveLength(0);

    // Setelah reset, deretannya mulai dari nol lagi.
    m.reset();
    tick(m, { pos: SPB * 0.9 + 200, now: 0.004 });
    expect(started).toHaveLength(1);
  });

  it('rate nol atau negatif tidak membuat loop tak berujung', () => {
    const m = makeMetro();
    expect(tick(m, { pos: 0, now: 0, rate: 0 })).toBe(0);
    expect(tick(m, { pos: 0, now: 0, rate: -1 })).toBe(0);
  });
});
