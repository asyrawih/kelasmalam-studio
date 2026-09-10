/**
 * PLAYHEAD IKUT JAM AUDIO, bukan jumlah tick.
 *
 * Bug yang dikunci di sini pernah benar-benar dilaporkan: "playhead belum sampai
 * ujung tapi lagunya sudah selesai". Penyebabnya bukan zoom (posisi garis dan
 * posisi clip sama-sama persen dari `duration`, jadi zoom menskalakan keduanya),
 * melainkan DUA JAM yang berbeda. Audio berjalan di `AudioContext.currentTime`;
 * playhead dulu dijumlahkan sendiri sebesar 60 ms per tick `setInterval`.
 * Periode `setInterval` dihitung ulang setelah callback selesai — jadi satu tick
 * memakan 60 ms + waktu render — dan tab yang tidak aktif dicekik sampai
 * 1×/detik. Galatnya searah dan menumpuk, jadi makin panjang lagunya makin jauh
 * garisnya tertinggal.
 *
 * Karena itu yang diuji di sini adalah TICK YANG TERLAMBAT: jam audio dimajukan
 * jauh lebih cepat daripada jumlah tick yang dijalankan. Dengan delta 60 ms per
 * tick, tes ini gagal dengan angka yang jelas (1,2 detik alih-alih 10); dengan
 * posisi absolut dari jam audio, jumlah tick tidak lagi menentukan posisi.
 *
 * Jalur CADANGAN (tanpa AudioContext, mode UI-only) sudah dikunci
 * `__tests__/studio-smoke.test.tsx` — di jsdom polos tidak ada AudioContext,
 * jadi di sana playhead memang berjalan dari jumlah tick.
 */

import { cleanup, render } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StudioPage } from '../StudioPage';
import { samplesToSec } from './model';
import { registerBuffer, teardown } from './preview/audio-preview';
import { studioActions, studioStore } from './store';

const SR = 48_000;
/** Sama dengan `START_LOOKAHEAD_SEC` di `preview/audio-preview.ts`. */
const LOOKAHEAD_SEC = 0.05;
/** Sama dengan `TICK_MS` di `StudioPage.tsx`. */
const TICK_MS = 60;

const RECT = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 900,
  bottom: 300,
  width: 900,
  height: 300,
  toJSON: () => ({}),
};

const param = (v = 0) => ({
  value: v,
  setTargetAtTime: vi.fn(),
  setValueAtTime: vi.fn(),
  linearRampToValueAtTime: vi.fn(),
  setValueCurveAtTime: vi.fn(),
  cancelScheduledValues: vi.fn(),
});

/**
 * Web Audio dipalsukan seminimal mungkin — yang dipakai tes ini hanya
 * `currentTime`. Alasan yang sama dengan `preview/preview-position.test.ts`.
 *
 * SATU instance untuk seluruh berkas, bukan satu per tes: `studio-core`
 * menyimpan context-nya (`ensureContext`) dan tidak pernah menggantinya, jadi
 * membuat context baru tiap tes hanya menghasilkan jam yang tidak dibaca
 * siapa pun.
 */
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

const ctx = new FakeCtx();

/** Playhead dalam detik. `samplesToSec` butuh sample rate; project demo 48 kHz. */
const headSec = (): number => samplesToSec(studioStore.getState().playhead, SR);

/** Playhead di nol dan LOOP mati: yang diuji di bawah adalah jalan lurus
 *  sampai ujung materi. `__resetForTest` sengaja menyalakan LOOP. */
function armTransport(): void {
  studioActions.__resetForTest();
  studioActions.setPlayhead(0);
  expect(studioStore.getState().loop).toBe(true);
  studioActions.toggleLoop();
  // PCM palsu untuk aset demo, supaya voice-nya benar-benar dirakit — bukan
  // dilewati sebagai "clip demo tanpa audio".
  registerBuffer(0, {
    length: 300 * SR,
    duration: 300,
    numberOfChannels: 2,
  } as unknown as AudioBuffer);
}

beforeEach(() => {
  Element.prototype.getBoundingClientRect = () => RECT as DOMRect;
  (globalThis as { AudioContext?: unknown }).AudioContext = class {
    constructor() {
      return ctx;
    }
  };
  ctx.currentTime = 100;
  teardown();
  armTransport();
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  teardown();
});

/** Jalankan satu tick UI. */
function tickOnce(): void {
  act(() => {
    vi.advanceTimersByTime(TICK_MS);
  });
}

