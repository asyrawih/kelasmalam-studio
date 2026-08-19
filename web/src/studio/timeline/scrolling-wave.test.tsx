/**
 * Penjaga prop `positionSourceSec`.
 *
 * `ScrollingWave` sekarang punya DUA pemakai: panel Clip Detail di Studio dan
 * deck di halaman `/dj`. Yang pertama tidak boleh bergeser perilakunya sedikit
 * pun karena yang kedua ditambahkan — dan "tidak bergeser" adalah hal yang
 * harus DIBUKTIKAN, bukan diasumsikan.
 */

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ScrollingWave } from './ScrollingWave';
import * as preview from '../preview/audio-preview';

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
  it('memakai jam yang disuntikkan, dan TIDAK memanggil jam preview Studio', () => {
    const spy = vi.spyOn(preview, 'previewPositionSec');
    const mine = vi.fn(() => 1.25);

    render(<ScrollingWave {...base} positionSourceSec={mine} />);

    expect(mine).toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });

  it('tanpa prop, perilaku lama tidak bergeser: jam preview Studio yang dipakai', () => {
    const spy = vi.spyOn(preview, 'previewPositionSec').mockReturnValue(0.5);

    render(<ScrollingWave {...base} />);

    expect(spy).toHaveBeenCalled();
  });
});
