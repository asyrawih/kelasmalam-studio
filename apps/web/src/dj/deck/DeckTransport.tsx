/**
 * CUE dan PLAY/PAUSE.
 *
 * CUE memakai `pointerdown`/`pointerup`, bukan `click`, karena semantik CDJ
 * memang membedakan TEKAN dari LEPAS: menahan CUE saat deck diam di cue point
 * memutar selama ditahan dan kembali begitu dilepas. Dengan `click` — yang baru
 * terjadi setelah lepas — perilaku itu tidak bisa dinyatakan sama sekali.
 *
 * `onPointerLeave` ikut melepas: kalau tidak, menggeser kursor keluar tombol
 * sambil menahan akan meninggalkan deck dalam keadaan "cue ditahan" selamanya.
 *
 * PLAY tidak ikut menyala selama cue ditahan — lihat `showPlaying` di bawah.
 */

import type { DeckId, DeckState } from '../model';
import { djActions } from '../store';

export interface DeckTransportProps {
  readonly deck: DeckState;
  readonly id: DeckId;
  readonly accent: string;
}

export function DeckTransport({ deck, id, accent }: DeckTransportProps): JSX.Element {
  const empty = deck.assetId === null;

  /*
   * Selama CUE ditahan deck MEMANG berbunyi — tapi ia berhenti lagi begitu
   * jari diangkat. Menyalakan PLAY seperti pemutaran biasa membuat satu klik
   * CUE terlihat seperti dua tombol yang tertekan bersamaan: CUE menyala, PLAY
   * berkedip jadi PAUSE, lalu keduanya balik. Yang ditampilkan tombol PLAY
   * adalah keadaan yang akan BERTAHAN, bukan getaran sesaat selama preview.
   */
  const showPlaying = deck.playing && !deck.cueHeld;

  const base: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    height: '38px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '6px',
    fontFamily: 'var(--cy-font-mono)',
    fontSize: '11px',
    letterSpacing: '.14em',
    border: '1px solid var(--cy-border-strong)',
    cursor: empty ? 'not-allowed' : 'pointer',
    opacity: empty ? 0.4 : 1,
  };

  return (
    <div style={{ display: 'flex', gap: '4px' }}>
      <button
        type="button"
        className="cy-btn-reset cy-focusable"
        disabled={empty}
        onPointerDown={() => djActions.cuePress(id)}
        onPointerUp={() => djActions.cueRelease(id)}
        onPointerLeave={() => djActions.cueRelease(id)}
        title="CUE — saat main: balik ke titik cue dan berhenti. Saat diam: pasang titik di sini; TAHAN untuk mendengarnya sebentar"
        style={{
          ...base,
          background: deck.cueHeld ? accent : 'var(--cy-surface-2)',
          color: deck.cueHeld ? 'var(--cy-text-on-accent)' : accent,
        }}
      >
        CUE
      </button>
      <button
        type="button"
        className="cy-btn-reset cy-focusable"
        disabled={empty}
        onClick={() => djActions.togglePlay(id)}
        title="putar / jeda"
        style={{
          ...base,
          background: showPlaying ? accent : 'var(--cy-surface-2)',
          color: showPlaying ? 'var(--cy-text-on-accent)' : accent,
        }}
      >
        {showPlaying ? '‖ PAUSE' : '▶ PLAY'}
      </button>
    </div>
  );
}
