/**
 * Port lokal dari `CyberUI.Badge`.
 *
 * Tone yang dipakai design: default, accent, success, warning, danger. `dot` menambah
 * titik kecil di kiri; `pulse` membuatnya berkedip memakai keyframe
 * `daw-blink` dari helmet design. Tinggi 26px (`hint-size="auto,26px"`),
 * kecuali badge di FX Rack yang 22px — itu lewat prop `height`.
 */

import type { CSSProperties, ReactNode } from 'react';

export type BadgeTone = 'default' | 'accent' | 'success' | 'warning' | 'danger';

export interface BadgeProps {
  readonly tone?: BadgeTone;
  readonly dot?: boolean;
  readonly pulse?: boolean;
  readonly height?: number;
  readonly title?: string;
  readonly style?: CSSProperties;
  readonly children?: ReactNode;
}

interface ToneSpec {
  readonly fg: string;
  readonly border: string;
  readonly bg: string;
}

const TONE: Record<BadgeTone, ToneSpec> = {
  default: { fg: 'var(--cy-text-dim)', border: 'var(--cy-border)', bg: 'transparent' },
  accent: { fg: 'var(--cy-accent)', border: '#ffd40059', bg: '#ffd4000f' },
  success: { fg: 'var(--cy-success)', border: '#ffd40059', bg: '#ffd4000f' },
  // Dipakai badge LIFETIME di landing page (`tone="warning"` di design).
  warning: { fg: 'var(--cy-warning)', border: '#ffb02059', bg: '#ffb0200f' },
  danger: { fg: '#ff4d4d', border: '#ff4d4d59', bg: '#ff4d4d0f' },
};

export function Badge({
  tone = 'default',
  dot = false,
  pulse = false,
  height = 26,
  title,
  style,
  children,
}: BadgeProps): JSX.Element {
  const spec = TONE[tone];
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        height: `${height}px`,
        padding: '0 9px',
        border: `1px solid ${spec.border}`,
        background: spec.bg,
        color: spec.fg,
        fontFamily: 'var(--cy-font-mono)',
        fontSize: '9px',
        letterSpacing: '.16em',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {dot ? (
        <span
          style={{
            width: '6px',
            height: '6px',
            borderRadius: '50%',
            background: 'currentColor',
            boxShadow: '0 0 6px currentColor',
            ...(pulse ? { animation: 'daw-blink 1.1s steps(2, start) infinite' } : null),
          }}
        />
      ) : null}
      {children}
    </span>
  );
}
