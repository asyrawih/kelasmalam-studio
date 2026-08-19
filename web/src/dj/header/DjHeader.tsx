/**
 * Baris judul. Bentuknya mengikuti `studio/shell/StudioHeader.tsx`, termasuk
 * satu hal yang paling penting untuk ditiru: **badge status tidak pernah
 * berbohong.**
 *
 * Tiga keadaan, dan ketiganya berbeda artinya:
 *
 *  - `SENTUH UNTUK MENYALAKAN` — lapisan audio ada tapi belum dibangun.
 *    `AudioContext` yang dibuat di luar handler gestur user lahir `suspended`
 *    di Safari dan Chrome, tanpa gejala selain "tidak ada suara", jadi ia
 *    sengaja menunggu interaksi pertama.
 *  - `READY` — benar-benar berbunyi.
 *  - pesan galat — lingkungannya tidak punya Web Audio, dan itu dikatakan
 *    apa adanya alih-alih ditampilkan sebagai "belum siap".
 */

import { chordFor, chordLabel } from '../../app-shell';
import { Badge, Button } from '../../ui/cyber';
import { QUANTIZE_DIVS, DECK_ACCENT, type QuantizeDiv } from '../model';
import { djActions, djStore, useDj } from '../store';
import { deckView } from '../deck-view';
import { studioStore } from '../../studio/store';

export interface DjHeaderProps {
  readonly onClose?: () => void;
  readonly tooNarrow: boolean;
  readonly tooShort: boolean;
}

/** `⌘K PERINTAH`, atau hanya labelnya kalau binding-nya sudah dilepas user. */
function shortcutHint(commandId: string, label: string): string {
  const chord = chordFor(commandId);
  return chord === null ? label : `${chordLabel(chord)} ${label}`;
}

export function DjHeader({ onClose, tooNarrow, tooShort }: DjHeaderProps): JSX.Element {
  const audioReady = useDj((s) => s.audioReady);
  const audioError = useDj((s) => s.audioError);
  const masterDeck = useDj((s) => s.masterDeck);
  const quantizeDiv = useDj((s) => s.quantizeDiv);

  // BPM master dibaca sebagai snapshot: ia hanya berubah saat lagu/tempo master
  // berubah, dan melanggankan header ke seluruh state deck berarti header ikut
  // render 16×/detik selama lagu berjalan.
  const masterBpm =
    masterDeck === null
      ? null
      : (() => {
          const d = djStore.getState().decks[masterDeck];
          if (d.assetId === null) return null;
          return deckView(d, studioStore.getState().assets[d.assetId]).effBpm;
        })();

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '14px',
        padding: '8px 16px',
        background: 'var(--cy-surface-1)',
        flexShrink: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
        <span
          style={{
            fontFamily: 'var(--cy-font-sans)',
            fontSize: '18px',
            fontWeight: 700,
            letterSpacing: '.06em',
          }}
        >
          KELAS MALAM DJ
        </span>
        <span style={{ fontSize: '10px', letterSpacing: '.16em', color: 'var(--cy-accent)' }}>
          // PERFORMANCE
        </span>
      </div>

      <div style={{ height: '18px', width: '1px', background: 'var(--cy-border)' }} />

      <div style={{ fontSize: '10px', color: 'var(--cy-text-dim)', letterSpacing: '.1em' }}>
        MASTER{' '}
        <span style={{ color: masterDeck === null ? 'var(--cy-text-muted)' : DECK_ACCENT[masterDeck] }}>
          {masterDeck === null ? '—' : masterDeck}
        </span>
        {masterBpm === null ? '' : ` · ${masterBpm.toFixed(1)} BPM`}
        {' · QUANTIZE '}
        <select
          value={quantizeDiv}
          aria-label="pembagian quantize"
          onChange={(e) => djActions.setQuantizeDiv(e.target.value as QuantizeDiv)}
          title="pembagian quantize, berlaku untuk KEDUA deck. rekordbox satu langkah lebih halus dari CDJ: 1/16 tersedia, default 1 ketukan"
          style={{
            background: 'var(--cy-surface-2)',
            color: 'var(--cy-accent)',
            border: '1px solid var(--cy-border)',
            fontFamily: 'var(--cy-font-mono)',
            fontSize: '10px',
            padding: '1px 3px',
          }}
        >
          {QUANTIZE_DIVS.map((d) => (
            <option key={d} value={d}>
              {d.toUpperCase()}
            </option>
          ))}
        </select>
      </div>

      {/*
        Petunjuk pintasan. Shortcut yang tidak bisa ditemukan sama saja tidak
        ada — dan satu-satunya yang perlu dihafal adalah pintu ke daftarnya.
        Labelnya dibaca dari keymap yang BERLAKU, jadi ia ikut berubah kalau
        user mengubah binding-nya.
      */}
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span style={{ fontSize: '9px', color: 'var(--cy-text-muted)', letterSpacing: '.08em' }}>
          {shortcutHint('shell.keymap', 'PINTASAN')} · {shortcutHint('shell.palette', 'PERINTAH')}
        </span>
        {tooShort ? (
          <Badge tone="warning">TINGGI LAYAR &lt; 560px — SEBAGIAN KONTROL TIDAK MUAT</Badge>
        ) : null}
        {tooNarrow ? <Badge tone="warning">LAYAR SEMPIT</Badge> : null}
        <Badge
          tone={audioError !== null ? 'danger' : audioReady ? 'success' : 'warning'}
          dot
          title={audioError ?? undefined}
        >
          {audioError !== null
            ? `AUDIO GAGAL: ${audioError}`
            : audioReady
              ? 'READY'
              : 'AUDIO BELUM BERBUNYI — SENTUH HALAMAN'}
        </Badge>
        <Button size="sm" variant="ghost" onClick={onClose}>
          ✕ TUTUP
        </Button>
      </div>
    </div>
  );
}
