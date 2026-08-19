/**
 * Penjaga tata letak.
 *
 * Kelas bug yang dijaga: **grid blowout**. Track grid tanpa `minmax(0, …)`
 * memakai `min-content`, sehingga satu canvas atau satu tabel panjang mendorong
 * seluruh halaman melebar alih-alih menggulir di dalam dirinya sendiri. Di
 * halaman `overflow: hidden` gejalanya lebih buruk daripada di Studio: isinya
 * TERPOTONG TANPA SCROLLBAR, jadi tidak ada petunjuk apa pun bahwa ada yang
 * hilang — tidak ada yang akan melaporkannya sebagai bug.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DjPage } from '../DjPage';
import { djActions } from '../store';
import { bandFor } from './useViewportBand';

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

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true });
}

beforeEach(() => {
  Element.prototype.getBoundingClientRect = () => RECT as DOMRect;
  djActions.__resetForTest();
  setViewport(1440, 900);
});

afterEach(cleanup);

const root = (): HTMLElement => {
  const el = document.querySelector('[data-dj-root]');
  if (el === null) throw new Error('akar halaman DJ tidak ditemukan');
  return el as HTMLElement;
};

describe('pita tinggi viewport', () => {
  it('tiga ambang, dan nilainya primitif supaya resize tidak me-render tiap piksel', () => {
    expect(bandFor(640)).toBe('compact');
    expect(bandFor(800)).toBe('normal');
    expect(bandFor(1000)).toBe('tall');
  });
});

describe('grid halaman', () => {
  it('setinggi viewport dan TIDAK menggulir tegak', () => {
    render(<DjPage />);
    expect(root().style.height).toBe('100vh');
    expect(root().style.overflowY).toBe('hidden');
  });

  it('setiap baris memakai minmax(0, …) — penjaga terhadap grid blowout', () => {
    render(<DjPage />);
    const rows = root().style.gridTemplateRows;
    expect(rows).toContain('minmax(0,1fr)');
    // Baris yang melar HANYA baris deck+mixer; kalau ada dua `1fr`, salah satu
    // dari waveform/FX/browser ikut memakan sisa tinggi dan deck menyusut.
    expect(rows.match(/1fr/g)).toHaveLength(1);
  });

  it('boleh menggulir MENDATAR di bawah 1024px, dan mengatakannya', () => {
    setViewport(900, 900);
    render(<DjPage />);
    expect(root().style.overflowX).toBe('auto');
    expect(root().style.minWidth).toBe('1024px');
    expect(screen.getByText('LAYAR SEMPIT')).toBeTruthy();
  });

  it('layar yang terlalu pendek dikatakan, bukan ditata ulang diam-diam', () => {
    setViewport(1440, 500);
    render(<DjPage />);
    expect(screen.getByText(/TINGGI LAYAR/)).toBeTruthy();
  });

  it('baris utama tiga kolom, dan ketiganya minmax — deck tidak boleh terdorong', () => {
    render(<DjPage />);
    const decks = document.querySelectorAll('[data-dj-deck]');
    expect(decks).toHaveLength(2);
    const grid = decks[0]?.parentElement as HTMLElement;
    expect(grid.style.gridTemplateColumns).toBe(
      'minmax(320px,1fr) minmax(240px,320px) minmax(320px,1fr)',
    );
  });
});