describe('playhead mengikuti jam audio', () => {
  it('tidak tertinggal walau tick datang jauh lebih jarang dari waktu nyata', () => {
    render(<StudioPage />);
    act(() => {
      studioActions.setPlaying(true);
    });

    // 10 detik audio benar-benar keluar dari speaker, tapi timer UI hanya sempat
    // berjalan 20 kali — persis situasi tab yang tidak aktif atau render berat.
    for (let i = 0; i < 20; i += 1) {
      ctx.currentTime += 0.5;
      tickOnce();
    }

    // 20 × 60 ms = 1,2 detik. Itu angka yang dipajang versi lama.
    expect(headSec()).toBeCloseTo(10 - LOOKAHEAD_SEC, 2);
  });

  it('berhenti di ujung materi saat AUDIO-nya habis, bukan saat tick-nya cukup', () => {
    render(<StudioPage />);
    const contentEnd = studioStore.getState().contentEnd;
    const endSec = samplesToSec(contentEnd, SR);
    expect(endSec).toBeGreaterThan(10);

    act(() => {
      studioActions.setPlaying(true);
    });
    // Jam audio melewati ujung materi. Satu tick saja sudah cukup untuk
    // mengetahuinya; dengan delta 60 ms per tick, transport masih akan mengaku
    // play di sekitar detik nol — itulah "audionya selesai tapi playhead-nya
    // belum sampai ujung".
    ctx.currentTime += endSec + 1;
    tickOnce();

    expect(studioStore.getState().playing).toBe(false);
    expect(studioStore.getState().playhead).toBe(contentEnd);
  });

  it('kecepatan transport tidak dihitung dua kali', () => {
    render(<StudioPage />);
    act(() => {
      studioActions.setSpeed(2);
      studioActions.setPlaying(true);
    });

    ctx.currentTime += LOOKAHEAD_SEC + 4; // 4 detik nyata pada 2×
    tickOnce();

    // 8 detik timeline, sama dengan `previewPositionSec()` — satu-satunya tempat
    // `speed` diterapkan ke posisi sekarang.
    expect(headSec()).toBeCloseTo(8, 6);
  });

  it('LOOP mengulang dari nol begitu jam audio melewati ujung materi', () => {
    render(<StudioPage />);
    act(() => {
      studioActions.toggleLoop(); // nyalakan lagi
    });
    expect(studioStore.getState().loop).toBe(true);

    act(() => {
      studioActions.setPlaying(true);
    });
    ctx.currentTime += samplesToSec(studioStore.getState().contentEnd, SR) + 1;
    tickOnce();

    expect(studioStore.getState().playing).toBe(true);
    // `play()` dari seekEpoch yang naik memasang titik ikat baru di nol, jadi
    // putaran kedua tidak langsung melompat ke ujung lagi.
    expect(headSec()).toBeLessThan(1);
  });
});

describe('tickTo — posisi absolut', () => {
  it('menyetel posisi apa adanya, tidak menumpuk delta', () => {
    studioActions.setPlaying(true);
    studioActions.tickTo(12);
    studioActions.tickTo(12.5);
    expect(studioStore.getState().playhead).toBe(12.5 * SR);
  });

  it('diam saat transport berhenti dan saat playhead sedang di-drag', () => {
    studioActions.tickTo(30); // belum play
    expect(studioStore.getState().playhead).toBe(0);

    studioActions.setPlaying(true);
    studioActions.beginScrub();
    studioActions.setPlayhead(10 * SR);
    studioActions.tickTo(30);
    expect(studioStore.getState().playhead).toBe(10 * SR);
  });

  it('mengulang dari nol di ujung materi kalau LOOP menyala, dan seekEpoch naik', () => {
    studioActions.setPlaying(true);
    studioActions.toggleLoop();
    const before = studioStore.getState().seekEpoch;
    studioActions.tickTo(samplesToSec(studioStore.getState().contentEnd, SR) + 1);
    expect(studioStore.getState().playhead).toBe(0);
    expect(studioStore.getState().playing).toBe(true);
    expect(studioStore.getState().seekEpoch).toBeGreaterThan(before);
  });

  it('tanpa LOOP berhenti tepat di ujung materi', () => {
    studioActions.setPlaying(true);
    studioActions.tickTo(samplesToSec(studioStore.getState().contentEnd, SR) + 30);
    expect(studioStore.getState().playing).toBe(false);
    expect(studioStore.getState().playhead).toBe(studioStore.getState().contentEnd);
  });
});
