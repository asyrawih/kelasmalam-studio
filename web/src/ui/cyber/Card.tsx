/**
 * Port lokal dari `CyberUI.Card`.
 *
 * Bundle aslinya (`ds-base.js`) tidak ada di repo, jadi tampilannya
 * direkonstruksi dari pemakaiannya di design file: surface-1 + border,
 * sudut ter-notch lewat clip-path (motif yang sama dengan tombol transport
 * dan clip arrangement: 8px di kiri-atas & kanan-bawah), header berupa
 * judul uppercase ber-letterspacing + subtitle dim, `glow` memakai
 * --cy-glow-lime, dan `live` memakai keyframe `daw-blink` dari helmet.
 */

import type { CSSProperties, ReactNode } from 'react';

export interface CardProps {
  readonly title?: string;
  readonly subtitle?: string;
  /** Sudut ter-potong. Semua Card di design memakai true. */
  readonly notched?: boolean;
  /** Ring + halo aksen (Transport Bar & Step Sequencer di design). */
  readonly glow?: boolean;
  /** Titik berkedip di kanan header (Waveform Display di design). */
  readonly live?: boolean;
  readonly actions?: ReactNode;
  readonly style?: CSSProperties;
  readonly children?: ReactNode;
}

const NOTCH = '10px';

export function Card({
  title,
  subtitle,
  notched = false,
  glow = false,
  live = false,
  actions,
  style,
  children,
}: CardProps): JSX.Element {
  const shell: CSSProperties = {
    background: 'var(--cy-surface-1)',
    border: '1px solid var(--cy-border)',
    padding: '14px 16px 16px',
    boxShadow: glow ? 'var(--cy-glow-lime)' : 'var(--cy-glow-soft)',
    fontFamily: 'var(--cy-font-mono)',
    color: 'var(--cy-text)',
    ...(notched
      ? {
          clipPath: `polygon(${NOTCH} 0, 100% 0, 100% calc(100% - ${NOTCH}), calc(100% - ${NOTCH}) 100%, 0 100%, 0 ${NOTCH})`,
        }
      : null),
    ...style,
  };

  const hasHeader = title !== undefined || subtitle !== undefined || actions !== undefined || live;

  return (
    <section style={shell}>
      {hasHeader ? (
        <header
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: '10px',
            borderBottom: '1px solid var(--cy-border)',
            paddingBottom: '10px',
            marginBottom: '12px',
            // Ruang cadangan di kanan header untuk kontrol yang dipasang dari
            // LUAR kartu — ReorderableStack menempelkan tombol bentangkan (⛶)
            // dan gagang drag (⋮⋮) secara absolut di pojok kanan atas setiap
            // panel. Tanpa ruang ini, apa pun yang diisi kartu di sisi kanan
            // (badge, subtitle panjang) tertimpa tombol itu.
            //
            // Nilainya datang dari pemasangnya lewat CSS variable, bukan
            // di-hardcode: kartu di luar tumpukan tidak boleh kehilangan ruang
            // untuk kontrol yang tidak ada di sana.
            paddingRight: 'var(--cy-card-header-reserve, 0px)',
          }}
        >
          {title !== undefined ? (
            <h2
              style={{
                margin: 0,
                fontSize: '11px',
                fontWeight: 500,
                letterSpacing: '.22em',
                textTransform: 'uppercase',
                color: 'var(--cy-accent)',
              }}
            >
              {title}
            </h2>
          ) : null}
          {subtitle !== undefined ? (
            <span style={{ fontSize: '10px', letterSpacing: '.12em', color: 'var(--cy-text-muted)' }}>
              {subtitle}
            </span>
          ) : null}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px' }}>
            {actions}
            {live ? (
              <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span
                  style={{
                    width: '6px',
                    height: '6px',
                    borderRadius: '50%',
                    background: 'var(--cy-accent)',
                    boxShadow: 'var(--cy-glow-magenta)',
                    animation: 'daw-blink 1.1s steps(2, start) infinite',
                  }}
                />
                <span
                  style={{
                    fontSize: '9px',
                    letterSpacing: '.18em',
                    color: 'var(--cy-text-muted)',
                  }}
                >
                  LIVE
                </span>
              </span>
            ) : null}
          </div>
        </header>
      ) : null}
      {children}
    </section>
  );
}
