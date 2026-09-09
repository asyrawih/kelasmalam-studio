/**
 * Drop berkas dari OS untuk host yang tidak mengirim event DOM `drop`.
 *
 * Di web hook ini tidak melakukan apa-apa — `onDrop` komponen sudah menerima
 * `dataTransfer.files`. Di desktop, Tauri mencegat drop OS dan memberi PATH +
 * posisi; host mengubahnya jadi `File`, dan hook ini menentukan zona mana yang
 * kena lewat titik jatuhnya. `elementFromPoint` dipakai (bukan sekadar
 * `getBoundingClientRect`) supaya dok kepustakaan yang mengapung di atas
 * timeline tidak membuat SATU drop mendarat di dua tempat.
 */

import { useEffect, useRef, type RefObject } from 'react';
import type { DropPoint } from './host';
import { getPlatformHost } from './index';

export function hitTest(el: HTMLElement, point: DropPoint): boolean {
  const under =
    typeof document.elementFromPoint === 'function' ? document.elementFromPoint(point.x, point.y) : null;
  if (under !== null && under !== undefined) return el.contains(under);
  const r = el.getBoundingClientRect();
  return point.x >= r.left && point.x < r.right && point.y >= r.top && point.y < r.bottom;
}

export function useNativeFileDrop(
  ref: RefObject<HTMLElement | null>,
  onDrop: (files: readonly File[], point: DropPoint) => void,
  enabled = true,
): void {
  const latest = useRef(onDrop);
  latest.current = onDrop;

  useEffect(() => {
    const host = getPlatformHost();
    if (!enabled || host.onFilesDropped === undefined) return undefined;
    return host.onFilesDropped((files, point) => {
      const el = ref.current;
      if (el === null || !hitTest(el, point)) return;
      latest.current(files, point);
    });
  }, [ref, enabled]);
}
