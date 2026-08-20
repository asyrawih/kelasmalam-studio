/**
 * Klik lane kosong → file manager, dan bar progres yang muncul di lane itu.
 *
 * Yang paling gampang rusak: ketukan pembuka dialog hidup di gerakan yang SAMA
 * dengan kotak seleksi. Karena itu tes ini tidak hanya membuktikan dialognya
 * terbuka, tapi juga membuktikan ia TIDAK terbuka saat pointer benar-benar
 * ditarik — kalau tidak, tiap kotak seleksi yang melewati lane kosong akan
 * menyembulkan dialog dan membatalkan seleksi yang baru saja dibuat.
 */

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_FADE_CURVE, laneHeightPx, type StudioClip } from '../model';

const started: { name: string; laneId: string; start: number; avoidOverlap?: boolean }[] = [];

vi.mock('./lane-import', () => ({
  runFileImport: (
    file: File,
    laneId: string,
    start: number,
    _sr: number,
    opts?: { avoidOverlap?: boolean },
  ) => {
    started.push({ name: file.name, laneId, start, avoidOverlap: opts?.avoidOverlap });
    return Promise.resolve({ ok: true });
  },
  runUrlImport: () => Promise.resolve({ ok: true }),
}));

const { ClipArea } = await import('./ClipArea');
const { studioActions, studioStore } = await import('../store');

const SR = 48_000;
const TRACK_W = 1000;

Element.prototype.getBoundingClientRect = function (this: Element) {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: TRACK_W,
    bottom: 400,
    width: TRACK_W,
    height: 400,
    toJSON: () => ({}),
  } as DOMRect;
};
Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
  configurable: true,
  get: () => TRACK_W,
});

function clip(id: string): StudioClip {
  return {
    id,
    assetId: 1,
    chain: [],
    start: 0,
    len: 4 * SR,
    sourceStart: 0,
    sourceLen: 4 * SR,
    label: id,
    gainDb: 0,
    fadeInMs: 0,
    fadeOutMs: 0,
    fadeCurve: DEFAULT_FADE_CURVE,
    seed: 1,
  };
}

function Harness(): JSX.Element {
  return (
    <ClipArea
      scrollerRef={{ current: null }}
      trackWidth="1000px"
      onScroll={() => undefined}
      onDraggingChange={() => undefined}
      onImportError={() => undefined}
    />
  );
}

function scroller(): HTMLElement {
  const el = document.querySelector('[data-tl-scroll]');
  if (el === null) throw new Error('scroller tidak ada');
  return el as HTMLElement;
}

function fileInput(): HTMLInputElement {
  const el = document.querySelector('[data-lane-file-input]');
  if (el === null) throw new Error('input file tidak ada');
  return el as HTMLInputElement;
}

/** Tengah baris lane ke-`i`, dalam koordinat track. */
function laneY(i: number): number {
  const h = laneHeightPx(studioStore.getState().laneHeight);
  return i * h + h / 2;
}

let laneA = '';
let laneB = '';

beforeEach(() => {
  started.length = 0;
  studioActions.__resetForTest('empty');
  if (studioStore.getState().lanes.length < 2) studioActions.addLane();
  const [a, b] = studioStore.getState().lanes.map((l) => l.id);
  laneA = a!;
  laneB = b!;
});

afterEach(cleanup);

describe('ketukan di lane kosong', () => {
  it('membuka dialog berkas', () => {
    render(<Harness />);
    const open = vi.spyOn(fileInput(), 'click').mockImplementation(() => undefined);

    fireEvent.pointerDown(scroller(), { button: 0, pointerId: 1, clientX: 300, clientY: laneY(0) });
    fireEvent.pointerUp(scroller(), { button: 0, pointerId: 1, clientX: 300, clientY: laneY(0) });

    expect(open).toHaveBeenCalledTimes(1);
  });

  it('TIDAK membuka dialog kalau pointer benar-benar ditarik (kotak seleksi)', () => {
    render(<Harness />);
    const open = vi.spyOn(fileInput(), 'click').mockImplementation(() => undefined);

    fireEvent.pointerDown(scroller(), { button: 0, pointerId: 1, clientX: 300, clientY: laneY(0) });
    fireEvent.pointerMove(scroller(), { pointerId: 1, clientX: 460, clientY: laneY(1) });
    fireEvent.pointerUp(scroller(), { button: 0, pointerId: 1, clientX: 460, clientY: laneY(1) });

    expect(open).not.toHaveBeenCalled();
  });

  it('TIDAK membuka dialog di lane yang sudah berisi clip', () => {
    studioActions.addClip(laneA, clip('x'));
    render(<Harness />);
    const open = vi.spyOn(fileInput(), 'click').mockImplementation(() => undefined);

    fireEvent.pointerDown(scroller(), { button: 0, pointerId: 1, clientX: 900, clientY: laneY(0) });
    fireEvent.pointerUp(scroller(), { button: 0, pointerId: 1, clientX: 900, clientY: laneY(0) });

    expect(open).not.toHaveBeenCalled();
  });

  it('TIDAK membuka dialog saat Shift ditahan — itu gerakan menambah seleksi', () => {
    render(<Harness />);
    const open = vi.spyOn(fileInput(), 'click').mockImplementation(() => undefined);

    fireEvent.pointerDown(scroller(), {
      button: 0,
      pointerId: 1,
      clientX: 300,
      clientY: laneY(0),
      shiftKey: true,
    });
    fireEvent.pointerUp(scroller(), { button: 0, pointerId: 1, clientX: 300, clientY: laneY(0) });

    expect(open).not.toHaveBeenCalled();
  });
});

