/**
 * Rail dua kolom: peta span, hit-test drag 2D, dan syarat jatuh ke satu kolom.
 *
 * jsdom tidak punya layout sama sekali — semua elemen berukuran 0. Kotak panel
 * karena itu DISUNTIKKAN: lebar tumpukan lewat stub `getBoundingClientRect` di
 * prototype (pola yang sama dengan `rail/rail.test.tsx`), dan kotak tiap panel
 * lewat override per-elemen sesudah render. Yang diuji jadi benar-benar
 * matematika penempatannya, bukan kebetulan angka nol.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { StudioRail } from '../rail';
import { studioActions, studioStore } from '../store';
import {
  MIN_TWO_COLUMN_WIDTH,
  ReorderableStack,
  effectiveColumns,
  findDropTarget,
  insertPosition,
  toMoveIndex,
  type ItemRect,
} from './ReorderableStack';

// Lebar yang dilaporkan jsdom untuk SEMUA elemen. Diubah per-test untuk menguji
// jatuhnya ke satu kolom.
let reportedWidth = 600;
Element.prototype.getBoundingClientRect = function (): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: reportedWidth,
    bottom: 100,
    width: reportedWidth,
    height: 100,
    toJSON: () => ({}),
  } as DOMRect;
};

// jsdom belum mengimplementasikan Pointer Capture; gagang drag memakainya.
const captured = new Set<number>();
Element.prototype.setPointerCapture = function (id: number): void {
  captured.add(id);
};
Element.prototype.releasePointerCapture = function (id: number): void {
  captured.delete(id);
};
Element.prototype.hasPointerCapture = function (id: number): boolean {
  return captured.has(id);
};

/**
 * Susunan rail dua kolom pada rail 600 px, gap 14 px:
 *
 *   0 transport    ┃ span 2, baris sendiri
 *   1 rail-tabs    ┃ span 2, baris sendiri
 *   2 amplify      ┃ kiri  ┃ 3 render-speed ┃ kanan  (satu baris)
 *   4 shortcuts    ┃ kiri  ┃                ┃        (baris terakhir)
 */
const LAYOUT: readonly ItemRect[] = [
  { left: 0, right: 600, top: 0, bottom: 100 },
  { left: 0, right: 600, top: 114, bottom: 214 },
  { left: 0, right: 293, top: 228, bottom: 328 },
  { left: 307, right: 600, top: 228, bottom: 328 },
  { left: 0, right: 293, top: 342, bottom: 442 },
];

const asDomRect = (r: ItemRect): DOMRect =>
  ({
    ...r,
    x: r.left,
    y: r.top,
    width: r.right - r.left,
    height: r.bottom - r.top,
    toJSON: () => ({}),
  }) as DOMRect;

/** Render rail lalu tempelkan `LAYOUT` ke tiap pembungkus panel. */
function renderRail(): HTMLElement {
  const { container } = render(<StudioRail />);
  const stack = container.firstElementChild as HTMLElement;
  Array.from(stack.children).forEach((el, i) => {
    const r = LAYOUT[i];
    if (r === undefined) return;
    (el as HTMLElement).getBoundingClientRect = () => asDomRect(r);
  });
  return stack;
}

const grip = (id: string): HTMLElement => screen.getByLabelText(`pindahkan panel ${id}`);

const wrapperOf = (id: string): HTMLElement => grip(id).parentElement as HTMLElement;

function dragTo(id: string, clientX: number, clientY: number, drop = true): void {
  const handle = grip(id);
  fireEvent.pointerDown(handle, { pointerId: 1, button: 0 });
  fireEvent.pointerMove(handle, { pointerId: 1, clientX, clientY });
  if (drop) fireEvent.pointerUp(handle, { pointerId: 1, clientX, clientY });
}

const railOrder = (): readonly string[] => studioStore.getState().railOrder;

afterEach(() => {
  cleanup();
  studioActions.__resetForTest();
  reportedWidth = 600;
});

// ── Berapa kolom ─────────────────────────────────────────────────────────────

