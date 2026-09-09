/**
 * Penggaris waktu. Ia TIDAK ikut menggulir sendiri (overflow:hidden); posisinya
 * disamakan dengan area clip lewat `marginLeft = -scrollLeft` — persis
 * `syncView()` di design. Karena itu ref-nya dipegang parent.
 */

import { forwardRef } from 'react';
import type React from 'react';
import { formatTime } from '../model';

export interface TimelineRulerProps {
  readonly durationSec: number;
  /** null = FIT. Menentukan rapatnya tanda seperti `markStep` di design. */
  readonly pxPerSecond: number | null;
  /** CSS width untuk track dalam (`100%` saat FIT). */
  readonly trackWidth: string;
  /**
   * Handler scrub. Dipasang di elemen LUAR (yang tidak bergeser), sedangkan
   * konversi x→waktu memakai rect track DALAM (yang bergeser mengikuti scroll)
   * — lihat TimelinePanel. Opsional supaya ruler tetap bisa dites sendiri.
   */
  readonly onScrubDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
  readonly onScrubMove?: (e: React.PointerEvent<HTMLDivElement>) => void;
  readonly onScrubUp?: (e: React.PointerEvent<HTMLDivElement>) => void;
}

export function markStepFor(pxPerSecond: number | null): number {
  if (pxPerSecond === null) return 20;
  if (pxPerSecond > 80) return 5;
  if (pxPerSecond > 30) return 10;
  return 20;
}

export const TimelineRuler = forwardRef<HTMLDivElement, TimelineRulerProps>(function TimelineRuler(
  { durationSec, pxPerSecond, trackWidth, onScrubDown, onScrubMove, onScrubUp },
  ref,
): JSX.Element {
  const step = markStepFor(pxPerSecond);
  const marks: number[] = [];
  // Guard: durasi non-finite/0 tidak boleh membuat loop tak berujung.
  const span = Number.isFinite(durationSec) ? Math.max(0, durationSec) : 0;
  // `<= span`: tanpa ini label terakhir tidak pernah tergambar, sehingga
  // timeline 02:00 hanya berlabel sampai 01:40 dan terlihat seperti terpotong.
  for (let t = 0; t <= span + 0.001; t += step) marks.push(t);

  return (
    <div
      data-tl-ruler
      onPointerDown={onScrubDown}
      onPointerMove={onScrubMove}
      onPointerUp={onScrubUp}
      onPointerCancel={onScrubUp}
      style={{
        minWidth: 0,
        overflow: 'hidden',
        height: '28px',
        borderBottom: '1px solid var(--cy-border)',
        cursor: onScrubDown === undefined ? undefined : 'ew-resize',
        touchAction: 'none',
      }}
    >
      <div ref={ref} style={{ width: trackWidth, minWidth: '100%', height: '100%', display: 'flex' }}>
        {marks.map((t) => (
          <div
            key={t}
            style={{
              flex: 1,
              minWidth: 0,
              borderLeft: '1px solid var(--cy-border)',
              fontSize: '9px',
              color: 'var(--cy-text-muted)',
              padding: '8px 0 0 5px',
              whiteSpace: 'nowrap',
            }}
          >
            {formatTime(t)}
          </div>
        ))}
      </div>
    </div>
  );
});
