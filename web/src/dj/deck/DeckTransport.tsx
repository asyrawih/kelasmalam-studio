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
        title="CUE — tekan saat diam untuk memasang titik, tahan untuk mendengarnya"
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
          background: deck.playing ? accent : 'var(--cy-surface-2)',
          color: deck.playing ? 'var(--cy-text-on-accent)' : accent,
        }}
      >
        {deck.playing ? '‖ PAUSE' : '▶ PLAY'}
      </button>
    </div>
  );
}
