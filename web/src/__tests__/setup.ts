import 'vitest-canvas-mock';

// jsdom tidak punya ResizeObserver.
if (!('ResizeObserver' in globalThis)) {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
}

/**
 * jsdom tidak mengimplementasikan Pointer Capture API. Tanpa stub ini,
 * `setPointerCapture` melempar di dalam handler React dan errornya DITELAN
 * menjadi peringatan stderr — bukan kegagalan tes.
 *
 * Akibatnya berbahaya: setiap tes yang mengirim `pointerdown` ke elemen yang
 * memakai pointer capture (drag clip, pan timeline, scrub playhead, fader,
 * node EQ) tampak lulus padahal jalur drag-nya tidak pernah benar-benar jalan.
 * Ditemukan saat mengerjakan EQ kurva; dipasang global supaya lubang yang sama
 * tidak diam-diam ada di tes timeline.
 */
if (typeof Element !== 'undefined' && !Element.prototype.setPointerCapture) {
  const captured = new WeakMap<Element, Set<number>>();
  Element.prototype.setPointerCapture = function setPointerCapture(id: number) {
    const s = captured.get(this) ?? new Set<number>();
    s.add(id);
    captured.set(this, s);
  };
  Element.prototype.releasePointerCapture = function releasePointerCapture(id: number) {
    captured.get(this)?.delete(id);
  };
  Element.prototype.hasPointerCapture = function hasPointerCapture(id: number) {
    return captured.get(this)?.has(id) ?? false;
  };
}
