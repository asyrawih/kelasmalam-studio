/**
 * Baris info deck: judul, BPM asli & efektif, key, waktu berjalan & sisa.
 *
 * Tiga hal yang TIDAK boleh dipoles di sini, karena semuanya adalah janji:
 *
 *  - BPM yang belum selesai dianalisis menulis `ANALISIS…`, bukan angka lama;
 *  - BPM yang keyakinannya rendah DITANDAI, bukan disembunyikan dan bukan
 *    ditampilkan polos (aturan `docs/10`, ambang `TEMPO_UNCERTAIN`);
 *  - **KEY selalu `—`**, karena `crates/analysis` belum punya deteksi nada
 *    dasar sama sekali. Menebaknya diam-diam adalah bentuk kebohongan yang
 *    paling sulit dilacak: angkanya terlihat benar sampai seseorang memakainya
 *    untuk memilih lagu berikutnya.
 */

import { studioActions } from '../../studio/store';
import { formatDeckTime, formatTempoPct, type DeckId } from '../model';
import { djActions, useDj } from '../store';
import { toggleGridEditFor } from '../grid/grid-ops';
import type { DeckView } from '../deck-view';

export interface DeckReadoutProps {
  readonly view: DeckView;
  readonly id: DeckId;
  readonly accent: string;
  readonly mirrored: boolean;
}

function OctaveButton({
  label,
  assetId,
  delta,
  disabled,
}: {
  readonly label: string;
  readonly assetId: number | null;
  readonly delta: 1 | -1;
  readonly disabled: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      className="cy-btn-reset"
      disabled={disabled || assetId === null}
      onClick={() => {
        if (assetId !== null) studioActions.shiftAssetTempoOctave(assetId, delta);
      }}
      title={`${label} BPM — koreksi oktaf tempo, tersimpan pada lagunya`}
      style={{
        fontSize: '9px',
        padding: '0 3px',
        fontFamily: 'var(--cy-font-mono)',
        color: 'var(--cy-text-dim)',
        border: '1px solid var(--cy-border)',
        background: 'transparent',
        cursor: disabled || assetId === null ? 'not-allowed' : 'pointer',
        opacity: disabled || assetId === null ? 0.4 : 1,
      }}
    >
      {label}
    </button>
  );
}

const CELL: React.CSSProperties = {
  fontSize: '10px',
  letterSpacing: '.14em',
  color: 'var(--cy-text-muted)',
};