describe('berkas yang dipilih', () => {
  function pick(names: readonly string[], laneIndex: number, clientX: number): void {
    render(<Harness />);
    const input = fileInput();
    vi.spyOn(input, 'click').mockImplementation(() => undefined);
    fireEvent.pointerDown(scroller(), {
      button: 0,
      pointerId: 1,
      clientX,
      clientY: laneY(laneIndex),
    });
    fireEvent.pointerUp(scroller(), {
      button: 0,
      pointerId: 1,
      clientX,
      clientY: laneY(laneIndex),
    });
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: names.map((name) => ({ name }) as unknown as File),
    });
    fireEvent.change(input);
  }

  it('masuk ke lane yang diketuk, di posisi ketukannya', () => {
    // 300 px dari 1000 px track = 30% dari durasi project.
    const expected = 0.3 * studioStore.getState().duration;
    pick(['a.wav'], 1, 300);

    expect(started).toHaveLength(1);
    expect(started[0]!.laneId).toBe(laneB);
    expect(started[0]!.start).toBeCloseTo(expected, 0);
  });

  it('beberapa berkas sekaligus: semuanya mulai, dan diminta tidak menumpuk', () => {
    pick(['a.wav', 'b.wav', 'c.wav'], 0, 100);

    expect(started.map((s) => s.name)).toEqual(['a.wav', 'b.wav', 'c.wav']);
    expect(started.every((s) => s.laneId === laneA)).toBe(true);
    expect(started.every((s) => s.avoidOverlap === true)).toBe(true);
  });

  it('satu berkas: posisinya dihormati apa adanya', () => {
    pick(['a.wav'], 0, 100);
    expect(started[0]!.avoidOverlap).toBe(false);
  });
});

describe('bar progres di lane', () => {
  it('menampilkan nama, tahap, dan persen di lane yang bersangkutan', () => {
    render(<Harness />);
    act(() => studioActions.beginImport({ id: 'j1', laneId: laneA, name: 'lagu-panjang.wav' }));
    act(() => studioActions.setImportStage('j1', 'reading', 0.42));

    const row = document.querySelector('[data-import-job="j1"]');
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain('lagu-panjang.wav');
    expect(row!.textContent).toContain('MEMBACA');
    expect(row!.textContent).toContain('42%');
  });

  it('tahap tanpa ukuran tidak memajang persen palsu', () => {
    render(<Harness />);
    act(() => studioActions.beginImport({ id: 'j1', laneId: laneA, name: 'lagu.wav' }));
    act(() => studioActions.setImportStage('j1', 'decoding', null));

    const row = document.querySelector('[data-import-job="j1"]');
    expect(row!.textContent).toContain('DECODE');
    expect(row!.textContent).not.toMatch(/\d+%/);
    expect(row!.getAttribute('aria-valuenow')).toBeNull();
  });

  it('tiga import di lane yang sama tampil tiga, dan lane lain tidak ikut', () => {
    render(<Harness />);
    act(() => studioActions.beginImport({ id: 'j1', laneId: laneA, name: 'a.wav' }));
    act(() => studioActions.beginImport({ id: 'j2', laneId: laneA, name: 'b.wav' }));
    act(() => studioActions.beginImport({ id: 'j3', laneId: laneB, name: 'c.wav' }));

    const rows = (laneId: string): number => {
      const row = document.querySelector(`[data-lane-row="${laneId}"]`);
      return row === null ? 0 : row.querySelectorAll('[data-import-job]').length;
    };
    expect(rows(laneA)).toBe(2);
    expect(rows(laneB)).toBe(1);
  });

  it('ajakan "klik atau drop" menyingkir selama lane itu sedang memuat', () => {
    render(<Harness />);
    const invite = (laneId: string): boolean => {
      const row = document.querySelector(`[data-lane-row="${laneId}"]`);
      return row !== null && row.textContent!.includes('KLIK ATAU DROP AUDIO DI SINI');
    };
    expect(invite(laneA)).toBe(true);

    act(() => studioActions.beginImport({ id: 'j1', laneId: laneA, name: 'a.wav' }));
    expect(invite(laneA)).toBe(false);
    // Lane lain tidak terpengaruh.
    expect(invite(laneB)).toBe(true);

    act(() => studioActions.endImport('j1'));
    expect(invite(laneA)).toBe(true);
  });
});
