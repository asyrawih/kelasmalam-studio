/**
 * Fader linear — tegak (channel) maupun mendatar (crossfader).
 *
 * Satu komponen untuk keduanya karena matematikanya identik dan hanya sumbunya
 * yang berbeda; dua komponen berarti dua tempat yang bisa menyimpang soal
 * pembalikan sumbu, dan pembalikan sumbu adalah bug klasik fader.
 *
 * Sumbu tegak DIBALIK (atas = 1): itu bentuk fisiknya. Ditulis satu kali di
 * sini, tidak diulang di pemanggil.
 */

import { useRef } from 'react';

import { useDrag } from '../../ui/lib/drag';

export interface FaderProps {
  readonly orientation: 'vertical' | 'horizontal';
  /** 0..1. Untuk tegak, 1 = atas. */
  readonly value: number;
  readonly onChange: (v: number) => void;
  readonly length: number;
  readonly thickness?: number;
  readonly accent?: string;
  readonly label: string;
  /** Nilai saat klik-ganda. `null` = klik-ganda tidak melakukan apa-apa. */
  readonly resetTo?: number | null;
  /** Garis penanda di posisi ini (detent tengah crossfader / unity). */
  readonly detent?: number | null;
  readonly title?: string;
}

const CAP = 16;

export function Fader({
  orientation,
  value,
  onChange,
  length,
  thickness = 26,
  accent = 'var(--cy-accent)',
  label,
  resetTo = null,
  detent = null,
  title,
}: FaderProps): JSX.Element {
  const capRef = useRef<HTMLDivElement>(null);
  const vertical = orientation === 'vertical';

  const place = (v: number): void => {
    const cap = capRef.current;
    if (cap === null) return;
    const t = vertical ? 1 - v : v;
    const px = t * (length - CAP);
    cap.style.transform = vertical ? `translateY(${px}px)` : `translateX(${px}px)`;
  };

  const fromPointer = (x: number, y: number, rect: DOMRect): number => {
    const span = (vertical ? rect.height : rect.width) - CAP;
    if (span <= 0) return value;
    const raw = ((vertical ? y : x) - CAP / 2) / span;
    const v = vertical ? 1 - raw : raw;
    return Math.max(0, Math.min(1, v));
  };

  const drag = useDrag<null>({
    onStart: () => null,
    onMove: (ctx) => {
      const v = fromPointer(ctx.x, ctx.y, ctx.rect);
      place(v);
      onChange(v);
    },
    onEnd: (ctx) => onChange(fromPointer(ctx.x, ctx.y, ctx.rect)),
  });

  const capOffset = (vertical ? 1 - value : value) * (length - CAP);

  return (
    <div
      {...drag}
      onDoubleClick={resetTo === null ? undefined : () => onChange(resetTo)}
      role="slider"
      aria-label={label}
      aria-valuenow={Math.round(value * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-orientation={orientation}
      tabIndex={0}
      className="cy-focusable"
      title={title ?? label}
      style={{
        position: 'relative',
        width: vertical ? `${thickness}px` : `${length}px`,
        height: vertical ? `${length}px` : `${thickness}px`,
        background: 'var(--cy-surface-2)',
        border: '1px solid var(--cy-border)',
        cursor: vertical ? 'ns-resize' : 'ew-resize',
        touchAction: 'none',
        flexShrink: 0,
      }}
    >
      {/* Alur */}
      <div
        style={{
          position: 'absolute',
          left: vertical ? '50%' : `${CAP / 2}px`,
          top: vertical ? `${CAP / 2}px` : '50%',
          width: vertical ? '2px' : `calc(100% - ${CAP}px)`,
          height: vertical ? `calc(100% - ${CAP}px)` : '2px',
          marginLeft: vertical ? '-1px' : 0,
          marginTop: vertical ? 0 : '-1px',
          background: '#000',
        }}
      />
      {detent !== null && (
        <div
          style={{
            position: 'absolute',
            left: vertical ? '2px' : `${CAP / 2 + detent * (length - CAP)}px`,
            top: vertical ? `${CAP / 2 + (1 - detent) * (length - CAP)}px` : '2px',
            width: vertical ? `${thickness - 6}px` : '1px',
            height: vertical ? '1px' : `${thickness - 6}px`,
            background: 'var(--cy-border-strong)',
          }}
        />
      )}
      <div
        ref={capRef}
        style={{
          position: 'absolute',
          left: vertical ? '3px' : 0,
          top: vertical ? 0 : '3px',
          width: vertical ? `${thickness - 8}px` : `${CAP}px`,
          height: vertical ? `${CAP}px` : `${thickness - 8}px`,
          background: accent,
          boxShadow: `0 0 8px ${accent}55`,
          transform: vertical ? `translateY(${capOffset}px)` : `translateX(${capOffset}px)`,
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}
