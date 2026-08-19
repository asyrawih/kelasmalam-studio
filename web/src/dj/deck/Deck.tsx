/**
 * SATU deck. Komponen ini dirender DUA KALI — sekali per sisi layar.
 *
 * ## Bagaimana pencerminannya dinyatakan
 *
 * Hanya lewat tiga hal: `flexDirection` (`row` ↔ `row-reverse`), `textAlign`,
 * dan satu CSS variable `--dj-deck-accent` yang diset di elemen akar sehingga
 * SELURUH anak DOM cukup menulis `var(--dj-deck-accent)` tanpa tahu ia deck
 * mana.
 *
 * **`transform: scaleX(-1)` TIDAK dipakai, dan itu bukan selera.** Ia membalik
 * teks, membalik arah drag (fader tempo jadi terbalik tanpa satu baris kode pun
 * yang mengatakannya), dan membuat `getBoundingClientRect` di `useDrag`
 * menghasilkan fraksi terbalik — bug yang hanya muncul di satu deck dan
 * mustahil ditebak dari kodenya.
 *
 * Canvas tidak bisa membaca custom property CSS dengan murah, jadi `accent`
 * TETAP diteruskan sebagai prop — tapi hanya ke penggambar canvas.
 */

import { useMemo } from 'react';

import { useStudio } from '../../studio/store';
import { deckView } from '../deck-view';
import { DECK_ACCENT, type DeckId, type DeckSide } from '../model';
import { djActions, selectDeck, selectTrackCues, useDj } from '../store';
import { DeckLoop } from './DeckLoop';
import { DeckPads } from './DeckPads';
import { GridEditPopup } from '../grid/GridEditPopup';
import { toggleSyncFor } from '../sync-ops';
import { DeckReadout } from './DeckReadout';
import { DeckTempo } from './DeckTempo';
import { DeckTransport } from './DeckTransport';
import { Jog } from './Jog';
import { DeckOverview } from '../wave/DeckOverview';

export interface DeckProps {
  readonly id: DeckId;
  readonly side: DeckSide;
  /** Tinggi jog & fader tempo; menyusut hanya saat layar benar-benar pendek. */
  readonly compact: boolean;
}

export function Deck({ id, side, compact }: DeckProps): JSX.Element {
  const deck = useDj(selectDeck(id));
  const cues = useDj(selectTrackCues(id));
  const masterDeck = useDj((s) => s.masterDeck);
  const quantizeDiv = useDj((s) => s.quantizeDiv);
  const focused = useDj((s) => s.focusedDeck === id);
  // Selector di-index dengan -1 saat deck kosong: `assets` berkunci number, dan
  // -1 tidak pernah dipakai sebagai id asset.
  const asset = useStudio((s) => s.assets[deck.assetId ?? -1]);

  const view = useMemo(() => deckView(deck, asset), [deck, asset]);
  const accent = DECK_ACCENT[id];
  const mirrored = side === 'right';
  /** Satu helper untuk SELURUH pencerminan — dua tempat pasti menyimpang. */
  const mir = <T,>(a: T, b: T): T => (mirrored ? b : a);

  const jogSize = compact ? 96 : 128;
  const faderH = compact ? 96 : 132;

  return (
    <div
      data-dj-deck={id}
      data-dj-focused={focused ? '' : undefined}
      /*
       * Menyentuh deck mana pun memindahkan FOKUS PERINTAH ke sana. Tanpa ini,
       * Spasi dan Enter tidak punya sasaran yang bisa dijelaskan di halaman dua
       * deck — dan memaksa user menekan Tab lebih dulu berarti keyboard dan
       * tetikus bercerita berbeda tentang deck mana yang "sedang dipakai".
       */
      onPointerDownCapture={() => djActions.focusDeck(id)}
      style={{
        // Satu-satunya tempat warna deck ditetapkan untuk seluruh subpohon DOM.
        ['--dj-deck-accent' as string]: accent,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        minHeight: 0,
        gap: '6px',
        padding: '6px',
        background: 'var(--cy-surface-1)',
        borderLeft: mirrored ? '1px solid var(--cy-border)' : 'none',
        borderRight: mirrored ? 'none' : '1px solid var(--cy-border)',
        // Fokus digambar sebagai garis tipis di ATAS deck: cukup untuk dilihat
        // dari sudut mata, tidak cukup untuk bersaing dengan waveform.
        borderTop: `2px solid ${focused ? accent : 'transparent'}`,
        overflow: 'hidden',
        // Jangkar untuk `GridEditPopup`, yang melayang di dalam deck ini.
        position: 'relative',
      }}
    >
      <GridEditPopup id={id} />

      <DeckReadout view={view} id={id} accent={accent} mirrored={mirrored} />

      <DeckOverview view={view} cues={cues} id={id} accent={accent} height={compact ? 26 : 34} />

      <div
        style={{
          display: 'flex',
          flexDirection: mir('row', 'row-reverse'),
          gap: '8px',
          minHeight: 0,
          flex: 1,
        }}
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            flex: 1,
            minWidth: 0,
            justifyContent: 'space-between',
          }}
        >
          <DeckLoop deck={deck} id={id} grid={view.grid} />
          <DeckPads
            deck={deck}
            id={id}
            cues={cues}
            grid={view.grid}
            accent={accent}
            quantizeDiv={quantizeDiv}
          />
          <DeckTransport deck={deck} id={id} accent={accent} />
        </div>

        <div
          style={{
            display: 'flex',
            flexDirection: mir('row', 'row-reverse'),
            alignItems: 'center',
            gap: '4px',
            flexShrink: 0,
          }}
        >
          <Jog view={view} id={id} accent={accent} size={jogSize} />
          <DeckTempo
            deck={deck}
            id={id}
            accent={accent}
            isMaster={masterDeck === id}
            height={faderH}
            onSync={() => {
              // BPM-nya TIDAK dikirim dari sini lagi. Dulu begitu, dan yang
              // terkirim adalah BPM *base* master alih-alih yang efektif —
              // lihat kepala `sync-ops.ts`.
              const r = toggleSyncFor(id);
              if (!r.ok) djActions.setNotice(r.reason ?? 'SYNC gagal');
            }}
          />
        </div>
      </div>
    </div>
  );
}

