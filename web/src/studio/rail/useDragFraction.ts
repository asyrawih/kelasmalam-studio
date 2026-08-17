/**
 * Hook drag horizontal berbasis Pointer Events + pointer capture.
 *
 * Kenapa pointer capture dan bukan listener window: dengan capture, semua
 * pointermove/pointerup tetap dikirim ke elemen yang menangkapnya walau kursor
 * keluar dari elemen (atau keluar window). Jadi tidak ada listener global yang
 * bisa bocor, dan `pointercancel` (mis. gesture browser mengambil alih) ikut
 * tertangani.
 */

import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from 'react';

export interface DragHandlers {
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void;
}

/** Fraksi 0..1 posisi X pointer di dalam elemen. 0 kalau lebar belum terukur. */
function fractionOf(el: HTMLElement, clientX: number): number {
  const rect = el.getBoundingClientRect();
  // Sebelum layout (atau di jsdom) width bisa 0 → jangan sampai NaN masuk style.
  if (!(rect.width > 0)) return 0;
  return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
}

/**
 * @param onValue dipanggil dengan fraksi 0..1 saat klik dan selama drag.
 * @param disabled kalau true, semua handler jadi no-op.
 */
export function useDragFraction(
  onValue: (fraction: number) => void,
  disabled = false,
): DragHandlers {
  const dragging = useRef(false);
  const cb = useRef(onValue);
  cb.current = onValue;

  const down = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (disabled || e.button !== 0) return;
      const el = e.currentTarget;
      dragging.current = true;
      // jsdom tidak mengimplementasikan setPointerCapture — jangan sampai
      // smoke test jatuh karenanya.
      el.setPointerCapture?.(e.pointerId);
      e.preventDefault();
      cb.current(fractionOf(el, e.clientX));
    },
    [disabled],
  );

  const move = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (disabled || !dragging.current) return;
      cb.current(fractionOf(e.currentTarget, e.clientX));
    },
    [disabled],
  );

  const end = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    const el = e.currentTarget;
    if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture?.(e.pointerId);
  }, []);

  return { onPointerDown: down, onPointerMove: move, onPointerUp: end, onPointerCancel: end };
}
