/**
 * Helper canvas: devicePixelRatio, resize observer, dan redraw yang di-cache.
 *
 * Aturan yang ditegakkan di sini:
 *
 * 1. Backing store selalu `cssPx * dpr`, dan konteks di-`setTransform` ke dpr
 *    sekali per resize — sehingga SELURUH kode gambar bekerja dalam CSS pixel.
 *    Kalau ini tidak dilakukan, waveform buram di layar Retina dan garis 1px
 *    jadi 0.5px yang blur.
 * 2. Redraw hanya terjadi saat `deps` berubah (zoom, scroll, trim, seleksi,
 *    ukuran). Panel yang bergerak 60 Hz (meter, playhead) TIDAK memakai hook
 *    ini — mereka menggambar dari `useMeterFrame` ke canvas overlay sendiri.
 */

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

export interface CanvasSize {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

/** Pasang ukuran backing store sesuai dpr. Mengembalikan false kalau ukuran
 *  belum valid (elemen belum di-layout). */
export function fitCanvas(canvas: HTMLCanvasElement): CanvasSize | null {
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  // Batasi dpr: di layar 3x, canvas timeline selebar 1600px berarti 4800px
  // backing store per redraw. 2 sudah tidak bisa dibedakan mata untuk garis.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(rect.width * dpr);
  const h = Math.round(rect.height * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return { width: rect.width, height: rect.height, dpr };
}

export type DrawFn = (ctx: CanvasRenderingContext2D, size: CanvasSize) => void;

/**
 * Gambar ulang saat `deps` berubah atau elemen berubah ukuran.
 *
 * `draw` boleh berubah tiap render (disimpan di ref); yang menentukan kapan
 * menggambar hanyalah `deps` dan resize. Ini yang membuat panel arrangement
 * tidak menggambar ulang saat komponen lain di App render.
 */
export function useCanvasDraw(
  ref: RefObject<HTMLCanvasElement>,
  draw: DrawFn,
  deps: readonly unknown[],
): void {
  const drawRef = useRef(draw);
  drawRef.current = draw;

  const render = useRef(() => {
    const canvas = ref.current;
    if (canvas === null) return;
    const size = fitCanvas(canvas);
    if (size === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);
    drawRef.current(ctx, size);
  });

  useLayoutEffect(() => {
    render.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    const canvas = ref.current;
    if (canvas === null) return;
    const ro = new ResizeObserver(() => render.current());
    ro.observe(canvas);
    const onDpr = (): void => render.current();
    window.addEventListener('resize', onDpr);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', onDpr);
    };
  }, [ref]);
}

/**
 * Canvas overlay yang digambar dari rAF (playhead, meter, ghost drag).
 * Mengembalikan fungsi untuk mengambil konteks yang sudah ter-skala; pemanggil
 * memanggilnya di dalam callback `useMeterFrame`.
 */
export function useOverlayContext(
  ref: RefObject<HTMLCanvasElement>,
): () => { ctx: CanvasRenderingContext2D; size: CanvasSize } | null {
  const cached = useRef<{ ctx: CanvasRenderingContext2D; size: CanvasSize } | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (canvas === null) return;
    const sync = (): void => {
      const size = fitCanvas(canvas);
      const ctx = canvas.getContext('2d');
      if (size === null || ctx === null) {
        cached.current = null;
        return;
      }
      ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
      cached.current = { ctx, size };
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(canvas);
    // ResizeObserver TIDAK menyala saat devicePixelRatio berubah (pindah ke
    // monitor lain, zoom browser). Tanpa listener ini backing store overlay
    // tetap di dpr lama dan playhead jadi buram / salah posisi.
    window.addEventListener('resize', sync);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', sync);
    };
  }, [ref]);

  return () => cached.current;
}
