/**
 * Crossfader + pembacaan gain kedua sisi.
 *
 * Angka gain ditampilkan karena kurva yang dipilih HARUS bisa dilihat, bukan
 * hanya didengar — dan di iterasi ini belum ada yang bisa didengar sama sekali.
 * Angka inilah satu-satunya cara membuktikan bahwa `smooth`, `sharp`, dan `cut`
 * benar-benar berbeda.
 *
 * Di fase audio, angka ini juga yang jadi kriteria "done": sapuan crossfader
 * pada dua sine identik harus cocok dengan angka di sini dalam ±0.1 dB.
 */

import { DECK_ACCENT, type CrossGains } from '../model';
import { Fader } from './Fader';

export interface CrossfaderProps {
  readonly value: number;
  readonly onChange: (v: number) => void;
  readonly gains: CrossGains;
}

export function Crossfader({ value, onChange, gains }: CrossfaderProps): JSX.Element {
  const pct = (g: number): string => `${Math.round(g * 100)}`;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
      <span
        style={{
          fontSize: '9px',
          color: DECK_ACCENT.A,
          fontVariantNumeric: 'tabular-nums',
          width: '22px',
          textAlign: 'right',
        }}
      >
        {pct(gains.a)}
      </span>
      <Fader
        orientation="horizontal"
        value={value}
        onChange={onChange}
        length={168}
        thickness={22}
        detent={0.5}
        resetTo={0.5}
        label="crossfader"
        title="crossfader — klik-ganda untuk kembali ke tengah"
      />
      <span
        style={{
          fontSize: '9px',
          color: DECK_ACCENT.B,
          fontVariantNumeric: 'tabular-nums',
          width: '22px',
        }}
      >
        {pct(gains.b)}
      </span>
    </div>
  );
}
