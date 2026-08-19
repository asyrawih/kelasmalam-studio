/**
 * ADAPTOR: `DeckView` → props `ScrollingWave`.
 *
 * Ini SATU-SATUNYA berkas di `web/src/dj/` yang tahu bahwa komponen waveform-nya
 * berasal dari timeline Studio dan berbicara dalam kosakata "clip". Semua yang
 * lain hanya mengenal deck.
 *
 * Pemetaannya runtuh jadi identitas — `clipStart = 0`, `speedRatio = 1`,
 * `clipSourceStart = 0` — dan itu bukan kebetulan yang menyenangkan, melainkan
 * konsekuensi langsung dari "deck memutar SATU LAGU UTUH": dua koordinat
 * docs/07 §8d memang tidak punya arti di sini.
 *
 * `positionSourceSec` mengembalikan `null` di iterasi ini karena tidak ada yang
 * berbunyi, jadi jendela mengikuti `deck.playhead` yang dimajukan
 * `djActions.tick`. Di fase audio ia diganti jam deck sungguhan, dan **tidak
 * ada baris lain di halaman ini yang perlu berubah.**
 */

import { useMemo } from 'react';

import { BAND_COLORS, ScrollingWave } from '../../studio/timeline';
import { deckClockSec } from '../audio/deck-clock';
import type { StudioAsset } from '../../studio/store';
import { loopRegion, type DeckView } from '../deck-view';
import type { Samples } from '../model';
import { djActions } from '../store';

/** Lebar jendela dalam detik. 8 detik ≈ tampilan CDJ pada zoom menengah. */
export const DECK_WINDOW_SEC = 8;

export interface DeckScrollingWaveProps {
  readonly view: DeckView;
  readonly accent: string;
}

export function DeckScrollingWave({ view, accent }: DeckScrollingWaveProps): JSX.Element {
  const { deck, grid } = view;
  const windowLen = Math.max(1, Math.round(DECK_WINDOW_SEC * deck.sampleRate));
  // Jam deck, bukan jam transport Studio. Dibuat sekali per deck supaya
  // identitas fungsinya stabil dan `ScrollingWave` tidak melihatnya berubah.
  const clock = useMemo(() => deckClockSec(deck.id), [deck.id]);

  return (
    <ScrollingWave
      asset={view.asset as StudioAsset | undefined}
      grid={grid}
      sampleRate={deck.sampleRate}
      clipStart={0}
      speedRatio={1}
      clipSourceStart={0}
      clipSourceLen={Math.max(1, deck.frames)}
      windowLen={windowLen}
      bands={BAND_COLORS}
      playhead={deck.playhead}
      playing={deck.playing}
      auditioning={false}
      region={loopRegion(deck)}
      regionLive={deck.loop.active}
      regionTint={`${accent}28`}
      regionStroke={accent}
      positionSourceSec={clock}
      title="tarik untuk mencari posisi · tahan Shift untuk menempel ke ketukan"
      onScrub={(phase, sourceAt: Samples) => {
        if (phase === 'move' || phase === 'end') djActions.seek(deck.id, sourceAt);
      }}
    />
  );
}
