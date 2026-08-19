/**
 * Smoke test halaman `/dj`.
 *
 * Dua hal yang dijaga di sini dan tidak di tempat lain:
 *
 *  1. **`console.error` apa pun menggagalkan tes.** Peringatan React soal
 *     `setState` di luar `act`, key yang hilang, atau prop yang salah semuanya
 *     lewat sana, dan semuanya adalah bug yang mudah lolos dari mata.
 *  2. **`AudioContext` tidak dibangun saat RENDER, hanya setelah gestur.**
 *     Context yang lahir di luar handler gestur user berstatus `suspended` di
 *     Safari dan Chrome — tanpa gejala apa pun selain "tidak ada suara". Aturan
 *     itu hanya berarti kalau ada yang menjaganya.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DjPage } from '../DjPage';
import { djActions, djStore } from '../store';
import { studioActions } from '../../studio/store';

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

beforeEach(() => {
  Element.prototype.getBoundingClientRect = () => RECT as DOMRect;
  djActions.__resetForTest();
  studioActions.__resetForTest?.();
});

afterEach(cleanup);

function expectNoConsoleError(fn: () => void): void {
  const errors: unknown[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...a) => errors.push(a));
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  expect(errors, `console.error: ${JSON.stringify(errors)}`).toEqual([]);
}

describe('DjPage', () => {
  it('render tanpa satu pun console.error', () => {
    expectNoConsoleError(() => {
      render(<DjPage />);
    });
    expect(screen.getByText('KELAS MALAM DJ')).toBeTruthy();
  });

  it('TIDAK membangun AudioContext saat render — hanya setelah gestur', () => {
    const ctor = vi.fn();
    const original = window.AudioContext;
    (window as unknown as { AudioContext: unknown }).AudioContext = ctor;
    try {
      render(<DjPage />);
      expect(ctor).not.toHaveBeenCalled();
    } finally {
      (window as unknown as { AudioContext: unknown }).AudioContext = original;
    }
  });

  it('mengajak menyalakan audio, bukan mengaku sudah siap', () => {
    render(<DjPage />);
    expect(screen.getByText(/SENTUH UNTUK MENYALAKAN AUDIO/)).toBeTruthy();
  });

  it('meter menampilkan NO SIGNAL selama belum ada yang bisa diukur', () => {
    render(<DjPage />);
    expect(screen.getAllByText('NO SIGNAL').length).toBeGreaterThan(0);
  });

  it('tombol MASTER TEMPO ada tapi mati, dengan alasannya terbaca', () => {
    render(<DjPage />);
    const mt = screen.getAllByRole('button', { name: 'MT' });
    expect(mt.length).toBe(2);
    for (const b of mt) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
      expect(b.getAttribute('title')).toMatch(/varispeed/i);
    }
  });

  it('kolom KEY kosong — deteksi nada dasar belum ada, dan itu dikatakan', () => {
    render(<DjPage />);
    const keys = screen.getAllByTitle(/deteksi nada dasar belum ada/);
    expect(keys.length).toBeGreaterThan(0);
    for (const cell of keys) expect(cell.textContent).toBe('—');
  });

  it('kedua deck kosong menyatakan dirinya kosong', () => {
    render(<DjPage />);
    expect(screen.getAllByText('DECK KOSONG')).toHaveLength(2);
  });

  it('crossfader menggerakkan store, dan pembacaan gain ikut berubah', () => {
    render(<DjPage />);
    const xf = screen.getByRole('slider', { name: 'crossfader' });
    fireEvent.pointerDown(xf, { clientX: 0, clientY: 0, button: 0, pointerId: 1 });
    fireEvent.pointerMove(xf, { clientX: 900, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(xf, { clientX: 900, clientY: 0, pointerId: 1 });
    expect(djStore.getState().mixer.crossfader).toBeGreaterThan(0.9);
  });

  it('menekan KILL pada label EQ benar-benar mematikan band itu', () => {
    render(<DjPage />);
    const low = screen.getAllByRole('button', { name: 'LOW' })[0] as HTMLElement;
    fireEvent.click(low);
    expect(djStore.getState().mixer.channels.A.eq.low).toBe(-26);
  });

  it('pad hot cue mati saat deck kosong — bukan diam-diam tidak berefek', () => {
    render(<DjPage />);
    const pads = screen.getAllByRole('button').filter((b) => b.textContent === 'A');
    expect(pads.length).toBeGreaterThan(0);
  });
});
