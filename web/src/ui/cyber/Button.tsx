/**
 * Port lokal dari `CyberUI.Button`.
 *
 * Ukuran & varian mengikuti pemakaian di design: semua tombol di dalam Card
 * memakai `size="sm"` dengan varian solid (default, mis. EXPORT), outline
 * (ZOOM, DRAW), dan ghost (NORMALIZE, CANCEL, …). Bentuk notched-nya memakai
 * clip-path 8px yang sama dengan tombol play di Transport Bar.
 */

import type { ButtonHTMLAttributes, CSSProperties } from 'react';

export type ButtonSize = 'sm' | 'md';
export type ButtonVariant = 'solid' | 'outline' | 'ghost';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'style'> {
  readonly size?: ButtonSize;
  readonly variant?: ButtonVariant;
  readonly active?: boolean;
  readonly style?: CSSProperties;
}

const SIZE: Record<ButtonSize, CSSProperties> = {
  sm: { height: '32px', padding: '0 12px', fontSize: '10px', letterSpacing: '.16em' },
  md: { height: '38px', padding: '0 16px', fontSize: '11px', letterSpacing: '.16em' },
};

const VARIANT: Record<ButtonVariant, CSSProperties> = {
  solid: {
    background: 'var(--cy-accent)',
    color: 'var(--cy-text-on-accent)',
    border: '1px solid var(--cy-border-strong)',
    filter: 'var(--cy-glow-filter-soft)',
  },
  outline: {
    background: 'var(--cy-surface-2)',
    color: 'var(--cy-accent)',
    border: '1px solid var(--cy-accent)',
  },
  ghost: {
    background: 'transparent',
    color: 'var(--cy-text-dim)',
    border: '1px solid var(--cy-border)',
  },
};

export function Button({
  size = 'sm',
  variant = 'solid',
  active = false,
  style,
  className,
  ...rest
}: ButtonProps): JSX.Element {
  const base: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'var(--cy-font-mono)',
    textTransform: 'uppercase',
    cursor: rest.disabled === true ? 'not-allowed' : 'pointer',
    opacity: rest.disabled === true ? 0.4 : 1,
    clipPath: 'polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px)',
    ...SIZE[size],
    ...VARIANT[variant],
    // `border` (shorthand) yang ditulis ulang, BUKAN `borderColor`: mencampur
    // shorthand dan longhand untuk properti yang sama membuat React
    // meninggalkan sisa nilai lama saat prop `active` berubah.
    ...(active && variant !== 'solid'
      ? { color: 'var(--cy-accent)', border: '1px solid var(--cy-accent)' }
      : null),
    ...style,
  };

  const hover =
    variant === 'solid' ? 'cy-hover-accent-bg' : 'cy-hover-accent-border';

  return (
    <button
      type="button"
      className={['cy-btn-reset', 'cy-focusable', hover, className].filter(Boolean).join(' ')}
      style={base}
      {...rest}
    />
  );
}
