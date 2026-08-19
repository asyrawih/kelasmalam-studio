/**
 * Knob rotari generik untuk halaman DJ.
 *
 * POLA-nya disalin dari `ui/panels/PluginKnobs.tsx` — jarum berputar
 * `v*270-135`, drag tegak dengan pointer capture, Shift = mode halus, klik-ganda
 * = reset — tapi KOMPONENNYA tidak diimpor: berkas itu terikat store lama
 * `src/state/**`, yang `store-adapter.ts` sendiri sebut sebagai "sisa UI lama
 * yang sedang dirombak". Meng-import-nya berarti halaman ini ikut mati kalau
 * folder itu dihapus.
 *
 * Nilai ditulis LANGSUNG ke DOM selama drag (`paint`), bukan lewat state React.
 * Alasannya bukan mikro-optimasi: satu tarikan knob menghasilkan puluhan event
 * per detik, dan di halaman ini setiap render menyentuh dua canvas waveform yang
 * sedang berjalan di rAF.
 */

import { useRef, type CSSProperties } from 'react';

import { useDrag } from '../../ui/lib/drag';

/** Piksel tarikan tegak untuk menyapu seluruh rentang. */
const TRAVEL_PX = 150;
/** Shift memperlambat sepuluh kali — cukup untuk mencari satu dB. */
const FINE = 0.1;

export interface KnobProps {
  readonly label: string;
  /** Nilai dalam satuan aslinya (dB, −1..1, dst). */
  readonly value: number;
  readonly min: number;
  readonly max: number;
  /** Nilai saat klik-ganda / reset. */
  readonly center: number;
  readonly size?: number;
  readonly accent?: string;
  readonly format: (v: number) => string;
  readonly onChange: (v: number) => void;
  /** Klik pada LABEL. Di rekordbox inilah yang mematikan band EQ. */
  readonly onLabelClick?: () => void;
  readonly labelActive?: boolean;
  readonly disabled?: boolean;
  readonly title?: string;
}

export function Knob({
  label,
  value,
  min,
  max,
  center,
  size = 44,
  accent = 'var(--cy-accent)',
  format,
  onChange,
  onLabelClick,
  labelActive = false,
  disabled = false,
  title,
}: KnobProps): JSX.Element {
  const needleRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLDivElement>(null);

  const norm = (v: number): number => (max === min ? 0 : (v - min) / (max - min));

  const paint = (v: number): void => {
    const needle = needleRef.current;
    if (needle !== null) needle.style.transform = `rotate(${norm(v) * 270 - 135}deg)`;
    const out = readoutRef.current;
    if (out !== null) out.textContent = format(v);
  };

  const valueAt = (start: number, dy: number, fine: boolean): number => {
    const delta = (-dy / TRAVEL_PX) * (max - min) * (fine ? FINE : 1);
    return Math.max(min, Math.min(max, start + delta));
  };

  const drag = useDrag<number>({
    onStart: () => value,
    onMove: (ctx, start) => {
      if (disabled) return;
      const v = valueAt(start, ctx.dy, ctx.shiftKey);
      paint(v);
      onChange(v);
    },
    onEnd: (ctx, start) => {
      if (disabled) return;
      onChange(valueAt(start, ctx.dy, ctx.shiftKey));
    },
  });

  const dial: CSSProperties = {
    width: `${size}px`,
    height: `${size}px`,
    borderRadius: '50%',
    border: '1px solid var(--cy-border-strong)',
    background: 'radial-gradient(circle at 50% 32%,#1e1e1e,#050505 72%)',
    position: 'relative',
    cursor: disabled ? 'not-allowed' : 'ns-resize',
    touchAction: 'none',
    opacity: disabled ? 0.4 : 1,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
      <div
        {...(disabled ? {} : drag)}
        onDoubleClick={disabled ? undefined : () => onChange(center)}
        role="slider"
        aria-label={label}
        aria-valuenow={Math.round(value * 100) / 100}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        className="cy-focusable"
        title={title ?? `${label} — tarik tegak, Shift halus, klik-ganda reset`}
        style={dial}
      >
        <div
          style={{
            position: 'absolute',
            inset: '-4px',
            borderRadius: '50%',
            border: '1px dashed var(--cy-border)',
          }}
        />
        <div
          ref={needleRef}
          style={{
            position: 'absolute',
            left: '50%',
            top: '4px',
            width: '2px',
            height: `${size * 0.36}px`,
            background: accent,
            transformOrigin: `50% ${size / 2 - 4}px`,
            transform: `rotate(${norm(value) * 270 - 135}deg)`,
            marginLeft: '-1px',
            boxShadow: `0 0 6px ${accent}`,
          }}
        />
      </div>
      <button
        type="button"
        className="cy-btn-reset"
        onClick={onLabelClick}
        disabled={onLabelClick === undefined}
        title={onLabelClick === undefined ? undefined : `${label} — klik untuk KILL`}
        style={{
          fontSize: '9px',
          letterSpacing: '.16em',
          color: labelActive ? 'var(--cy-text-on-accent)' : 'var(--cy-text-dim)',
          background: labelActive ? '#ff4d4d' : 'transparent',
          padding: labelActive ? '1px 5px' : '1px 0',
          cursor: onLabelClick === undefined ? 'default' : 'pointer',
          fontFamily: 'var(--cy-font-mono)',
        }}
      >
        {label}
      </button>
      <div
        ref={readoutRef}
        style={{
          fontSize: '10px',
          color: accent,
          fontVariantNumeric: 'tabular-nums',
          minHeight: '12px',
        }}
      >
        {format(value)}
      </div>
    </div>
  );
}
