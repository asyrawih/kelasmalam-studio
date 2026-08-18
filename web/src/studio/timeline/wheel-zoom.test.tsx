/**
 * `scroll = zoom` di timeline.
 *
 * Yang diuji bukan "zoom berubah" melainkan DI MANA gulir dianggap zoom.
 * Sebelumnya listener-nya hanya menempel di area clip yang menggulir, sehingga
 * menggulir di atas kolom nama lane atau penggaris waktu tidak men-zoom apa pun
 * — halaman yang bergerak. Dari sudut pandang user, fiturnya tampak rusak
 * separuh waktu, dan separuh mana tergantung beberapa piksel posisi kursor.
 */

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { studioActions, studioStore } from '../store';
import { TimelinePanel } from './TimelinePanel';

Element.prototype.getBoundingClientRect = () =>
  ({ x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 300, width: 800, height: 300, toJSON: () => ({}) }) as DOMRect;

function wheel(el: Element, deltaY: number): WheelEvent {
  const ev = new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true, clientX: 400 });
  el.dispatchEvent(ev);
  return ev;
}

function find(selector: string): Element {
  const el = document.querySelector(selector);
  if (el === null) throw new Error(`${selector} tidak ada`);
  return el;
}

beforeEach(() => studioActions.__resetForTest());
afterEach(cleanup);

describe('gulir untuk zoom', () => {
  it('gulir di area clip men-zoom masuk', () => {
    render(<TimelinePanel />);
    act(() => studioActions.setZoom(20));
    wheel(find('[data-tl-scroll]'), -100);
    expect(studioStore.getState().pxPerSecond).toBeGreaterThan(20);
  });

  it('gulir di atas KOLOM NAMA LANE juga men-zoom, bukan menggulir halaman', () => {
    render(<TimelinePanel />);
    act(() => studioActions.setZoom(20));
    const ev = wheel(find('[data-lane-header]'), -100);
    expect(studioStore.getState().pxPerSecond).toBeGreaterThan(20);
    // `preventDefault` inilah yang menahan halaman ikut bergerak.
    expect(ev.defaultPrevented).toBe(true);
  });

  it('gulir di atas penggaris waktu juga men-zoom', () => {
    render(<TimelinePanel />);
    act(() => studioActions.setZoom(20));
    wheel(find('[data-tl-ruler]'), -100);
    expect(studioStore.getState().pxPerSecond).toBeGreaterThan(20);
  });

  it('arah sebaliknya men-zoom keluar', () => {
    render(<TimelinePanel />);
    act(() => studioActions.setZoom(20));
    wheel(find('[data-tl-body]'), 100);
    expect(studioStore.getState().pxPerSecond).toBeLessThan(20);
  });

  it('gulir di TOOLBAR juga men-zoom — seluruh kartu ikut aturan yang sama', () => {
    render(<TimelinePanel />);
    act(() => studioActions.setZoom(20));
    const ev = wheel(find('button[aria-label="zoom in"]'), -100);
    // Membelah kartu jadi zona "boleh zoom" dan "tidak" membuat fiturnya
    // bekerja atau tidak tergantung beberapa piksel posisi kursor, dan batas
    // zonanya tidak terlihat sama sekali di layar.
    expect(ev.defaultPrevented).toBe(true);
    expect(studioStore.getState().pxPerSecond).toBeGreaterThan(20);
  });

  it('gulir di luar kartu timeline TIDAK dibajak — halaman tetap bisa digulir', () => {
    render(<TimelinePanel />);
    act(() => studioActions.setZoom(20));
    const outside = document.createElement('div');
    document.body.appendChild(outside);
    const ev = wheel(outside, -100);
    expect(ev.defaultPrevented).toBe(false);
    expect(studioStore.getState().pxPerSecond).toBe(20);
    outside.remove();
  });

  it('gulir mendatar murni (deltaY ~0) dibiarkan lewat', () => {
    render(<TimelinePanel />);
    act(() => studioActions.setZoom(20));
    const ev = wheel(find('[data-tl-body]'), 0);
    expect(ev.defaultPrevented).toBe(false);
    expect(studioStore.getState().pxPerSecond).toBe(20);
  });
});
