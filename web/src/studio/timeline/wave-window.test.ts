import { describe, expect, it } from 'vitest';

import { visibleWindow, WINDOW_QUANTUM as Q } from './wave-window';

describe('visibleWindow', () => {
  it('clip yang sepenuhnya di luar layar tidak menghasilkan jendela', () => {
    // Kiri layar…
    expect(visibleWindow(0, 1000, 5000, 1600)).toBeNull();
    // …dan kanan layar.
    expect(visibleWindow(9000, 1000, 0, 1600)).toBeNull();
  });

  it('clip yang menyentuh tepi layar TETAP dapat jendela', () => {
    // Satu piksel terakhir clip masih terlihat di tepi kiri viewport.
    expect(visibleWindow(0, 1000, 999, 1600)).not.toBeNull();
    // Satu piksel pertama clip baru muncul di tepi kanan viewport.
    expect(visibleWindow(1599, 1000, 0, 1600)).not.toBeNull();
  });

  it('clip yang lebih sempit dari viewport digambar utuh', () => {
    expect(visibleWindow(100, 300, 0, 1600)).toEqual({ x: 0, w: 300 });
  });

  it('clip raksasa hanya digambar selebar viewport + margin kuantum', () => {
    // Inilah kasus yang jadi alasan modul ini ada: track 648.000 px.
    const win = visibleWindow(0, 648_000, 300_000, 1600)!;
    expect(win).not.toBeNull();
    // Jauh di bawah batas dimensi canvas browser (~65.535 px), bahkan setelah
    // dikalikan dpr 2.
    expect(win.w).toBeLessThanOrEqual(1600 + 2 * Q);
    // Dan benar-benar menutupi yang terlihat.
    expect(win.x).toBeLessThanOrEqual(300_000);
    expect(win.x + win.w).toBeGreaterThanOrEqual(300_000 + 1600);
  });

  it('tepi jendela dibulatkan ke kelipatan kuantum, jadi guliran kecil tidak mengubahnya', () => {
    const a = visibleWindow(0, 648_000, 10_000, 1600);
    const b = visibleWindow(0, 648_000, 10_100, 1600);
    expect(b).toEqual(a);
    expect(a!.x % Q).toBe(0);
  });

  it('jendela tidak pernah keluar dari bentangannya', () => {
    // Viewport melewati ujung kanan clip.
    const win = visibleWindow(0, 1000, 500, 1600)!;
    expect(win.x).toBeGreaterThanOrEqual(0);
    expect(win.x + win.w).toBeLessThanOrEqual(1000);

    // Viewport mulai sebelum clip.
    const left = visibleWindow(800, 5000, 0, 1600)!;
    expect(left.x).toBe(0);
  });

  it('ukuran yang belum terukur menghasilkan null, bukan jendela nol', () => {
    expect(visibleWindow(0, 0, 0, 1600)).toBeNull();
    expect(visibleWindow(0, 1000, 0, 0)).toBeNull();
  });
});
