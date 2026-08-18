/**
 * Kotak seleksi + geser berombongan, lewat jalur pointer yang sebenarnya.
 *
 * Yang paling mudah rusak di sini adalah KOORDINAT: kotak dihitung dalam ruang
 * TRACK (yang lebarnya bisa jauh melebihi viewport dan ikut tergeser saat
 * scroll), bukan ruang layar. Tes ini mengunci pemetaan itu, bukan sekadar
 * "ada div yang muncul".
 */

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_FADE_CURVE, laneHeightPx, type StudioClip } from '../model';
import { studioActions, studioStore } from '../store';
import { ClipArea } from './ClipArea';

const SR = 48_000;
/** Track selebar 1000 px; durasi project dipatok lewat MIN 120 detik. */
const TRACK_W = 1000;

Element.prototype.getBoundingClientRect = function (this: Element) {
  return { x: 0, y: 0, top: 0, left: 0, right: TRACK_W, bottom: 400, width: TRACK_W, height: 400, toJSON: () => ({}) } as DOMRect;
};
Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
  configurable: true,
  get: () => TRACK_W,
});

function clip(id: string, startSec: number, lenSec = 4): StudioClip {
  return {
    id,
    assetId: 1,
    start: startSec * SR,
    len: lenSec * SR,
    sourceStart: 0,
    sourceLen: lenSec * SR,
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

function clipEl(id: string): HTMLElement {
  const el = document.querySelector(`[data-clip="${id}"]`);
  if (el === null) throw new Error(`clip ${id} tidak ada`);
  return el as HTMLElement;
}

function ids(): readonly string[] {
  return studioStore.getState().selectedClipIds;
}

/** px per detik pada track ini. */
function pxAt(sec: number): number {
  const dur = studioStore.getState().duration / SR;
  return (sec / dur) * TRACK_W;
}

const laneH = (): number => laneHeightPx(studioStore.getState().laneHeight);

beforeEach(() => {
  studioActions.__resetForTest('empty');
  if (studioStore.getState().lanes.length < 2) studioActions.addLane();
  const [l0, l1] = studioStore.getState().lanes.map((l) => l.id);
  studioActions.addClip(l0!, clip('a', 0));
  studioActions.addClip(l0!, clip('b', 20));
  studioActions.addClip(l1!, clip('c', 2));
  studioActions.clearClipSelection();
});

afterEach(cleanup);

describe('kotak seleksi', () => {
  it('menyeret latar memilih semua clip yang tersentuh kotak', () => {
    render(<Harness />);
    const el = scroller();
    fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
    // Sampai detik ke-5 dan turun melewati dua lane → kena `a` dan `c`.
    fireEvent.pointerMove(el, { pointerId: 1, clientX: pxAt(5), clientY: laneH() * 2 - 4 });
    expect([...ids()].sort()).toEqual(['a', 'c']);
    fireEvent.pointerUp(el, { pointerId: 1, clientX: pxAt(5), clientY: laneH() * 2 - 4 });
    expect(document.querySelector('[data-marquee]')).toBeNull();
  });

  it('kotak hanya menyentuh lane pertama tidak ikut memilih lane kedua', () => {
    render(<Harness />);
    const el = scroller();
    fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(el, { pointerId: 1, clientX: pxAt(5), clientY: laneH() - 4 });
    expect(ids()).toEqual(['a']);
  });

  it('clip di luar rentang waktu kotak tidak ikut', () => {
    render(<Harness />);
    const el = scroller();
    fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(el, { pointerId: 1, clientX: pxAt(5), clientY: laneH() * 2 });
    expect(ids()).not.toContain('b'); // `b` mulai di detik 20
  });

  it('clip yang lebih lebar dari kotak tetap terpilih (bersinggungan, bukan termuat)', () => {
    render(<Harness />);
    const el = scroller();
    // Kotak kecil di tengah clip `a` (0–4 s).
    fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: pxAt(1), clientY: 4 });
    fireEvent.pointerMove(el, { pointerId: 1, clientX: pxAt(1.2), clientY: 10 });
    expect(ids()).toEqual(['a']);
  });

  it('menyeret latar TANPA modifier membuang seleksi lama', () => {
    render(<Harness />);
    studioActions.setSelectedClips(['b']);
    const el = scroller();
    fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(el, { pointerId: 1, clientX: pxAt(5), clientY: laneH() - 4 });
    expect(ids()).toEqual(['a']);
  });

  it('Shift menambah ke seleksi yang sudah ada', () => {
    render(<Harness />);
    studioActions.setSelectedClips(['b']);
    const el = scroller();
    fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: 0, clientY: 0, shiftKey: true });
    fireEvent.pointerMove(el, { pointerId: 1, clientX: pxAt(5), clientY: laneH() - 4 });
    expect([...ids()].sort()).toEqual(['a', 'b']);
  });
});

