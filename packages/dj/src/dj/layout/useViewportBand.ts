/**
 * Pita tinggi viewport, sebagai PRIMITIF.
 *
 * Kenapa bukan media query: seluruh styling di repo ini adalah objek
 * `CSSProperties` inline yang disalin dari design (lihat catatan di kepala
 * `ui/cyber/theme.css`) — tidak ada CSS-in-JS, dan menambah satu berkas CSS
 * hanya untuk tiga breakpoint akan memecah bahasa visualnya jadi dua tempat.
 *
 * Nilainya sengaja berupa string pendek dan bukan angka `innerHeight`: kalau
 * hook ini mengembalikan tinggi mentah, setiap piksel resize akan me-render
 * seluruh halaman. Dengan tiga pita, render terjadi hanya saat user benar-benar
 * menyeberangi ambang.
 */

import { useEffect, useState } from 'react';

export type Band = 'compact' | 'normal' | 'tall';

/** Di bawah ini tidak ada tata letak yang jujur — halaman mengatakannya. */
export const MIN_USABLE_HEIGHT = 560;
/** Crossfader dan pad butuh lebar; di bawah ini halaman menggulir mendatar. */
export const MIN_USABLE_WIDTH = 1024;

export function bandFor(height: number): Band {
  if (height < 700) return 'compact';
  if (height < 900) return 'normal';
  return 'tall';
}

export interface Viewport {
  readonly band: Band;
  readonly tooShort: boolean;
  readonly tooNarrow: boolean;
}

function read(): Viewport {
  const h = typeof window === 'undefined' ? 900 : window.innerHeight;
  const w = typeof window === 'undefined' ? 1440 : window.innerWidth;
  return { band: bandFor(h), tooShort: h < MIN_USABLE_HEIGHT, tooNarrow: w < MIN_USABLE_WIDTH };
}

export function useViewport(): Viewport {
  const [v, setV] = useState<Viewport>(read);

  useEffect(() => {
    const onResize = (): void => {
      // Bandingkan isinya, bukan objeknya: `read()` selalu objek baru, dan
      // menyetelnya tiap `resize` berarti render di tiap piksel tarikan jendela.
      setV((prev) => {
        const next = read();
        return prev.band === next.band &&
          prev.tooShort === next.tooShort &&
          prev.tooNarrow === next.tooNarrow
          ? prev
          : next;
      });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return v;
}
