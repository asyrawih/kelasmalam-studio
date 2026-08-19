/**
 * Kerangka halaman DJ: 100vh, LIMA baris, dan **tidak menggulir**.
 *
 * Kebalikan dari `StudioLayout`, yang sengaja membiarkan dokumen menggulir
 * supaya toolbar `sticky`-nya bekerja. Di sini itu salah, dan tiga alasannya
 * berdiri sendiri-sendiri:
 *
 *  1. Selama mixing, tangan tidak bisa mencari kontrol yang berada di luar
 *     layar. Tombol yang perlu digulir untuk dicapai sama saja tidak ada.
 *  2. `ScrollingWave` memetakan `windowLen` ke LEBAR canvas. Ukuran yang
 *     berubah saat halaman digulir mengubah skala px-per-detik di tengah mix —
 *     mata kehilangan acuan yang justru jadi seluruh guna tampilan itu.
 *  3. `wheel` di atas jog atau fader akan menggulir halaman alih-alih
 *     menggerakkan kontrolnya.
 *
 * `minmax(0, …)` ada di SETIAP baris dan kolom, dan `minHeight: 0` di setiap
 * anak. Alasannya sama dengan catatan di `StudioLayout.tsx`, tapi gejalanya di
 * halaman `overflow: hidden` lebih buruk: isinya terpotong TANPA scrollbar,
 * jadi tidak ada petunjuk apa pun bahwa ada yang hilang.
 */

import type { ReactNode, RefObject } from 'react';

import { MIN_USABLE_WIDTH, type Band } from './useViewportBand';

/**
 * Urutan yang dikorbankan saat layar memendek, dan alasannya:
 *
 *  - `tall → normal`: overview lagu-penuh dan browser menyusut. Keduanya
 *    tampilan ORIENTASI, bukan permukaan kerja.
 *  - `normal → compact`: overview HILANG, browser runtuh jadi strip.
 *
 * Pad, fader, dan jog TIDAK PERNAH menyusut: itu sasaran sentuh, dan
 * mengecilkannya membuat alatnya salah sasaran — bukan lebih ringkas.
 */
const ROWS: Readonly<Record<Band, string>> = {
  tall: 'auto minmax(120px,18vh) minmax(0,1fr) auto minmax(140px,24vh)',
  normal: 'auto minmax(96px,15vh) minmax(0,1fr) auto minmax(112px,20vh)',
  compact: 'auto minmax(80px,13vh) minmax(0,1fr) auto auto',
};

export interface DjLayoutProps {
  /** Akar halaman — dipakai `useDjAudio` untuk menangkap gestur pertama. */
  readonly rootRef?: RefObject<HTMLDivElement>;
  readonly band: Band;
  readonly header: ReactNode;
  /** Baris 2 — waveform besar kedua deck. */
  readonly waves: ReactNode;
  /** Baris 3 — DECK A · MIXER · DECK B. Satu-satunya baris yang melar. */
  readonly main: ReactNode;
  /** Baris 4 — Beat FX. */
  readonly fx: ReactNode;
  /** Baris 5 — Collection. SATU-SATUNYA yang boleh menggulir. */
  readonly browser: ReactNode;
}

export function DjLayout({
  rootRef,
  band,
  header,
  waves,
  main,
  fx,
  browser,
}: DjLayoutProps): JSX.Element {
  return (
    <div
      ref={rootRef}
      data-dj-root
      style={{
        height: '100vh',
        display: 'grid',
        gridTemplateColumns: 'minmax(0,1fr)',
        gridTemplateRows: ROWS[band],
        background: 'var(--cy-bg)',
        color: 'var(--cy-text)',
        fontFamily: 'var(--cy-font-mono)',
        // Halaman TIDAK menggulir tegak. Mendatar boleh, karena di bawah 1024px
        // crossfader dan pad memang tidak muat dan menyembunyikannya lebih
        // buruk daripada memintanya digeser.
        overflowY: 'hidden',
        overflowX: 'auto',
        minWidth: `${MIN_USABLE_WIDTH}px`,
      }}
    >
      {header}
      <Row>{waves}</Row>
      <Row>{main}</Row>
      <Row>{fx}</Row>
      <Row last>{browser}</Row>
    </div>
  );
}

/** `minHeight: 0` di tiap anak grid — tanpa ini isinya terpotong tanpa gejala. */
function Row({ children, last = false }: { children: ReactNode; last?: boolean }): JSX.Element {
  return (
    <div
      style={{
        minHeight: 0,
        minWidth: 0,
        overflow: 'hidden',
        borderTop: '1px solid var(--cy-border)',
        borderBottom: last ? 'none' : undefined,
      }}
    >
      {children}
    </div>
  );
}
