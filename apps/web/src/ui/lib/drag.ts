/**
 * Drag berbasis Pointer Events dengan `setPointerCapture`.
 *
 * Kenapa pointer capture dan bukan listener di window: capture membuat elemen
 * asal tetap menerima event walau pointer keluar dari viewport atau melewati
 * iframe, dan otomatis lepas saat pointer hilang (mis. tab di-switch di tengah
 * drag). Tanpa itu, fader "nyangkut" — bug klasik DAW web.
 *
 * Pembagian live/commit ada di pemanggil, tapi bentuk hook ini memaksanya:
 * `onMove` dipanggil sesering pointermove, `onEnd` tepat sekali. Sesuai
 * docs/08 §8a — satu entri undo per gerakan, bukan 400.
 */

import { useRef, type PointerEvent as ReactPointerEvent } from 'react';

export interface DragContext {
  /** Posisi pointer relatif terhadap elemen yang di-drag, dalam CSS pixel. */
  readonly x: number;
  readonly y: number;
  readonly dx: number;
  readonly dy: number;
  readonly rect: DOMRect;
  /** Alt/Option — override snap (design: "ALT-DRAG TO DUPLICATE"). */
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
}

export interface DragHandlers<T> {
  /** Dipanggil di pointerdown. Nilai kembaliannya diteruskan ke move/end —
   *  tempat menyimpan state awal (mis. posisi clip saat drag dimulai). */
  onStart?(ctx: DragContext): T;
  onMove?(ctx: DragContext, start: T): void;
  onEnd?(ctx: DragContext, start: T): void;
}

export function useDrag<T = void>(handlers: DragHandlers<T>): {
  onPointerDown(e: ReactPointerEvent<HTMLElement>): void;
} {
  const ref = useRef(handlers);
  ref.current = handlers;
  const origin = useRef<{ x: number; y: number } | null>(null);
  const startValue = useRef<T | null>(null);

  const ctxFrom = (e: PointerEvent | ReactPointerEvent<HTMLElement>, el: HTMLElement): DragContext => {
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const o = origin.current ?? { x, y };
    return {
      x,
      y,
      dx: x - o.x,
      dy: y - o.y,
      rect,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
    };
  };

  return {
    onPointerDown(e) {
      if (e.button !== 0) return;
      const el = e.currentTarget;
      // Elemen yang belum di-layout (width/height 0) membuat SEMUA konversi
      // posisi→nilai di pemanggil membagi dengan nol (NaN gain, NaN freq, clip
      // melompat ke NaN). Lebih baik tidak memulai drag sama sekali.
      const probe = el.getBoundingClientRect();
      if (probe.width <= 0 || probe.height <= 0) return;

      el.setPointerCapture(e.pointerId);
      origin.current = null;
      const ctx = ctxFrom(e, el);
      origin.current = { x: ctx.x, y: ctx.y };
      startValue.current = (ref.current.onStart?.(ctx) ?? undefined) as T;

      const move = (ev: PointerEvent): void => {
        ref.current.onMove?.(ctxFrom(ev, el), startValue.current as T);
      };
      const up = (ev: PointerEvent): void => {
        // `pointercancel` sudah melepas capture secara implisit; memanggil
        // releasePointerCapture lagi melempar InvalidPointerId (DOMException).
        // Kalau itu terjadi sebelum removeEventListener di bawah, listener-nya
        // tidak pernah dilepas dan drag "nyangkut" selamanya.
        try {
          if (el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
        } catch {
          /* capture sudah hilang — tidak apa-apa */
        }
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
        el.removeEventListener('lostpointercapture', up);
        ref.current.onEnd?.(ctxFrom(ev, el), startValue.current as T);
        origin.current = null;
        startValue.current = null;
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      // Kalau capture hilang karena sebab lain (tab di-switch, gesture browser),
      // drag tetap harus di-commit dan listener-nya dilepas.
      el.addEventListener('lostpointercapture', up);
      // Klik tanpa gerakan = drag dengan delta nol (design memakai onClick pada
      // track fader; kita mempertahankan perilaku itu — docs/08 §Mixer).
      ref.current.onMove?.(ctx, startValue.current as T);
      e.preventDefault();
    },
  };
}
