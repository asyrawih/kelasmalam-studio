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
  /**
   * Panjang tetap dalam piksel, atau dihilangkan supaya fader MENGISI induknya.
   *
   * Mengisi adalah bentuk yang benar untuk channel fader: tinggi yang tersedia
   * berubah mengikuti viewport, dan angka tetap berarti isinya terpotong di
   * layar pendek — yang terpotong justru fader-nya, karena ia paling bawah.
   */
  readonly length?: number;
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

  /**
   * Posisi cap dalam PERSEN, lewat `top`/`left` — BUKAN `transform`.
   *
   * Ini bukan selera, dan pernah salah: persentase di dalam `translate()`
   * dihitung terhadap **elemen itu sendiri**, bukan induknya. Untuk cap
   * setinggi 16 px, `translateY(calc((100% - 16px) * t))` selalu bernilai
   * `(16px − 16px) * t` = **0** — cap-nya tidak pernah bergerak sedikit pun,
   * berapa pun nilainya, sementara angka di sebelahnya berubah normal.
   *
   * Persentase pada `top`/`left` elemen ber-`position: absolute` dihitung
   * terhadap CONTAINING BLOCK, yaitu induknya. Itu yang dimaksud, dan itu yang
   * membuat fader tetap benar saat induknya berubah ukuran — tanpa mengukur
   * apa pun dan tanpa satu pun listener resize.
   */
  const offsetOf = (v: number): string => {
    const t = vertical ? 1 - v : v;
    return `calc((100% - ${CAP}px) * ${t})`;
  };

  const place = (v: number): void => {
    const cap = capRef.current;
    if (cap === null) return;
    const off = offsetOf(v);
    if (vertical) cap.style.top = off;
    else cap.style.left = off;
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
        width: vertical ? `${thickness}px` : length === undefined ? '100%' : `${length}px`,
        height: vertical ? (length === undefined ? '100%' : `${length}px`) : `${thickness}px`,
        minHeight: vertical ? `${CAP * 2}px` : undefined,
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
            left: vertical ? '2px' : `calc(${CAP / 2}px + (100% - ${CAP}px) * ${detent})`,
            top: vertical ? `calc(${CAP / 2}px + (100% - ${CAP}px) * ${1 - detent})` : '2px',
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
          left: vertical ? '3px' : offsetOf(value),
          top: vertical ? offsetOf(value) : '3px',
          width: vertical ? `${thickness - 8}px` : `${CAP}px`,
          height: vertical ? `${CAP}px` : `${thickness - 8}px`,
          background: accent,
          boxShadow: `0 0 8px ${accent}55`,
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}