describe('klik dan geser clip', () => {
  it('Shift-klik clip menambahkannya tanpa memulai geser', () => {
    render(<Harness />);
    studioActions.selectClip('a');
    fireEvent.pointerDown(clipEl('c'), { pointerId: 1, button: 0, clientX: 0, clientY: 0, shiftKey: true });
    fireEvent.pointerMove(clipEl('c'), { pointerId: 1, clientX: 300, clientY: 0 });
    expect([...ids()].sort()).toEqual(['a', 'c']);
    // Tidak ada yang bergeser: Ctrl/Shift-drag hampir selalu tidak disengaja.
    expect(studioStore.getState().lanes[1]!.clips[0]!.start).toBe(2 * SR);
  });

  it('menyeret clip yang SUDAH terpilih membawa seluruh seleksi', () => {
    render(<Harness />);
    studioActions.setSelectedClips(['a', 'c'], 'a');
    const el = clipEl('a');
    fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(el, { pointerId: 1, clientX: pxAt(6), clientY: 0 });
    const s = studioStore.getState();
    expect(s.lanes[0]!.clips.find((c) => c.id === 'a')!.start).toBe(6 * SR);
    expect(s.lanes[1]!.clips.find((c) => c.id === 'c')!.start).toBe(8 * SR);
  });

  it('menyeret clip di LUAR seleksi menggantinya lebih dulu', () => {
    render(<Harness />);
    studioActions.setSelectedClips(['a', 'c']);
    const el = clipEl('b');
    fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
    expect(ids()).toEqual(['b']);
    fireEvent.pointerMove(el, { pointerId: 1, clientX: pxAt(2), clientY: 0 });
    const s = studioStore.getState();
    expect(s.lanes[0]!.clips.find((c) => c.id === 'b')!.start).toBe(22 * SR);
    expect(s.lanes[0]!.clips.find((c) => c.id === 'a')!.start).toBe(0);
  });
});

describe('pan', () => {
  it('spasi ditahan mengubah drag latar jadi geser tampilan, bukan seleksi', async () => {
    const { pressSpace, releaseSpace } = await import('../shortcuts/space-pan');
    render(<Harness />);
    pressSpace();
    const el = scroller();
    fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(el, { pointerId: 1, clientX: pxAt(5), clientY: laneH() * 2 });
    expect(ids()).toEqual([]);
    expect(document.querySelector('[data-marquee]')).toBeNull();
    fireEvent.pointerUp(el, { pointerId: 1, clientX: pxAt(5), clientY: 0 });
    // Spasi yang dipakai untuk pan tidak boleh ikut men-toggle play.
    expect(releaseSpace()).toBe(false);
  });

  it('tombol tengah juga pan, tanpa spasi', () => {
    render(<Harness />);
    const el = scroller();
    fireEvent.pointerDown(el, { pointerId: 1, button: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(el, { pointerId: 1, clientX: pxAt(5), clientY: laneH() * 2 });
    expect(ids()).toEqual([]);
  });
});