describe('jumlah kolom efektif', () => {
  it('tumpukan satu kolom tetap satu kolom, selebar apa pun', () => {
    expect(effectiveColumns(1, 2000)).toBe(1);
  });

  it('lebar yang belum terukur (0) tidak pernah menghasilkan dua kolom', () => {
    // Menebak lalu salah = kartu sempit sempat tergambar sebelum koreksi.
    expect(effectiveColumns(2, 0)).toBe(1);
  });

  it('tepat di ambang sudah dua kolom, sepiksel di bawahnya belum', () => {
    expect(effectiveColumns(2, MIN_TWO_COLUMN_WIDTH)).toBe(2);
    expect(effectiveColumns(2, MIN_TWO_COLUMN_WIDTH - 1)).toBe(1);
  });
});

// ── Peta span ────────────────────────────────────────────────────────────────

describe('span per panel di rail', () => {
  it('transport dan rail-tabs selebar rail, sisanya setengah', () => {
    renderRail();
    expect(wrapperOf('transport').style.gridColumn).toBe('span 2');
    expect(wrapperOf('rail-tabs').style.gridColumn).toBe('span 2');
    for (const id of ['amplify', 'render-speed', 'shortcuts']) {
      expect(wrapperOf(id).style.gridColumn).toBe('span 1');
    }
  });

  it('rail memang digrid dua kolom saat lebarnya cukup', () => {
    const stack = renderRail();
    expect(stack.style.gridTemplateColumns).toBe('repeat(2,minmax(0,1fr))');
  });
});

// ── Fallback sempit ──────────────────────────────────────────────────────────

describe('rail sempit jatuh ke satu kolom', () => {
  it('di bawah ambang: satu kolom, dan span 2 ikut runtuh jadi span 1', () => {
    // 500 px dua kolom = ~243 px per kartu; slider presisi rusak di sana.
    reportedWidth = 500;
    const stack = renderRail();
    expect(stack.style.gridTemplateColumns).toBe('minmax(0,1fr)');
    // Kalau span 2 dibiarkan pada grid satu kolom, grid membuat baris hantu.
    expect(wrapperOf('transport').style.gridColumn).toBe('span 1');
    expect(wrapperOf('amplify').style.gridColumn).toBe('span 1');
  });
});

// ── Tumpukan kolom kiri tidak ikut berubah ───────────────────────────────────

describe('tumpukan utama tetap satu kolom', () => {
  it('tanpa prop `columns`, span pada item diabaikan', () => {
    const { container } = render(
      <ReorderableStack
        items={[
          { id: 'timeline', node: <div>timeline</div>, span: 2 },
          { id: 'clip-detail', node: <div>detail</div>, span: 2 },
        ]}
      />,
    );
    const stack = container.firstElementChild as HTMLElement;
    expect(stack.style.gridTemplateColumns).toBe('minmax(0,1fr)');
    expect(wrapperOf('timeline').style.gridColumn).toBe('span 1');
    expect(wrapperOf('clip-detail').style.gridColumn).toBe('span 1');
  });
});

// ── Hit-test 2D, murni ───────────────────────────────────────────────────────

describe('hit-test target drop', () => {
  it('panel berdampingan diputus oleh sumbu X, bukan Y', () => {
    // Separuh kiri render-speed → sisip SEBELUM-nya.
    expect(findDropTarget(LAYOUT, 350, 280)).toEqual({ index: 3, side: 'before', axis: 'x' });
    // Separuh kanan render-speed, tinggi yang SAMA → sisip SESUDAH-nya.
    expect(findDropTarget(LAYOUT, 560, 280)).toEqual({ index: 3, side: 'after', axis: 'x' });
  });

  it('panel selebar rail diputus oleh sumbu Y', () => {
    expect(findDropTarget(LAYOUT, 300, 20)).toEqual({ index: 0, side: 'before', axis: 'y' });
    expect(findDropTarget(LAYOUT, 300, 90)).toEqual({ index: 0, side: 'after', axis: 'y' });
  });

  it('pointer di celah antar kartu tetap menargetkan yang terdekat', () => {
    // x=300 jatuh persis di gap kolom baris amplify/render-speed.
    expect(findDropTarget(LAYOUT, 300, 280)?.index).toBe(2);
    // Jauh di bawah baris terakhir.
    expect(findDropTarget(LAYOUT, 100, 900)).toEqual({ index: 4, side: 'after', axis: 'y' });
  });

  it('daftar kosong tidak punya target', () => {
    expect(findDropTarget([], 10, 10)).toBeNull();
  });

  it('indeks sisip dikoreksi karena movePanel mencabut dulu baru menyisipkan', () => {
    // Turun: posisi di kanan asalnya bergeser satu setelah pencabutan.
    expect(toMoveIndex(insertPosition({ index: 3, side: 'after', axis: 'x' }), 2)).toBe(3);
    // Naik: tidak ada yang bergeser.
    expect(toMoveIndex(insertPosition({ index: 2, side: 'before', axis: 'x' }), 4)).toBe(2);
  });
});

