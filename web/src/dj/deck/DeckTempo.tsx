/**
 * Kolom tempo: fader tegak, pemilih rentang, MASTER TEMPO, SYNC, MASTER.
 *
 * Dua hal yang meniru perangkat keras dan bukan selera:
 *
 *  1. **Mengganti rentang TIDAK menggerakkan fader.** Yang berubah adalah arti
 *     posisi yang sama. Itu ditegakkan di store (`setTempoRange`), dan di sini
 *     hanya perlu tidak merusaknya.
 *  2. **Reset tempo = klik-ganda pada angka persen**, bukan tombol terpisah.
 *     Itu gerakan yang dipakai rekordbox.
 *
 * Tombol MT (MASTER TEMPO / key lock) MATI, dengan alasannya di `title`. Lihat
 * `KEY_LOCK_AVAILABLE` di `model.ts`: menyalakan tombol yang tidak melakukan
 * apa-apa adalah bentuk kebohongan yang paling mahal di perkakas audio.
 */

import { Button } from '../../ui/cyber';
import { Fader } from '../mixer/Fader';
import {
  KEY_LOCK_AVAILABLE,
  KEY_LOCK_REASON,
  TEMPO_RANGES,
  formatTempoPct,
  type DeckId,
  type DeckState,
  type TempoRange,
} from '../model';
import { djActions } from '../store';

/**
 * Besar pitch bend saat ditahan, sebagai pengali.
 *
 * 4% kira-kira sebesar dorongan jari di piringan CDJ: cukup untuk menutup
 * selisih beberapa milidetik dalam satu-dua ketukan, terlalu kecil untuk
 * terdengar sebagai perubahan nada.
 */
const BEND = 0.04;

export interface DeckTempoProps {
  readonly deck: DeckState;
  readonly id: DeckId;
  readonly accent: string;
  readonly isMaster: boolean;
  readonly height: number;
  readonly onSync: () => void;
}

export function DeckTempo({
  deck,
  id,
  accent,
  isMaster,
  height,
  onSync,
}: DeckTempoProps): JSX.Element {
  const pct = deck.tempo.fader * deck.tempo.rangePct;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '6px',
        padding: '0 6px',
      }}
    >
      {/*
        PITCH BEND — menahan mempercepat/memperlambat SEMENTARA, melepas
        mengembalikannya. Ini yang dipakai untuk menggeser lagu beberapa
        milidetik supaya ketukannya bertemu, tanpa mengubah tempo lagu itu.
        Karena itu ia menulis ke `deck.bend`, BUKAN ke tempo fader: kalau ia
        menulis ke fader, satu nudge akan mengubah BPM lagu secara permanen.
      */}
      <div style={{ display: 'flex', gap: '3px' }}>
        {([-1, 1] as const).map((dir) => {
          const empty = deck.assetId === null;
          // Menyala hanya di ARAH yang sedang ditahan, bukan di keduanya.
          const active = dir === 1 ? deck.bend > 1 : deck.bend < 1;
          return (
            <button
              key={dir}
              type="button"
              className="cy-btn-reset"
              disabled={empty}
              onPointerDown={() => djActions.setBend(id, dir === 1 ? 1 + BEND : 1 - BEND)}
              onPointerUp={() => djActions.setBend(id, 1)}
              // Melepas di luar tombol tetap harus mengembalikan laju; kalau
              // tidak, deck tertinggal ngebut sampai tombolnya ditekan lagi.
              onPointerLeave={() => djActions.setBend(id, 1)}
              title={
                dir === 1
                  ? 'pitch bend maju — tahan untuk mempercepat SEMENTARA, tanpa mengubah tempo lagu'
                  : 'pitch bend mundur — tahan untuk memperlambat SEMENTARA'
              }
              style={{
                flex: 1,
                fontSize: '9px',
                padding: '2px 0',
                fontFamily: 'var(--cy-font-mono)',
                color: active ? 'var(--cy-text-on-accent)' : 'var(--cy-text-dim)',
                background: active ? accent : 'var(--cy-surface-2)',
                border: '1px solid var(--cy-border)',
                cursor: empty ? 'not-allowed' : 'pointer',
                opacity: empty ? 0.4 : 1,
              }}
            >
              {dir === 1 ? '▶▶' : '◀◀'}
            </button>
          );
        })}
      </div>

      <div
        onDoubleClick={() => djActions.resetTempo(id)}
        title="klik-ganda untuk mengembalikan tempo ke 0.0%"
        style={{
          fontSize: '12px',
          fontVariantNumeric: 'tabular-nums',
          color: pct === 0 ? 'var(--cy-text-dim)' : accent,
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        {formatTempoPct(pct, deck.tempo.rangePct)}
      </div>

      <Fader
        orientation="vertical"
        value={(deck.tempo.fader + 1) / 2}
        onChange={(v) => djActions.setTempoFader(id, v * 2 - 1)}
        length={height}
        thickness={24}
        accent={accent}
        detent={0.5}
        label={`tempo deck ${id}`}
        title="tempo fader — klik-ganda pada angka persen untuk reset"
      />

      <button
        type="button"
        className="cy-btn-reset"
        onClick={() => {
          const i = TEMPO_RANGES.indexOf(deck.tempo.rangePct);
          const next = TEMPO_RANGES[(i + 1) % TEMPO_RANGES.length] as TempoRange;
          djActions.setTempoRange(id, next);
        }}
        title="rentang tempo — WIDE adalah ±100%, dan di −100% lagu berhenti"
        style={{
          fontSize: '9px',
          letterSpacing: '.14em',
          color: 'var(--cy-accent)',
          border: '1px solid var(--cy-border-strong)',
          padding: '2px 6px',
          fontFamily: 'var(--cy-font-mono)',
          cursor: 'pointer',
        }}
      >
        {deck.tempo.rangePct === 100 ? 'WIDE' : `±${deck.tempo.rangePct}`}
      </button>

      <Button
        size="sm"
        variant="ghost"
        disabled={!KEY_LOCK_AVAILABLE}
        title={KEY_LOCK_REASON}
        style={{ height: '22px', padding: '0 8px', fontSize: '9px', width: '100%' }}
      >
        MT
      </Button>

      <Button
        size="sm"
        variant={deck.sync === 'follower' ? 'solid' : 'ghost'}
        onClick={onSync}
        title={
          deck.sync === 'follower'
            ? 'matikan SYNC — tempo fader TETAP di tempatnya, karena mematikan SYNC berarti mengambil alih tempo yang sudah selaras'
            : 'SYNC menyamakan TEMPO saja — penyelarasan fase/downbeat belum ada'
        }
        style={{ height: '22px', padding: '0 6px', fontSize: '9px', width: '100%' }}
      >
        SYNC
      </Button>

      <Button
        size="sm"
        variant={isMaster ? 'solid' : 'ghost'}
        onClick={() => djActions.setMasterDeck(isMaster ? null : id)}
        title="jadikan deck ini acuan tempo"
        style={{ height: '22px', padding: '0 6px', fontSize: '9px', width: '100%' }}
      >
        MASTER
      </Button>
    </div>
  );
}
