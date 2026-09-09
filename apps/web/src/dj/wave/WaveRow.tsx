/**
 * Baris waveform besar: satu jendela bergeser per deck, ditumpuk.
 *
 * Di rekordbox baris ini menumpuk kedua lagu di satu bidang. Di sini keduanya
 * dipisah jadi dua jalur bertumpuk, dan itu tetap keputusan sadar meski
 * waveform-nya kini berwarna per pita (`envelope.ts` menyimpan puncak
 * low/mid/high per bucket): warna dipakai untuk membedakan KICK DARI HI-HAT,
 * bukan deck A dari deck B. Kalau ia dipaksa merangkap dua tugas, keduanya
 * hilang — dan yang membedakan deck di sini adalah posisinya, yang tidak
 * memakai anggaran warna sama sekali.
 */

import { DeckStems } from '../deck/DeckStems';
import type { DeckView } from '../deck-view';
import { GridEditBar } from '../grid/GridEditBar';
import { DECK_ACCENT, type DeckId } from '../model';
import { useDj } from '../store';
import { DeckScrollingWave } from './DeckScrollingWave';

export interface WaveRowProps {
  readonly views: Readonly<Record<DeckId, DeckView>>;
}

export function WaveRow({ views }: WaveRowProps): JSX.Element {
  /*
   * Bilah GRID EDIT hidup DI SINI, bukan di dalam deck: yang sedang dikoreksi
   * adalah garis grid, dan garis grid hanya terlihat di baris ini. Ia mendorong
   * kedua jalur waveform ke bawah alih-alih menutupinya — lihat kepala
   * `GridEditBar.tsx`.
   */
  const gridDeck = useDj((s) => s.gridEdit.deck);
  const deckAAssetId = useDj((s) => s.decks.A.assetId);
  const deckBAssetId = useDj((s) => s.decks.B.assetId);
  const assetIds: Readonly<Record<DeckId, number | null>> = {
    A: deckAAssetId,
    B: deckBAssetId,
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: 'var(--cy-border)',
      }}
    >
      {gridDeck === null ? null : <GridEditBar id={gridDeck} />}

      <div
        style={{
          display: 'grid',
          gridTemplateRows: 'minmax(0,1fr) minmax(0,1fr)',
          flex: 1,
          minHeight: 0,
          gap: '1px',
        }}
      >
        {(['A', 'B'] as const).map((id) => (
          <div
            key={id}
            style={{
              position: 'relative',
              minHeight: 0,
              background: 'var(--cy-surface-1)',
              overflow: 'hidden',
            }}
          >
            <DeckScrollingWave view={views[id]} accent={DECK_ACCENT[id]} />
            <div
              style={{
                position: 'absolute',
                zIndex: 2,
                right: '6px',
                top: '50%',
                transform: 'translateY(-50%)',
              }}
            >
              <DeckStems id={id} assetId={assetIds[id]} overlay />
            </div>
            <span
              style={{
                position: 'absolute',
                left: '6px',
                top: '4px',
                fontSize: '10px',
                letterSpacing: '.16em',
                color: DECK_ACCENT[id],
                pointerEvents: 'none',
                textShadow: '0 0 6px #000',
              }}
            >
              {id}
            </span>
            {/* Playhead tetap di TENGAH — itu seluruh guna tampilan ini. */}
            <div
              style={{
                position: 'absolute',
                left: '50%',
                top: 0,
                bottom: 0,
                width: '1px',
                background: '#ffffff',
                pointerEvents: 'none',
              }}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
