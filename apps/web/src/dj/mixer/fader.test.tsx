/**
 * Posisi cap fader.
 *
 * KELAS BUG YANG DIJAGA: cap yang diam sementara nilainya berubah.
 *
 * Ia pernah terjadi, dan penyebabnya tidak terlihat dari kodenya — cap
 * diposisikan dengan `transform: translateY(calc((100% - 16px) * t))`, dan
 * persentase di dalam `translate()` dihitung terhadap **elemen itu sendiri**,
 * bukan induknya. Untuk cap setinggi 16 px hasilnya selalu `(16px − 16px) * t`
 * = 0. Fadernya terlihat "tidak berfungsi" padahal store, audio, dan angka di
 * layar semuanya benar.
 *
 * jsdom tidak menghitung layout, jadi yang diperiksa adalah GAYA yang
 * dihasilkan — dan itu cukup: yang salah dulu adalah properti mana yang
 * ditulisi, bukan berapa pikselnya.
 */

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Fader } from './Fader';

afterEach(cleanup);

const RECT = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 200,
  bottom: 200,
  width: 200,
  height: 200,
  toJSON: () => ({}),
};

function cap(root: HTMLElement): HTMLElement {
  // Cap adalah satu-satunya anak yang tidak menerima pointer.
  const el = [...root.querySelectorAll('div')].find(
    (d) => d.style.pointerEvents === 'none' && d.style.position === 'absolute',
  );
  if (el === undefined) throw new Error('cap fader tidak ditemukan');
  return el;
}

/**
 * Faktor pengali di dalam `calc(...)`.
 *
 * Diambil dengan regex alih-alih dicocokkan sebagai string, karena jsdom
 * menormalkan urutannya: `calc((100% - 16px) * 0)` ditulis ulang jadi
 * `calc(0 * (100% - 16px))`. Asersi berbasis string akan lulus atau gagal
 * tergantung mesin, dan itu bentuk tes yang paling tidak berguna.
 */
function factorOf(style: string): number {
  const m = /calc\(\s*([\d.]+)\s*\*/.exec(style) ?? /\*\s*([\d.]+)\s*\)/.exec(style);
  if (m?.[1] === undefined) throw new Error(`bukan calc berfaktor: ${style}`);
  return Number(m[1]);
}

const renderFader = (value: number, orientation: 'vertical' | 'horizontal' = 'vertical') =>
  render(
    <Fader
      orientation={orientation}
      value={value}
      onChange={() => undefined}
      label="uji"
      length={200}
    />,
  ).container.firstElementChild as HTMLElement;

describe('cap mengikuti nilai', () => {
  it('tegak: nilai berbeda menghasilkan posisi berbeda', () => {
    const atTop = cap(renderFader(1)).style.top;
    cleanup();
    const atMiddle = cap(renderFader(0.5)).style.top;
    cleanup();
    const atBottom = cap(renderFader(0)).style.top;

    expect(atTop).not.toBe(atMiddle);
    expect(atMiddle).not.toBe(atBottom);
  });

  it('tegak DIBALIK: nilai 1 di atas, nilai 0 di bawah', () => {
    // Sumbu tegak memakai `1 - value`: itu bentuk fisiknya, dan ia ditulis
    // sekali di sini alih-alih diulang di tiap pemanggil.
    expect(factorOf(cap(renderFader(1)).style.top)).toBeCloseTo(0, 9);
    cleanup();
    expect(factorOf(cap(renderFader(0)).style.top)).toBeCloseTo(1, 9);
    cleanup();
    expect(factorOf(cap(renderFader(0.25)).style.top)).toBeCloseTo(0.75, 9);
  });

  it('mendatar TIDAK dibalik: nilai 0 di kiri, nilai 1 di kanan', () => {
    expect(factorOf(cap(renderFader(0, 'horizontal')).style.left)).toBeCloseTo(0, 9);
    cleanup();
    expect(factorOf(cap(renderFader(1, 'horizontal')).style.left)).toBeCloseTo(1, 9);
  });

  it('posisinya di `top`/`left`, BUKAN di `transform`', () => {
    // Persentase di dalam translate() dihitung terhadap elemen itu sendiri —
    // untuk cap 16px hasilnya selalu nol, dan fadernya membeku di ujung.
    const c = cap(renderFader(0.5));
    expect(c.style.transform).toBe('');
    expect(c.style.top).toContain('calc');
  });
});

describe('menyeret', () => {
  it('menggerakkan cap DAN melaporkan nilainya', () => {
    Element.prototype.getBoundingClientRect = () => RECT as DOMRect;
    const onChange = vi.fn();
    const root = render(
      <Fader orientation="vertical" value={1} onChange={onChange} label="uji" length={200} />,
    ).container.firstElementChild as HTMLElement;

    fireEvent.pointerDown(root, { clientX: 0, clientY: 0, button: 0, pointerId: 1 });
    fireEvent.pointerMove(root, { clientX: 0, clientY: 200, pointerId: 1 });

    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as number;
    expect(last).toBeLessThan(0.2);
    // Cap ikut bergerak SELAMA tarikan, bukan hanya setelah React me-render.
    expect(cap(root).style.top).toContain('calc');
  });
});
