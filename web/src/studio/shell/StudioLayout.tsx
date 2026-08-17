/**
 * Kerangka halaman: grid `auto auto minmax(0,1fr)` (header, readout, body) dan
 * body dua kolom `minmax(0,1fr) minmax(0,360px)` seperti `bodyCols` di design.
 *
 * `minmax(0,…)` di mana-mana bukan hiasan: tanpa itu kolom grid memakai
 * min-content dan timeline yang lebarnya ribuan piksel akan mendorong seluruh
 * halaman melebar, bukan menggulir di dalam dirinya sendiri.
 */

import type { ReactNode } from 'react';

export interface StudioLayoutProps {
  readonly header: ReactNode;
  readonly readouts: ReactNode;
  readonly main: ReactNode;
  readonly rail: ReactNode;
  /** Lebar kolom kanan (design: prop `railWidth`, default 360). */
  readonly railWidth?: number;
}

export function StudioLayout({
  header,
  readouts,
  main,
  rail,
  railWidth = 360,
}: StudioLayoutProps): JSX.Element {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--cy-bg)',
        fontFamily: 'var(--cy-font-mono)',
        display: 'grid',
        gridTemplateColumns: 'minmax(0,1fr)',
        gridTemplateRows: 'auto auto minmax(0,1fr)',
      }}
    >
      {header}
      {readouts}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `minmax(0,1fr) minmax(0,${railWidth}px)`,
          gap: '16px',
          padding: '16px 24px 26px',
          alignItems: 'start',
          minWidth: 0,
          maxWidth: '100%',
        }}
      >
        <div style={{ display: 'grid', gap: '16px', minWidth: 0, maxWidth: '100%' }}>{main}</div>
        <div style={{ display: 'grid', gap: '14px', minWidth: 0 }}>{rail}</div>
      </div>
    </div>
  );
}