// ── Drag sungguhan di grid dua kolom ─────────────────────────────────────────

describe('drag di grid dua kolom menghasilkan urutan linear yang benar', () => {
  it('menjatuhkan di separuh KANAN tetangga = sisip sesudahnya', () => {
    renderRail();
    dragTo('amplify', 560, 280);
    expect(railOrder()).toEqual([
      'transport',
      'rail-tabs',
      'render-speed',
      'amplify',
      'shortcuts',
    ]);
  });

  it('menjatuhkan di separuh KIRI tetangga = sisip sebelumnya', () => {
    renderRail();
    dragTo('shortcuts', 100, 280);
    expect(railOrder()).toEqual([
      'transport',
      'rail-tabs',
      'shortcuts',
      'amplify',
      'render-speed',
    ]);
  });

  it('separuh kanan dari target yang sama memberi hasil yang berbeda', () => {
    renderRail();
    dragTo('shortcuts', 250, 280);
    expect(railOrder()).toEqual([
      'transport',
      'rail-tabs',
      'amplify',
      'shortcuts',
      'render-speed',
    ]);
  });

  it('pindah antar baris memakai separuh atas/bawah panel selebar rail', () => {
    renderRail();
    dragTo('shortcuts', 300, 20);
    expect(railOrder()[0]).toBe('shortcuts');
  });

  it('dijatuhkan di tempatnya sendiri tidak mengubah urutan', () => {
    renderRail();
    const before = railOrder();
    // Separuh kiri render-speed = persis celah tempat amplify sudah berada.
    dragTo('amplify', 350, 280);
    expect(railOrder()).toEqual(before);
  });
});

// ── Penanda ──────────────────────────────────────────────────────────────────

describe('penanda sisip', () => {
  it('batang tegak saat menyisip di dalam satu baris', () => {
    renderRail();
    dragTo('shortcuts', 100, 280, false);
    expect(screen.getByTestId('drop-marker-x')).toBeTruthy();
    expect(screen.queryByTestId('drop-marker-y')).toBeNull();
  });

  it('garis mendatar saat menyisip di antara baris', () => {
    renderRail();
    dragTo('shortcuts', 300, 20, false);
    expect(screen.getByTestId('drop-marker-y')).toBeTruthy();
    expect(screen.queryByTestId('drop-marker-x')).toBeNull();
  });

  it('tidak ada penanda saat targetnya posisi panel itu sendiri', () => {
    renderRail();
    dragTo('amplify', 350, 280, false);
    expect(screen.queryByTestId('drop-marker-x')).toBeNull();
    expect(screen.queryByTestId('drop-marker-y')).toBeNull();
  });

  it('penanda hilang lagi setelah dilepas', () => {
    renderRail();
    dragTo('shortcuts', 100, 280);
    expect(screen.queryByTestId('drop-marker-x')).toBeNull();
  });
});

// ── Keyboard tetap jalan ─────────────────────────────────────────────────────

describe('reorder lewat keyboard di rail dua kolom', () => {
  it('↑ dan ↓ bergerak satu langkah dalam urutan linear', () => {
    renderRail();
    fireEvent.keyDown(grip('amplify'), { key: 'ArrowUp' });
    expect(railOrder()).toEqual([
      'transport',
      'amplify',
      'rail-tabs',
      'render-speed',
      'shortcuts',
    ]);
    fireEvent.keyDown(grip('amplify'), { key: 'ArrowDown' });
    expect(railOrder()).toEqual([
      'transport',
      'rail-tabs',
      'amplify',
      'render-speed',
      'shortcuts',
    ]);
  });
});
