/**
 * Penjaga prop `positionSourceSec`.
 *
 * `ScrollingWave` punya DUA pemakai: panel Clip Detail di Studio dan deck di
 * halaman `/dj`. Sejak docs/25 P4 komponen ini hidup di `studio-core` dan tidak
 * tahu pemutar mana pun — jamnya DISUNTIKKAN. Yang harus dibuktikan: jam yang
 * disuntikkan benar-benar dipakai, dan tanpa jam ia jatuh ke `playhead` (tidak
 * diam-diam mengimpor pemutar Studio kembali).
 */

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ScrollingWave } from './ScrollingWave';

/**
 * jsdom melaporkan ukuran nol untuk setiap elemen, dan `fitCanvas` keluar lebih
 * awal saat itu terjadi — artinya `paint()` tidak pernah sampai ke `centerOf`
 * dan tes ini akan "lulus" tanpa menjalankan apa pun yang diuji. Pola stub yang
 * sama dipakai `studio/__tests__/studio-smoke.test.tsx`.
 */
const RECT = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 900,
  bottom: 120,
  width: 900,
  height: 120,
  toJSON: () => ({}),
};

beforeEach(() => {
  Element.prototype.getBoundingClientRect = () => RECT as DOMRect;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const base = {
  asset: undefined,
  grid: null,
  sampleRate: 48_000,
  clipSourceStart: 0,
  clipSourceLen: 48_000,
  clipStart: 0,
  speedRatio: 1,
  windowLen: 48_000,
  playhead: 0,
  playing: true,
  auditioning: false,
} as const;

describe('ScrollingWave: sumber posisi', () => {
  it('memakai jam yang disuntikkan', () => {
    const mine = vi.fn(() => 1.25);
    render(<ScrollingWave {...base} positionSourceSec={mine} />);
    expect(mine).toHaveBeenCalled();
  });

  it('saat audisi, jam audisi yang disuntikkan yang dibaca', () => {
    const transport = vi.fn(() => 1.25);
    const audition = vi.fn(() => 0.5);
    render(
      <ScrollingWave
        {...base}
        auditioning
        positionSourceSec={transport}
        auditionSourceSec={audition}
      />,
    );
    expect(audition).toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('tanpa jam, tetap menggambar dari `playhead` — tidak melempar', () => {
    expect(() => render(<ScrollingWave {...base} />)).not.toThrow();
  });
});
