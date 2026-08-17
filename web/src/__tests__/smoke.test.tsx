/**
 * Smoke test: render App + tiap panel di jsdom (dengan canvas mock) dan
 * pastikan tidak ada yang melempar. Ini menangkap kelas bug paling umum di UI
 * yang belum pernah dijalankan di browser.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import * as panels from '../ui/panels';

// jsdom melaporkan semua elemen berukuran 0. Itu membuat `fitCanvas` bail out
// dan jalur gambar TIDAK PERNAH dieksekusi — kita justru ingin dieksekusi.
// Jadi kita beri ukuran realistis untuk semua elemen.
const RECT = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 800,
  bottom: 200,
  width: 800,
  height: 200,
  toJSON: () => ({}),
};
Element.prototype.getBoundingClientRect = () => RECT as DOMRect;

afterEach(cleanup);

describe('App', () => {
  it('mounts tanpa engine (degraded mode)', () => {
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => errors.push(a));
    expect(() => render(<App />)).not.toThrow();
    spy.mockRestore();
    expect(errors, `console.error saat mount: ${JSON.stringify(errors)}`).toEqual([]);
  });

  it('mounts dengan createEngine yang gagal', () => {
    expect(() =>
      render(<App createEngine={async () => { throw new Error('no wasm'); }} />),
    ).not.toThrow();
  });
});

describe('panels', () => {
  const entries = Object.entries(panels) as [string, () => JSX.Element][];
  it('mengekspor semua panel', () => {
    expect(entries.length).toBeGreaterThan(10);
  });
  for (const [name, Panel] of entries) {
    it(`${name} mounts sendirian`, () => {
      const errors: unknown[] = [];
      const spy = vi.spyOn(console, 'error').mockImplementation((...a) => errors.push(a));
      expect(() => render(<Panel />)).not.toThrow();
      spy.mockRestore();
      expect(errors, `${name} console.error: ${JSON.stringify(errors)}`).toEqual([]);
    });
  }
});

describe('panels dengan layout nol (belum di-layout)', () => {
  it('tidak crash saat getBoundingClientRect 0x0', () => {
    const zero = { ...RECT, width: 0, height: 0, right: 0, bottom: 0 };
    const orig = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = () => zero as DOMRect;
    try {
      for (const [name, Panel] of Object.entries(panels) as [string, () => JSX.Element][]) {
        expect(() => render(<Panel />), name).not.toThrow();
        cleanup();
      }
    } finally {
      Element.prototype.getBoundingClientRect = orig;
    }
  });
});