export function DeckReadout({ view, id, accent, mirrored }: DeckReadoutProps): JSX.Element {
  const { deck, effBpm, baseBpm, tempoPct, analyzing, bpmUncertain, missing } = view;
  const loaded = deck.assetId !== null;
  const gridOn = useDj((s) => s.gridEdit.deck === id);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: mirrored ? 'row-reverse' : 'row',
        alignItems: 'center',
        gap: '12px',
        padding: '6px 10px',
        borderBottom: '1px solid var(--cy-border)',
        background: 'var(--cy-surface-1)',
        minWidth: 0,
      }}
    >
      <span
        style={{
          fontFamily: 'var(--cy-font-sans)',
          fontSize: '18px',
          fontWeight: 700,
          color: accent,
          width: '18px',
          textAlign: 'center',
          flexShrink: 0,
        }}
      >
        {id}
      </span>

      {/*
        EJECT. Tanpa ini deck bisa diisi tapi tidak pernah dikosongkan — dan
        satu-satunya cara "melepas" lagu adalah memuat lagu lain, yang bukan hal
        yang sama. Cue TIDAK ikut hilang: ia milik asset, jadi memuat lagu itu
        lagi mengembalikan seluruh hot cue-nya.
      */}
      <button
        type="button"
        className="cy-btn-reset"
        disabled={!loaded}
        onClick={() => djActions.ejectDeck(id)}
        title="keluarkan lagu dari deck — hot cue-nya TETAP tersimpan pada lagunya"
        style={{
          fontSize: '9px',
          padding: '2px 5px',
          fontFamily: 'var(--cy-font-mono)',
          color: 'var(--cy-text-muted)',
          border: '1px solid var(--cy-border)',
          background: 'transparent',
          cursor: loaded ? 'pointer' : 'not-allowed',
          opacity: loaded ? 1 : 0.35,
          flexShrink: 0,
        }}
      >
        ⏏
      </button>

      <div style={{ minWidth: 0, flex: 1, textAlign: mirrored ? 'right' : 'left' }}>
        <div
          style={{
            fontSize: '12px',
            color: missing ? '#ff4d4d' : loaded ? 'var(--cy-text)' : 'var(--cy-text-muted)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
          title={deck.name}
        >
          {missing ? 'ASSET HILANG' : loaded ? deck.name.toUpperCase() : 'DECK KOSONG'}
        </div>
        <div style={CELL}>
          {loaded ? `${formatDeckTime(view.positionSec)} · −${formatDeckTime(view.remainingSec)}` : '—'}
        </div>
      </div>

      {/*
        GRID EDIT dinyalakan DARI SINI, bersebelahan dengan angka BPM, dan bukan
        dari panelnya sendiri — panel itu baru ada setelah modenya menyala.
        Tempatnya di sebelah BPM karena itulah angka yang salah saat seseorang
        merasa perlu membuka grid edit.
      */}
      <button
        type="button"
        className="cy-btn-reset"
        disabled={!loaded}
        onClick={() => toggleGridEditFor(id)}
        title="GRID EDIT — rapikan beat grid lagu ini"
        style={{
          fontSize: '9px',
          padding: '2px 5px',
          fontFamily: 'var(--cy-font-mono)',
          letterSpacing: '.12em',
          color: gridOn ? accent : 'var(--cy-text-muted)',
          border: `1px solid ${gridOn ? accent : 'var(--cy-border)'}`,
          background: 'transparent',
          cursor: loaded ? 'pointer' : 'not-allowed',
          opacity: loaded ? 1 : 0.35,
          flexShrink: 0,
        }}
      >
        GRID
      </button>

      <div style={{ textAlign: 'center', flexShrink: 0 }}>
        <div style={CELL}>KEY</div>
        <div
          style={{ fontSize: '13px', color: 'var(--cy-text-muted)' }}
          title="deteksi nada dasar belum ada di crates/analysis — lihat recordbox/00-plan.md, Utang 1"
        >
          —
        </div>
      </div>

      <div style={{ textAlign: 'center', flexShrink: 0, minWidth: '110px' }}>
        <div style={{ ...CELL, display: 'flex', gap: '3px', justifyContent: 'center' }}>
          {/*
            ×2 / ÷2 ada di setiap perkakas DJ karena OKTAF TEMPO memang tidak
            selalu bisa diputuskan mesin: lagu 170 BPM dengan backbeat sama
            sahnya didengar sebagai 85. Koreksinya milik ASSET (`tempoOctave`),
            bukan deck — kalau tidak, memuat lagu yang sama di deck lain akan
            menampilkan angka yang berbeda.
          */}
          <OctaveButton
            label="÷2"
            assetId={deck.assetId}
            delta={-1}
            disabled={baseBpm === null}
          />
          <span>BPM</span>
          <OctaveButton
            label="×2"
            assetId={deck.assetId}
            delta={1}
            disabled={baseBpm === null}
          />
        </div>
        <div
          style={{
            fontSize: '18px',
            fontVariantNumeric: 'tabular-nums',
            color: effBpm === null ? 'var(--cy-text-muted)' : accent,
          }}
          title={
            baseBpm === null
              ? undefined
              : `materi ${baseBpm.toFixed(2)} BPM · fader ${formatTempoPct(tempoPct, deck.tempo.rangePct)}`
          }
        >
          {analyzing ? 'ANALISIS…' : effBpm === null ? '—' : effBpm.toFixed(1)}
          {bpmUncertain && effBpm !== null ? (
            <span style={{ color: '#ffb020', fontSize: '11px' }} title="keyakinan deteksi rendah">
              {' '}
              ?
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
