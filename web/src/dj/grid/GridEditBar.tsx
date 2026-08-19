/**
 * Panel GRID EDIT — bilah kontrol yang duduk TEPAT DI ATAS waveform besar.
 *
 * ## Kenapa di sini, dan bukan lagi popup di dalam deck
 *
 * Yang sedang dikoreksi adalah garis grid, dan garis grid hanya terlihat di
 * waveform besar. Panel yang duduk di deck — setengah layar di bawahnya —
 * memaksa mata bolak-balik antara tombol dan akibatnya untuk tiap 1 ms.
 * rekordbox menaruh bilah ini menempel pada waveform yang disunting, dan
 * alasannya sama.
 *
 * Versi sebelumnya popup melayang di dalam deck karena satu batasan yang kini
 * sudah hilang: dulu menarik waveform besar berarti MENGGESER GRID, jadi
 * satu-satunya cara berpindah posisi adalah strip lagu-penuh di deck, dan panel
 * tidak boleh menutupinya. Sejak tarikan kembali berarti "cari posisi"
 * (`gridEdit.drag`), syarat itu lenyap — dan bersamanya alasan panel ini berada
 * jauh dari barang yang diurusnya.
 *
 * ## Ia MENDORONG, bukan menutupi
 *
 * Bilah ini bagian dari tata letak baris waveform, bukan lapisan di atasnya.
 * Waveform menyusut selama panel terbuka. Overlay akan menutup materi yang
 * justru sedang dibaca user untuk menilai apakah gridnya sudah pas — dan
 * menyembunyikan bukti tepat saat seseorang mencarinya adalah kegagalan yang
 * tidak sebanding dengan beberapa piksel yang dihemat.
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

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import { Button } from '../../ui/cyber';
import { MAX_GRID_BPM, MIN_GRID_BPM, gridSegments } from '../../studio/analysis/beat-grid';
import { MIN_FIT_BARS, barsBetween, currentBpm, rawAnchorSec } from '../../studio/analysis/grid-edit';
import { useStudio } from '../../studio/store';
import { DECK_ACCENT, GRID_ZOOMS, METRO_LEVELS, type DeckId, type GridZoom } from '../model';
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
  removeSegmentHere,
  setDownbeatHere,
  setGridBpm,
  tapGrid,
  toggleGridLock,
  undoGridEdit,
  widenGrid,
} from './grid-ops';

/**
 * Tombol yang MENGULANG selama ditahan.
 *
 * Menggeser grid 12 ms dengan tombol yang hanya bereaksi pada klik berarti dua
 * belas klik, dan mata yang sedang mengejar transien tidak bisa menghitung
 * klik sambil melihat garis. Semua alat yang ditiru halaman ini mengulang saat
 * ditahan; yang tidak mengulang terasa rusak, bukan hemat.
 *
 * Jalur pointer dan jalur klik SENGAJA dipisah dengan `firedByPointer`: tanpa
 * itu satu klik tetikus berjalan dua kali (`pointerdown` lalu `click`), dan
 * langkah 1 ms diam-diam jadi 2 ms. Jalur `click` tetap ada karena ia
 * satu-satunya yang dilewati keyboard — Enter dan Spasi tidak pernah
 * menghasilkan `pointerdown`.
 */
const HOLD_DELAY_MS = 320;
const HOLD_EVERY_MS = 55;

interface HoldButtonProps {
  readonly run: () => void;
  readonly disabled?: boolean;
  readonly title?: string;
  readonly children: ReactNode;
}

