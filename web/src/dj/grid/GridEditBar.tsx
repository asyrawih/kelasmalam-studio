/**
 * Panel GRID EDIT — baris 4, menggantikan Beat FX selama mode grid menyala.
 *
 * ## Kenapa menggantikan, bukan menambah baris
 *
 * `DjLayout` adalah grid 100vh lima baris yang TIDAK menggulir, dan band
 * `compact` sudah kehabisan ruang. Baris keenam berarti mencuri tinggi dari
 * pad dan jog — dua hal yang di `DjLayout.tsx` sudah dinyatakan tidak boleh
 * menyusut karena keduanya sasaran sentuh.
 *
 * Tapi alasan sebenarnya bukan tata letak: menyetel grid adalah **pekerjaan
 * persiapan**, bukan pertunjukan. Tidak ada orang yang memutar Beat FX sambil
 * menaruh downbeat. Menyediakan keduanya sekaligus menghabiskan tinggi untuk
 * kombinasi yang tidak pernah dipakai.
 *
 * ## Panel ini TIDAK menyimpan grid
 *
 * Semua tombol memanggil `grid-ops.ts`, yang menulis ke `studioStore`. Tidak
 * ada salinan grid di `djStore` — aturan `deck-view.ts`: *kalau sebuah nilai
 * bisa berubah dari luar deck, turunkan, jangan simpan.* Konsekuensinya yang
 * bisa dilihat: grid yang disunting di sini langsung benar di `/studio` tanpa
 * satu baris sinkronisasi, dan sebaliknya.
 *
 * Satu-satunya keadaan lokal di berkas ini adalah TEKS yang sedang diketik di
 * kotak BPM, dan itu memang harus lokal: mengirim tiap penekanan tombol ke
 * store berarti mengetik "1" pada 128 sempat menetapkan grid ke 1 BPM.
 */

import { useEffect, useState } from 'react';

import { Button } from '../../ui/cyber';
import { MAX_GRID_BPM, MIN_GRID_BPM } from '../../studio/analysis/beat-grid';
import { MIN_FIT_BARS, barsBetween, currentBpm, rawAnchorSec } from '../../studio/analysis/grid-edit';
import { useStudio } from '../../studio/store';
import { DECK_ACCENT, GRID_ZOOMS, METRO_LEVELS, type GridZoom } from '../model';
import { djActions, useDj } from '../store';
import { useGridHistoryVersion } from './grid-history';
import {
  autoGrid,
  fitGridHere,
  gridBlockedReason,
  gridHistoryState,
  nudgeGrid,
  octaveGrid,
  redoGridEdit,
  setDownbeatHere,
  setGridBpm,
  tapGrid,
  toggleGridLock,
  undoGridEdit,
  widenGrid,
} from './grid-ops';

const LABEL: React.CSSProperties = {
  fontSize: '10px',
  letterSpacing: '.16em',
  color: 'var(--cy-text-dim)',
};

/** `112.418` → `01:52.418`. Anchor pantas dibaca sampai milidetik: itu satuan
 *  kerjanya, dan `formatClock` yang membulatkan ke detik menyembunyikannya. */
