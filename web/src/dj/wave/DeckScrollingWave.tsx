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
 * ## MODE GRID EDIT
 *
 * Saat deck ini sedang disunting grid-nya, dua hal berubah dan tidak ada yang
 * ketiga:
 *
 * 1. **Lebar jendela** jadi sekian BAR (`gridEdit.zoomBars`), bukan 8 detik
 *    mati. Menaruh downbeat di transien butuh 1–2 bar memenuhi layar; pada
 *    8 detik sebuah ketukan hanya selebar beberapa piksel dan tangan tidak
 *    punya sasaran.
 * 2. **Arti menarik** BISA diubah jadi menggeser GRID — playhead diam, garis
 *    bar yang berjalan di bawah tangan — tapi hanya kalau user memilihnya di
 *    panel (`gridEdit.drag === 'grid'`). Bawaannya tarikan tetap mencari
 *    posisi, karena itu artinya di seluruh sisa aplikasi ini dan di rekordbox,
 *    dan menyetel grid justru menuntut playhead sering dipindah.
 *
 * Yang SENGAJA tidak berubah: pemetaan piksel→SOURCE. `onScrub` sudah
 * melaporkan posisi source di tengah jendela dengan matematika yang sama persis
 * dengan yang dipakai menggambar; menulis pemetaan kedua di sini berarti grid
 * bisa meleset dari gambarnya sendiri, dan itu jenis cacat yang mustahil
 * dilacak dari layar (alasan yang sama sudah ditulis di kepala `beat-draw.ts`).
 */

import { useMemo, useRef } from 'react';

import { BAND_COLORS, ScrollingWave } from '../../studio/timeline';
import { rawAnchorSec } from '../../studio/analysis/grid-edit';
import { deckClockSec } from '../audio/deck-clock';
import type { StudioAsset } from '../../studio/store';
import { loopRegion, type DeckView } from '../deck-view';
import { beginAnchorDrag, dragAnchorTo } from '../grid/grid-ops';
import type { Samples } from '../model';
import { djActions, useDj } from '../store';

/** Lebar jendela dalam detik. 8 detik ≈ tampilan CDJ pada zoom menengah. */
export const DECK_WINDOW_SEC = 8;

export interface DeckScrollingWaveProps {
  readonly view: DeckView;
  readonly accent: string;
}

export function DeckScrollingWave({ view, accent }: DeckScrollingWaveProps): JSX.Element {
  const { deck, grid } = view;
  const gridDeck = useDj((s) => s.gridEdit.deck);
  const dragMode = useDj((s) => s.gridEdit.drag);
  const zoomBars = useDj((s) => s.gridEdit.zoomBars);
  const editing = gridDeck === deck.id;
  /*
   * Menarik hanya menggeser grid kalau mode grid menyala DAN user memilihnya.
   * Bawaannya tarikan tetap berarti "cari posisi" — sama seperti di luar mode
   * grid, dan sama seperti rekordbox, yang mengubah grid lewat tombol saja.
   */
  const dragMovesGrid = editing && dragMode === 'grid';

  // Jam deck, bukan jam transport Studio. Dibuat sekali per deck supaya
  // identitas fungsinya stabil dan `ScrollingWave` tidak melihatnya berubah.
  const clock = useMemo(() => deckClockSec(deck.id), [deck.id]);

  const windowLen = useMemo(() => {
    if (editing && grid !== null) {
      const barSec = (60 / grid.bpm) * grid.beatsPerBar;
      return Math.max(1, Math.round(barSec * zoomBars * deck.sampleRate));
    }
    return Math.max(1, Math.round(DECK_WINDOW_SEC * deck.sampleRate));
  }, [editing, grid, zoomBars, deck.sampleRate]);

  /**
   * Keadaan awal satu tarikan grid: di mana anchor berada, dan materi mana yang
   * ada di bawah playhead saat jari turun. Keduanya dibutuhkan karena `onScrub`
   * melaporkan POSISI, sedangkan yang dipakai di sini adalah SELISIHNYA.
   */
  const dragBase = useRef<{ anchorSec: number; centerSample: number } | null>(null);

  const anchorAt =
    editing && view.asset !== undefined
      ? Math.round(rawAnchorSec(view.asset) * deck.sampleRate)
      : null;

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
      anchorAt={anchorAt}
      title={
        dragMovesGrid
          ? 'GRID EDIT — tarik untuk menggeser grid; playhead tidak bergerak'
          : 'tarik untuk mencari posisi · tahan Shift untuk menempel ke ketukan'
      }
      onScrub={(phase, sourceAt: Samples) => {
        if (!dragMovesGrid) {
          // Ditandai SELAMA tarikan supaya `startSyncFollow` tidak memfase ulang
          // deck sebelahnya pada tiap `pointermove` — lihat `DeckState.scrubbing`.
          if (phase === 'start') djActions.setScrubbing(deck.id, true);
          if (phase === 'move' || phase === 'end') djActions.seek(deck.id, sourceAt);
          // Dilepas SETELAH `seek` terakhir, bukan sebelum: kalau dilepas dulu,
          // langganan sync melihat tarikan sudah selesai lalu `seek` penutupnya
          // datang belakangan sebagai lompatan kedua.
          if (phase === 'end') djActions.setScrubbing(deck.id, false);
          return;
        }

        if (phase === 'start') {
          const anchorSec = beginAnchorDrag(deck.id);
          dragBase.current = anchorSec === null ? null : { anchorSec, centerSample: sourceAt };
          return;
        }

        const base = dragBase.current;
        if (base === null) return;

        // TANDA MINUS-NYA WAJIB, dan ini satu-satunya tempat ia bisa salah.
        //
        // `onScrub` melaporkan materi mana yang HARUS berada di bawah playhead
        // setelah tarikan: menarik ke kiri berarti meminta materi yang lebih
        // belakangan, jadi `sourceAt` NAIK. Yang diinginkan user saat menarik
        // ke kiri adalah gridnya ikut ke kiri — yaitu anchor TURUN. Karena itu
        // selisihnya dikurangkan, bukan ditambahkan.
        //
        // Salah tanda menghasilkan kontrol yang bergerak terbalik dua kali
        // lebih cepat, dan yang disalahkan akan trackpad-nya.
        const deltaSec = (sourceAt - base.centerSample) / deck.sampleRate;
        dragAnchorTo(deck.id, base.anchorSec - deltaSec);

        if (phase === 'end') dragBase.current = null;
      }}
    />
  );
}