function HoldButton({ run, disabled, title, children }: HoldButtonProps): JSX.Element {
  const delayRef = useRef(0);
  const everyRef = useRef(0);
  const firedByPointer = useRef(false);

  const stop = (): void => {
    window.clearTimeout(delayRef.current);
    window.clearInterval(everyRef.current);
    delayRef.current = 0;
    everyRef.current = 0;
  };

  useEffect(() => stop, []);

  return (
    <Button
      variant="ghost"
      disabled={disabled}
      title={title}
      onPointerDown={() => {
        if (disabled === true) return;
        firedByPointer.current = true;
        run();
        stop();
        delayRef.current = window.setTimeout(() => {
          everyRef.current = window.setInterval(run, HOLD_EVERY_MS);
        }, HOLD_DELAY_MS);
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onClick={() => {
        if (firedByPointer.current) {
          firedByPointer.current = false;
          return;
        }
        run();
      }}
    >
      {children}
    </Button>
  );
}

const LABEL: CSSProperties = {
  fontSize: '9px',
  letterSpacing: '.16em',
  color: 'var(--cy-text-dim)',
  flexShrink: 0,
};

/**
 * Batas tinggi bilah, piksel.
 *
 * Ia MENDORONG waveform, jadi tanpa batas ini layar pendek bisa berakhir dengan
 * panel penuh tombol dan waveform setinggi beberapa piksel — yaitu kehilangan
 * satu-satunya benda yang membuat panel ini berguna. Setelah batas tercapai
 * bilahnya menggulir sendiri.
 */
const MAX_BAR_HEIGHT_PX = 132;

/** `112.418` → `01:52.418`. Anchor pantas dibaca sampai milidetik: itu satuan
 *  kerjanya, dan `formatClock` yang membulatkan ke detik menyembunyikannya. */
function formatAnchor(sec: number): string {
  const sign = sec < 0 ? '-' : '';
  const abs = Math.abs(sec);
  const m = Math.floor(abs / 60);
  const s = abs - m * 60;
  return `${sign}${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}

/**
 * Satu KELOMPOK kontrol di dalam bilah.
 *
 * `flexShrink: 0` bukan hiasan: kelompok yang boleh menyusut akan meremas
 * tombol jadi lebih sempit daripada labelnya sebelum bilahnya membungkus, dan
 * yang terlihat adalah deretan tombol yang terpotong, bukan baris kedua.
 */
function Row({
  children,
  push,
}: {
  readonly children: ReactNode;
  readonly push?: boolean;
}): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        flexShrink: 0,
        marginLeft: push === true ? 'auto' : undefined,
      }}
    >
      {children}
    </div>
  );
}

export interface GridEditBarProps {
  /** Deck yang grid-nya sedang disunting. */
  readonly id: DeckId;
}

export function GridEditBar({ id }: GridEditBarProps): JSX.Element | null {
  const open = useDj((s) => s.gridEdit.deck === id);
  const zoomBars = useDj((s) => s.gridEdit.zoomBars);
  const fine = useDj((s) => s.gridEdit.fine);
  const drag = useDj((s) => s.gridEdit.drag);
  const scope = useDj((s) => s.gridEdit.scope);
  const metroLevel = useDj((s) => s.gridEdit.metroLevel);
  const deck = useDj((s) => s.decks[id]);
  const assets = useStudio((s) => s.assets);
  // Riwayat hidup di luar React (lihat `grid-history.ts`); ini yang membuat
  // tombol UNDO/REDO ikut redup pada saat yang tepat.
  useGridHistoryVersion();

  const assetId = deck.assetId;
  const asset = assetId === null ? undefined : assets[assetId];
  const bpm = currentBpm(asset);

  const [draft, setDraft] = useState('');
  // Kotak BPM mengikuti grid yang berlaku SELAMA user tidak sedang mengetik di
  // dalamnya. Tanpa ini, menekan ×2 tidak terlihat di kotak, dan user mengetik
  // ulang angka yang sebenarnya sudah benar.
  useEffect(() => {
    setDraft(bpm === null ? '' : bpm.toFixed(3));
  }, [bpm, assetId]);

  /*
   * Esc menutup panel. TIDAK lewat registry command, pola yang sama dengan
   * overlay di `AppShell.tsx`: ini perilaku dialog, dan mengikatnya ke command
   * berarti user bisa melepasnya lalu terkurung di dalam panel.
   *
   * Kotak BPM dilewati — di sana Esc sudah punya arti sendiri (membatalkan
   * ketikan), dan menutup panel sekaligus membuang keduanya dalam satu tekan.
   */
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      const el = e.target as HTMLElement | null;
      if (el !== null && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
      djActions.closeGridEdit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;

  const anchorSec = rawAnchorSec(asset);
  const sr = deck.sampleRate > 0 ? deck.sampleRate : 48_000;
  const atSec = deck.playhead / sr;
  const blocked = gridBlockedReason(id);
  const locked = asset?.analysisLock === true;
  const { canUndo, canRedo } = gridHistoryState(assetId);
  const bars = bpm === null ? 0 : Math.abs(barsBetween(anchorSec, bpm, atSec));

  /*
   * Ruas mana yang sedang diinjak playhead, dan ada berapa semuanya.
   *
   * Ditampilkan hanya kalau lagunya memang punya ruas tambahan: pada lagu
   * bertempo tetap — hampir semuanya — "RUAS 1/1" adalah kebisingan yang
   * menyiratkan ada sesuatu untuk diurus padahal tidak ada.
   */
  const segs = gridSegments(asset);
  const segIndex = segs.reduce((acc, s, i) => (s.fromSec <= atSec ? i : acc), 0);
  const inSegment = segs.length > 1 && segIndex > 0;
  const fitReady = bars >= MIN_FIT_BARS;
  const off = blocked !== null;
  const accent = DECK_ACCENT[id];

  return (
    <div
      data-grid-edit={id}
      /*
       * `pointerdown` dihentikan di sini supaya klik di dalam panel tidak ikut
       * memicu `onPointerDownCapture` milik `Deck` — bukan karena fokusnya
       * salah (panel ini memang milik deck itu), melainkan supaya tiap klik
       * tombol tidak menghasilkan satu `set` store tambahan.
       */
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        // Kolom, bukan baris tunggal: pada layar sempit kontrolnya membungkus,
        // dan `MAX_BAR_HEIGHT_PX` menjaga waveform tetap punya tempat kalau ia
        // membungkus lebih jauh daripada yang muat.
        gap: '4px 10px',
        maxHeight: `${MAX_BAR_HEIGHT_PX}px`,
        overflowY: 'auto',
        flexShrink: 0,
        padding: '5px 7px',
        background: 'var(--cy-surface-2)',
        borderBottom: `1px solid ${accent}`,
      }}
    >
      <Row>
        <span style={{ ...LABEL, color: accent, fontSize: '10px' }}>GRID · DECK {id}</span>
      </Row>

      {blocked !== null ? (
        <span style={{ ...LABEL, whiteSpace: 'normal' }}>{blocked.toUpperCase()}</span>
      ) : null}

      {/* — spasi grid sebagai BPM (#2), renggang/rapat (#5), oktaf (#6), TAP (#3) — */}
      <Row>
        <span style={LABEL}>BPM</span>
        <input
          aria-label="BPM grid"
          value={draft}
          disabled={off}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            const n = Number(draft);
            if (Number.isFinite(n) && n > 0) setGridBpm(n, id);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') setDraft(bpm === null ? '' : bpm.toFixed(3));
          }}
          inputMode="decimal"
          title={`BPM grid (${MIN_GRID_BPM}–${MAX_GRID_BPM}). Tiga angka di belakang koma memang perlu: 0.01 BPM saja sudah menggeser grid melewati transien dalam enam menit.`}
          style={{
            width: '76px',
            background: 'var(--cy-surface-1)',
            color: 'var(--cy-accent)',
            border: '1px solid var(--cy-border-strong)',
            fontFamily: 'var(--cy-font-mono)',
            fontSize: '11px',
            padding: '3px 5px',
            textAlign: 'right',
          }}
        />
        <HoldButton
          disabled={off}
          run={() => widenGrid(-1, id)}
          title={`rapatkan jarak ketukan ${fine ? '3' : '1'} ms — grid yang tertinggal di belakang transien. Tahan untuk mengulang`}
        >
          −
        </HoldButton>
        <HoldButton
          disabled={off}
          run={() => widenGrid(1, id)}
          title={`renggangkan jarak ketukan ${fine ? '3' : '1'} ms — grid yang mendahului transien. Tahan untuk mengulang`}
        >
          +
        </HoldButton>
        <Button variant="ghost" disabled={off} onClick={() => octaveGrid(1, id)} title="×2 BPM">
          ×2
        </Button>
        <Button variant="ghost" disabled={off} onClick={() => octaveGrid(-1, id)} title="÷2 BPM">
          ÷2
        </Button>
        <Button
          variant="outline"
          disabled={off}
          onClick={() => tapGrid(performance.now(), id)}
          title="ketuk mengikuti lagu — empat kali atau lebih"
        >
          TAP
        </Button>
      </Row>

      {/* — anchor: geser (#4) dan `[fine]` — */}
      <Row>
        <span style={LABEL}>ANCHOR</span>
        <span
          style={{
            fontSize: '11px',
            color: 'var(--cy-text)',
            fontVariantNumeric: 'tabular-nums',
            minWidth: '66px',
          }}
        >
          {formatAnchor(anchorSec)}
        </span>
        <HoldButton
          disabled={off}
          run={() => nudgeGrid(-1, id)}
          title="geser seluruh grid 1 ms ke kiri. Tahan untuk mengulang"
        >
          ◀
        </HoldButton>
        <HoldButton
          disabled={off}
          run={() => nudgeGrid(1, id)}
          title="geser seluruh grid 1 ms ke kanan. Tahan untuk mengulang"
        >
          ▶
        </HoldButton>
        <Button
          variant="ghost"
          active={fine}
          onClick={() => djActions.setGridFine(!fine)}
          title="fine — langkah rapat/renggang jadi 3 ms, persis seperti [fine] rekordbox. Geser anchor tetap 1 ms."
        >
          FINE
        </Button>
      </Row>

      {/* — dua tombol yang paling menentukan (#1 dan kunci-dua-titik) — */}
      <Row>
        <Button
          variant="outline"
          disabled={off}
          onClick={() => setDownbeatHere(id)}
          title="jadikan posisi sekarang ketukan pertama sebuah bar"
        >
          SET DI SINI
        </Button>
        <Button
          variant={fitReady ? 'solid' : 'ghost'}
          disabled={off}
          onClick={() => fitGridHere(id)}
          title={
            fitReady
              ? `selesaikan BPM supaya garis bar mendarat persis di sini (${bars.toFixed(1)} bar dari anchor)`
              : `butuh minimal ${MIN_FIT_BARS} bar dari anchor — sekarang ${bars.toFixed(1)}`
          }
        >
          PAS DI SINI · {bars.toFixed(1)}
        </Button>
      </Row>

      {/* — cakupan suntingan (#7): seluruh lagu vs dari posisi ini — */}
      <Row>
        <span style={LABEL}>CAKUPAN</span>
        <Button
          variant="ghost"
          active={scope === 'track'}
          onClick={() => djActions.setGridScope('track')}
          title="satu tempo untuk SELURUH lagu — [Normal] rekordbox, dan yang benar untuk materi elektronik"
        >
          SELURUH LAGU
        </Button>
        <Button
          variant="ghost"
          active={scope === 'here'}
          onClick={() => djActions.setGridScope('here')}
          title="suntingan berlaku DARI POSISI INI ke belakang, dengan membuat ruas tempo baru — [Dynamic] rekordbox, untuk lagu yang temponya bergeser di tengah jalan"
        >
          DARI SINI
        </Button>
        {segs.length > 1 ? (
          <span
            style={{
              ...LABEL,
              color: 'var(--cy-text)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            RUAS {segIndex + 1}/{segs.length}
          </span>
        ) : null}
        {inSegment ? (
          <Button
            variant="ghost"
            disabled={off}
            onClick={() => removeSegmentHere(id)}
            title="buang ruas ini — bagian lagu ini kembali memakai grid dasar"
          >
            HAPUS RUAS
          </Button>
        ) : null}
      </Row>

      {/* — arti menarik waveform besar — */}
      <Row>
        <span style={LABEL}>TARIK</span>
        <Button
          variant="ghost"
          active={drag === 'seek'}
          onClick={() => djActions.setGridDrag('seek')}
          title="menarik waveform besar mencari posisi — seperti di luar mode grid, dan seperti rekordbox"
        >
          POSISI
        </Button>
        <Button
          variant="ghost"
          active={drag === 'grid'}
          onClick={() => djActions.setGridDrag('grid')}
          title="menarik waveform besar menggeser GRID; playhead diam. Lebih cepat daripada menekan ◀ ▶ puluhan kali, tapi selama menyala tarikan tidak bisa dipakai mencari posisi"
        >
          GRID
        </Button>
      </Row>

      {/* — zoom waveform + metronom (#10) — */}
      <Row>
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
        <span style={{ ...LABEL, marginLeft: '4px' }}>METRO</span>
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
      </Row>

      {/* — riwayat, AUTO, kunci (#9 dan #11) — */}
      <Row>
        <Button
          variant="ghost"
          disabled={!canUndo}
          onClick={() => undoGridEdit(id)}
          title="batalkan suntingan grid terakhir"
        >
          UNDO
        </Button>
        <Button
          variant="ghost"
          disabled={!canRedo}
          onClick={() => redoGridEdit(id)}
          title="ulangi suntingan yang dibatalkan"
        >
          REDO
        </Button>
        <Button
          variant="ghost"
          disabled={off}
          onClick={() => autoGrid(id)}
          title="buang SEMUA koreksi manual — BPM, downbeat, dan koreksi oktaf — dan kembali ke hasil deteksi"
        >
          AUTO
        </Button>
        <Button
          variant="ghost"
          active={locked}
          disabled={assetId === null}
          onClick={() => toggleGridLock(id)}
          title={
            locked
              ? 'terkunci: grid tidak bisa diubah dan lagu ini dilewati analisis'
              : 'kunci grid — mencegah AUTO dan analisis ulang menyentuhnya'
          }
        >
          {locked ? '🔒' : '🔓'}
        </Button>
      </Row>
      <Row push>
        <Button variant="ghost" onClick={() => djActions.closeGridEdit()} title="tutup (Esc)">
          ✕
        </Button>
      </Row>
    </div>
  );
}
