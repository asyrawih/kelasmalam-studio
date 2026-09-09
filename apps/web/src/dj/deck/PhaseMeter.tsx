/**
 * PHASE METER — seberapa jauh ketukan deck ini meleset dari MASTER.
 *
 * Ini pengganti sadar untuk loop koreksi fase kontinu milik Mixxx. Alasan
 * lengkapnya ada di kepala `sync.ts`; ringkasnya: deck di sini berjalan pada
 * `playbackRate` konstan, jadi sekali sejajar ia tetap sejajar — kecuali kalau
 * **grid-nya yang salah**. Drift yang tersisa karena itu bukan sesuatu yang
 * pantas ditambal diam-diam dengan menggoyang rate; ia pantas DITUNJUKKAN,
 * supaya yang diperbaiki adalah grid-nya.
 *
 * CDJ punya meter yang sama persis, dan gunanya sama: melihat pergeseran
 * sebelum ia terdengar.
 *
 * ## Kenapa komponen tersendiri
 *
 * Ia membaca playhead KEDUA deck, yang bergerak ~16×/detik. Menaruhnya di dalam
 * `DeckTempo` berarti seluruh kolom tempo — fader, pemilih rentang, tiga tombol
 * — ikut di-render ulang 16×/detik. Aturan stabilitas referensi di kepala
 * `store.ts` menyebut ini persis; memisahkannya membuat yang bergerak cepat
 * tetap kecil.
 *
 * Semua selector di sini mengembalikan PRIMITIF, bukan objek.
 */

import { DECK_ACCENT, type DeckId } from '../model';
import { useDj } from '../store';
import { phaseErrorOf } from '../sync-ops';

/** Di bawah ini dianggap sejajar. ±0.01 ketukan pada 128 BPM ≈ 4.7 ms. */
const IN_PHASE = 0.01;

export interface PhaseMeterProps {
  readonly id: DeckId;
  readonly accent: string;
}

export function PhaseMeter({ id, accent }: PhaseMeterProps): JSX.Element | null {
  const sync = useDj((s) => s.decks[id].sync);
  const master = useDj((s) => s.masterDeck);
  // Kedua playhead dilanggan sebagai angka supaya meter ini ikut bergerak.
  // `phaseErrorOf` membacanya lagi dari store — yang penting di sini hanyalah
  // ADANYA langganan, bukan nilainya.
  useDj((s) => s.decks[id].playhead);
  useDj((s) => (s.masterDeck === null ? 0 : s.decks[s.masterDeck].playhead));

  if (sync !== 'follower' || master === null || master === id) return null;

  const err = phaseErrorOf(id);
  if (err === null) return null;

  const aligned = Math.abs(err) <= IN_PHASE;
  // `err` ada di [−0.5, 0.5) → 0 di tengah strip.
  const leftPct = (err + 0.5) * 100;

  return (
    <div
      data-phase-meter={id}
      title={
        aligned
          ? 'ketukan sejajar dengan MASTER'
          : `meleset ${(err * 1000).toFixed(0)}‰ ketukan dari MASTER — kalau ini merayap terus, yang salah BPM grid-nya, bukan SYNC`
      }
      style={{
        position: 'relative',
        width: '100%',
        height: '6px',
        background: 'var(--cy-surface-2)',
        border: '1px solid var(--cy-border)',
      }}
    >
      {/* Garis tengah = sejajar. */}
      <span
        style={{
          position: 'absolute',
          left: '50%',
          top: 0,
          bottom: 0,
          width: '1px',
          background: 'var(--cy-border-strong)',
        }}
      />
      <span
        style={{
          position: 'absolute',
          left: `${leftPct}%`,
          top: '-1px',
          bottom: '-1px',
          width: '3px',
          marginLeft: '-1.5px',
          background: aligned ? accent : '#ff4d4d',
        }}
      />
    </div>
  );
}

/** Warna aksen deck, untuk pemanggil yang belum punya. */
export const phaseAccent = (id: DeckId): string => DECK_ACCENT[id];
