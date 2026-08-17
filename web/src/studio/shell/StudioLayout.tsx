/**
 * Kerangka halaman: grid `auto auto minmax(0,1fr)` (header, readout, body) dan
 * body dua kolom seperti `bodyCols` di design.
 *
 * `minmax(0,…)` di mana-mana bukan hiasan: tanpa itu kolom grid memakai
 * min-content dan timeline yang lebarnya ribuan piksel akan mendorong seluruh
 * halaman melebar, bukan menggulir di dalam dirinya sendiri.
 */

import type { ReactNode } from 'react';

import { useStudio } from '../store';

/**
 * Lebar rail. Design menulis 360, tapi rail sekarang menyusun kartunya dalam
 * DUA kolom, dan 360 dibagi dua adalah ~165 px per kartu — di sana trek slider
 * Amplify tinggal ~140 px, detent 0 dB-nya ~1,5 px, dan lima preset Render
 * Speed tidak muat sebaris. 600 memberi ~293 px per kartu.
 */
const DEFAULT_RAIL_WIDTH = 600;

/**
 * Batas atas rail sebagai pecahan lebar body.
 *
 * Rail melebar tidak boleh memakan kolom kerja: timeline adalah permukaan
 * utamanya, jadi ia tetap harus dapat mayoritas. 44% menjaga arrangement di
 * ~56% pada layar mana pun, sekaligus membuat rail menyusut dengan sendirinya
 * di layar sempit — dan begitu ia turun di bawah `MIN_TWO_COLUMN_WIDTH`,
 * `ReorderableStack` yang mengukur lebarnya sendiri jatuh ke satu kolom.
 */
const RAIL_MAX_FRACTION = '44%';

export interface StudioLayoutProps {
  readonly header: ReactNode;
  readonly readouts: ReactNode;
  readonly main: ReactNode;
  readonly rail: ReactNode;
  /** Lebar maksimum kolom kanan (design: prop `railWidth`). */
  readonly railWidth?: number;
}

export function StudioLayout({
  header,
  readouts,
  main,
  rail,
  railWidth = DEFAULT_RAIL_WIDTH,
}: StudioLayoutProps): JSX.Element {
  // Saat ada panel yang dibentangkan, rail dipindahkan ke dalam overlay
  // fullscreen (lihat FloatingAside di ReorderableStack) dan TIDAK boleh ikut
  // dirender di sini. Merender keduanya berarti dua instance StudioRail hidup
  // bersamaan: dua rAF meter, dua AnalyserNode tap, dua langganan store.
  const maximized = useStudio((s) => s.maximizedPanel) !== null;

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
          gridTemplateColumns: maximized
            ? 'minmax(0,1fr)'
            : `minmax(0,1fr) minmax(0,min(${railWidth}px,${RAIL_MAX_FRACTION}))`,
          gap: '16px',
          padding: '16px 24px 26px',
          alignItems: 'start',
          minWidth: 0,
          maxWidth: '100%',
        }}
      >
        <div style={{ display: 'grid', gap: '16px', minWidth: 0, maxWidth: '100%' }}>{main}</div>
        {maximized ? null : (
          <div style={{ display: 'grid', gap: '14px', minWidth: 0 }}>{rail}</div>
        )}
      </div>
    </div>
  );
}
