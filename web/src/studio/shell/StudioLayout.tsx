/**
 * Kerangka halaman: satu kolom penuh (header, readout, toolbar menu, body).
 *
 * `minmax(0,…)` bukan hiasan: tanpa itu kolom grid memakai min-content dan
 * timeline yang lebarnya ribuan piksel akan mendorong seluruh halaman melebar,
 * bukan menggulir di dalam dirinya sendiri.
 */

import type { ReactNode } from 'react';

export interface StudioLayoutProps {
  readonly header: ReactNode;
  readonly readouts: ReactNode;
  /**
   * Toolbar menu yang MENEMPEL di atas halaman.
   *
   * Halaman ini sengaja tidak punya scroller sendiri — dokumen yang menggulir,
   * dan `position: sticky` di dalam toolbar bekerja terhadapnya. Membuat body
   * ber-`overflow: auto` di sini akan mematikan sticky-nya tanpa gejala lain
   * selain "toolbar-nya tidak menempel".
   */
  readonly menuBar?: ReactNode;
  readonly main: ReactNode;
  /**
   * Dok yang MENEMPEL di dasar layar (kepustakaan).
   *
   * Ia bekerja karena halaman ini sengaja tidak punya scroller sendiri —
   * dokumen yang menggulir, dan `position: sticky` di dalam dok bekerja
   * terhadapnya. Catatan yang sama sudah menjaga `menuBar` di atas; keduanya
   * mati bersamaan kalau body dibungkus `overflow: auto`.
   */
  readonly dock?: ReactNode;
}

/**
 * Kerangka halaman: satu kolom penuh.
 *
 * Rail kanan SUDAH TIDAK ADA — seluruh isinya (mixer, EQ, master, compile,
 * transport, shortcut) pindah ke toolbar menu di atas. Dengan begitu timeline
 * mendapat lebar penuh layar, dan tiap kontrol baru yang ditambahkan nanti tidak
 * lagi memakan bagiannya.
 */
export function StudioLayout({
  header,
  readouts,
  menuBar,
  main,
  dock,
}: StudioLayoutProps): JSX.Element {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--cy-bg)',
        fontFamily: 'var(--cy-font-mono)',
        display: 'grid',
        gridTemplateColumns: 'minmax(0,1fr)',
        gridTemplateRows: 'auto auto auto minmax(0,1fr) auto',
      }}
    >
      {header}
      {readouts}
      {menuBar}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0,1fr)',
          gap: '16px',
          padding: '16px 24px 26px',
          alignItems: 'start',
          minWidth: 0,
          maxWidth: '100%',
        }}
      >
        {main}
      </div>
      {dock}
    </div>
  );
}
