/**
 * Baris kontrol loop: IN · OUT · EXIT/RELOOP · ÷2 · ×2, plus tombol quantize.
 *
 * EXIT dan RELOOP adalah SATU tombol yang berganti label, bukan dua: keduanya
 * tidak pernah relevan pada saat yang sama, dan dua tombol berdampingan yang
 * salah satunya selalu mati hanya menghabiskan lebar yang di halaman ini mahal.
 *
 * ÷2 dan ×2 dinonaktifkan saat belum ada loop — bukan diam-diam tidak melakukan
 * apa-apa. Tombol yang bisa ditekan tapi tidak berefek adalah cara tercepat
 * membuat orang mengira alatnya rusak.
 */

import type { BeatGrid } from '../../studio/analysis/beat-grid';
import { Button } from '../../ui/cyber';
import { loopLen, type DeckId, type DeckState } from '../model';
import { djActions } from '../store';

export interface DeckLoopProps {
  readonly deck: DeckState;
  readonly id: DeckId;
  readonly grid: BeatGrid | null;
}

const BTN = { height: '22px', padding: '0 8px', fontSize: '9px' } as const;

export function DeckLoop({ deck, id, grid }: DeckLoopProps): JSX.Element {
  const hasLoop = loopLen(deck.loop) !== null;
  const empty = deck.assetId === null;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '3px', flexWrap: 'wrap' }}>
      <Button
        size="sm"
        variant={deck.loop.inAt !== null && !hasLoop ? 'solid' : 'ghost'}
        disabled={empty}
        onClick={() => djActions.setLoopIn(id, deck.playhead, grid)}
        style={BTN}
      >
        IN
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={empty || deck.loop.inAt === null}
        onClick={() => djActions.setLoopOut(id, deck.playhead, grid)}
        style={BTN}
      >
        OUT
      </Button>
      <Button
        size="sm"
        variant={deck.loop.active ? 'solid' : 'ghost'}
        disabled={!hasLoop}
        onClick={() => (deck.loop.active ? djActions.exitLoop(id) : djActions.reloop(id))}
        title={
          deck.loop.active
            ? 'keluar dari loop — batasnya TETAP tersimpan supaya RELOOP mungkin'
            : 'kembali ke loop yang tersimpan'
        }
        style={BTN}
      >
        {deck.loop.active ? 'EXIT' : 'RELOOP'}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={!hasLoop}
        onClick={() => djActions.halveLoop(id)}
        title="setengahkan loop — dijangkar di titik IN, bukan di playhead"
        style={BTN}
      >
        ÷2
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={!hasLoop}
        onClick={() => djActions.doubleLoop(id)}
        style={BTN}
      >
        ×2
      </Button>
      <Button
        size="sm"
        variant={deck.slip ? 'solid' : 'ghost'}
        disabled={empty}
        onClick={() => djActions.toggleSlip(id)}
        title="SLIP — posisi bayangan terus berjalan di belakang loop/cue; melepasnya melompat ke sana"
        style={{ ...BTN, marginLeft: 'auto' }}
      >
        SLIP
      </Button>
      <Button
        size="sm"
        variant={deck.quantize ? 'solid' : 'ghost'}
        onClick={() => djActions.toggleQuantize(id)}
        title="quantize — cue dan loop menempel ke grid"
        style={BTN}
      >
        Q
      </Button>
    </div>
  );
}