function formatAnchor(sec: number): string {
  const sign = sec < 0 ? '-' : '';
  const abs = Math.abs(sec);
  const m = Math.floor(abs / 60);
  const s = abs - m * 60;
  return `${sign}${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}

export function GridEditBar(): JSX.Element {
  const deckId = useDj((s) => s.gridEdit.deck);
  const zoomBars = useDj((s) => s.gridEdit.zoomBars);
  const fine = useDj((s) => s.gridEdit.fine);
  const metroLevel = useDj((s) => s.gridEdit.metroLevel);
  const deck = useDj((s) => (s.gridEdit.deck === null ? null : s.decks[s.gridEdit.deck]));
  const assets = useStudio((s) => s.assets);
  // Riwayat hidup di luar React (lihat `grid-history.ts`); ini yang membuat
  // tombol UNDO/REDO ikut redup pada saat yang tepat.
  useGridHistoryVersion();

  const assetId = deck?.assetId ?? null;
  const asset = assetId === null ? undefined : assets[assetId];
  const bpm = currentBpm(asset);
  const anchorSec = rawAnchorSec(asset);
  const sr = deck !== null && deck.sampleRate > 0 ? deck.sampleRate : 48_000;
  const atSec = deck === null ? 0 : deck.playhead / sr;
  const blocked = gridBlockedReason(deckId);
  const locked = asset?.analysisLock === true;
  const { canUndo, canRedo } = gridHistoryState(assetId);

  const [draft, setDraft] = useState('');
  // Kotak BPM mengikuti grid yang berlaku SELAMA user tidak sedang mengetik di
  // dalamnya. Tanpa ini, menekan ×2 tidak terlihat di kotak, dan user mengetik
  // ulang angka yang sebenarnya sudah benar.
  useEffect(() => {
    setDraft(bpm === null ? '' : bpm.toFixed(3));
  }, [bpm, assetId]);

  const bars = bpm === null ? 0 : Math.abs(barsBetween(anchorSec, bpm, atSec));
  const fitReady = bars >= MIN_FIT_BARS;
  const off = blocked !== null;

  return (
    <div
      data-grid-edit
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 10px',
        background: 'var(--cy-surface-1)',
        minWidth: 0,
        overflowX: 'auto',
      }}
    >
      <span style={{ ...LABEL, color: deckId === null ? 'var(--cy-text-dim)' : DECK_ACCENT[deckId] }}>
        GRID {deckId ?? '—'}
      </span>

      {blocked !== null ? (
        <span style={{ ...LABEL, color: 'var(--cy-text-dim)' }}>{blocked.toUpperCase()}</span>
      ) : null}

      {/* — spasi grid, dinyatakan sebagai BPM (kontrol #2) — */}
      <input
        aria-label="BPM grid"
        value={draft}
        disabled={off}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const n = Number(draft);
          if (Number.isFinite(n) && n > 0) setGridBpm(n);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setDraft(bpm === null ? '' : bpm.toFixed(3));
        }}
        inputMode="decimal"
        title={`BPM grid (${MIN_GRID_BPM}–${MAX_GRID_BPM}). Tiga angka di belakang koma memang perlu: 0.01 BPM saja sudah menggeser grid melewati transien dalam enam menit.`}
        style={{
          width: '84px',
          background: 'var(--cy-surface-2)',
          color: 'var(--cy-accent)',
          border: '1px solid var(--cy-border-strong)',
          fontFamily: 'var(--cy-font-mono)',
          fontSize: '11px',
          padding: '3px 6px',
          textAlign: 'right',
        }}
      />

      {/* — renggangkan / rapatkan (kontrol #5) — */}
      <Button
        variant="ghost"
        disabled={off}
        onClick={() => widenGrid(-1)}
        title={`rapatkan jarak ketukan ${fine ? '3' : '1'} ms — grid yang tertinggal di belakang transien`}
      >
        −
      </Button>
      <Button
        variant="ghost"
        disabled={off}
        onClick={() => widenGrid(1)}
        title={`renggangkan jarak ketukan ${fine ? '3' : '1'} ms — grid yang mendahului transien`}
      >
        +
      </Button>

      <Button variant="ghost" disabled={off} onClick={() => octaveGrid(1)} title="×2 BPM">
        ×2
      </Button>
      <Button variant="ghost" disabled={off} onClick={() => octaveGrid(-1)} title="÷2 BPM">
        ÷2
      </Button>
      <Button
        variant="outline"
        disabled={off}
        onClick={() => tapGrid(performance.now())}
        title="ketuk mengikuti lagu — empat kali atau lebih"
      >
        TAP
      </Button>

      <Sep />

      {/* — anchor (kontrol #1 dan #4) — */}
      <span style={LABEL}>ANCHOR</span>
      <span style={{ fontSize: '11px', color: 'var(--cy-text)', minWidth: '68px' }}>
        {formatAnchor(anchorSec)}
      </span>
      <Button
        variant="ghost"
        disabled={off}
        onClick={() => nudgeGrid(-1)}
        title={`geser seluruh grid ${fine ? '0.1' : '1'} ms ke kiri`}
      >
        ◀
      </Button>
      <Button
        variant="ghost"
        disabled={off}
        onClick={() => nudgeGrid(1)}
        title={`geser seluruh grid ${fine ? '0.1' : '1'} ms ke kanan`}
      >
        ▶
      </Button>
      <Button
        variant="outline"
        disabled={off}
        onClick={() => setDownbeatHere()}
        title="jadikan posisi sekarang ketukan pertama sebuah bar"
      >
        SET DI SINI
      </Button>

      {/* — kunci-dua-titik: yang membuat grid berhenti merayap — */}
      <Button
        variant={fitReady ? 'solid' : 'ghost'}
        disabled={off}
        onClick={() => fitGridHere()}
        title={
          fitReady
            ? `selesaikan BPM supaya garis bar mendarat persis di sini (${bars.toFixed(1)} bar dari anchor)`
            : `butuh minimal ${MIN_FIT_BARS} bar dari anchor — sekarang ${bars.toFixed(1)}`
        }
      >
        PAS DI SINI · {bars.toFixed(1)}
      </Button>

      <Sep />

      <span style={LABEL}>ZOOM</span>
      {GRID_ZOOMS.map((z: GridZoom) => (
        <Button
          key={z}
          variant="ghost"
          active={zoomBars === z}
          onClick={() => djActions.setGridZoom(z)}
          title={`${z} bar memenuhi layar`}
        >
          {z}
        </Button>
      ))}

      <Button
        variant="ghost"
        active={fine}
        onClick={() => djActions.setGridFine(!fine)}
        title="fine — geser anchor jadi lebih halus (0.1 ms), renggang/rapat jadi lebih kasar (3 ms). Arahnya memang berlawanan: yang satu mengejar fase, yang satu mengejar drift."
      >
        FINE
      </Button>

      <span style={LABEL}>METRO</span>
      {METRO_LEVELS.map((lv) => (
        <Button
          key={lv}
          variant="ghost"
          active={metroLevel === lv}
          onClick={() => djActions.setMetroLevel(lv)}
          title={
            lv === 0
              ? 'metronom mati'
              : `metronom tingkat ${lv} — HANYA ke keluaran CUE, tidak pernah ke master`
          }
        >
          {lv === 0 ? '✕' : '▁▃█'.charAt(lv - 1)}
        </Button>
      ))}

      <Sep />

      <Button variant="ghost" disabled={!canUndo} onClick={() => undoGridEdit()} title="batalkan suntingan grid terakhir">
        UNDO
      </Button>
      <Button variant="ghost" disabled={!canRedo} onClick={() => redoGridEdit()} title="ulangi suntingan yang dibatalkan">
        REDO
      </Button>
      <Button
        variant="ghost"
        disabled={off}
        onClick={() => autoGrid()}
        title="buang SEMUA koreksi manual — BPM, downbeat, dan koreksi oktaf — dan kembali ke hasil deteksi"
      >
        AUTO
      </Button>
      <Button
        variant="ghost"
        active={locked}
        disabled={assetId === null}
        onClick={() => toggleGridLock()}
        title={
          locked
            ? 'terkunci: grid tidak bisa diubah dan lagu ini dilewati analisis'
            : 'kunci grid — mencegah AUTO dan analisis ulang menyentuhnya'
        }
      >
        {locked ? '🔒' : '🔓'}
      </Button>

      <div style={{ flex: 1, minWidth: '4px' }} />

      <Button variant="ghost" onClick={() => djActions.closeGridEdit()} title="tutup GRID EDIT, kembali ke Beat FX">
        TUTUP
      </Button>
    </div>
  );
}

function Sep(): JSX.Element {
  return <span style={{ width: '1px', alignSelf: 'stretch', background: 'var(--cy-border)' }} />;
}
