/**
 * BEAT LOOP CUT — grid ketukan di atas waveform clip, region loop yang menempel
 * ke bar, dan pemotongannya.
 *
 * Dipecah jadi HOOK + DUA KOMPONEN, bukan satu komponen besar, karena
 * bagian-bagiannya duduk di tempat yang berbeda di layar: overlay harus berada
 * di dalam kotak waveform (supaya koordinatnya sama persis dengan gelombang
 * yang dilihat user), sedangkan kontrolnya di bawah kotak itu. Menyatukan
 * keduanya berarti `ClipDetailPanel` harus menyerahkan kotak waveform-nya, dan
 * itu menyeret FadeOverlay/FadeHandle ikut pindah.
 *
 * SEMUA POSISI DI SINI SOURCE-SPACE. Grid milik asset (lihat
 * `analysis/beat-grid.ts`), dan kotak waveform Clip Detail memang menampilkan
 * region source `[sourceStart, sourceStart + sourceLen)` — jadi pemetaannya
 * lurus. Konversi ke timeline hanya terjadi di `applyLoopCut`.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

import { Button } from '../../ui/cyber';
import { useCanvasDraw } from '../../ui/lib/canvas';
import {
  MAX_GRID_BPM,
  MIN_GRID_BPM,
  resolveBeatGrid,
  samplesPerBar,
  snapSourceToBeat,
  snapSourceToGrid,
  type BeatGrid,
} from '../analysis/beat-grid';
import { samplesToSec, type Samples, type StudioClip } from '../model';
import { studioActions, useStudio, type StudioAsset } from '../store';
import { MAX_LOOP_REPEAT, clampLoopSpec, type ClampedRegion } from './beat-cut';
import { activeLoopLen } from './clip-loop';
import { drawBeatGrid, drawPlayhead } from './beat-draw';

/**
 * Panjang loop yang ditawarkan, dalam BAR. Bar (bukan detik) karena itulah
 * satuan yang dipakai orang saat menyusun potongan musik.
 *
 * Pecahan ikut karena di bawah satu bar-lah pekerjaan yang menarik terjadi:
 * 1/4 bar = satu ketukan (loop roll), 1/8 bar = not seperdelapan (stutter).
 * Semua perkakas DJ menawarkan rentang yang sama persis, dan alasannya sama.
 */
export const LOOP_BAR_PRESETS = [1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16] as const;
/** Batas bawah panjang loop. Di bawah ini yang terdengar bukan lagi musik. */
export const MIN_LOOP_BARS = 1 / 16;
export const MAX_LOOP_BARS = 64;

/** Panjang loop dalam KETUKAN, untuk tooltip. 4/4 diasumsikan. */
function formatBeats(bars: number): string {
  const beats = bars * 4;
  return beats >= 1 ? `${Math.round(beats * 100) / 100} ketukan` : `${formatBars(beats)} ketukan`;
}

/** `0.25` → `"1/4"`. Tanpa ini tombolnya berbunyi "0.25 BAR". */
export function formatBars(bars: number): string {
  if (!Number.isFinite(bars) || bars <= 0) return '?';
  if (bars >= 1) return String(Math.round(bars * 100) / 100);
  const denom = Math.round(1 / bars);
  return `1/${denom}`;
}

/**
 * "2.6×" — berapa kali putaran itu muat di dalam clip, PECAHAN ikut ditampilkan.
 *
 * Sengaja tidak dibulatkan ke bilangan bulat: putaran terakhir memang hampir
 * selalu terpotong di tengah, dan angka bulat akan menjanjikan sesuatu yang
 * tidak terjadi.
 */
export function loopRepeatsText(sourceLen: Samples, loopLen: Samples): string {
  if (!(loopLen > 0) || !(sourceLen > 0)) return '—';
  return `${Math.round((sourceLen / loopLen) * 10) / 10}×`;
}

/** Nudge offset downbeat. Halus = untuk menyetel terakhir dengan telinga. */
const OFFSET_STEP_SEC = 0.01;
const OFFSET_STEP_FINE_SEC = 0.001;

/**
 * Lebar jendela waveform. `'full'` = seluruh clip (atau region loop) diam;
 * angka = sekian BAR yang bergeser mengikuti playhead.
 *
 * Satuannya bar, bukan detik, karena grid-nya memang sudah ada dan "berapa
 * banyak musik yang terlihat" jauh lebih berguna di sini daripada "berapa
 * detik". Materi tanpa BPM jatuh ke `FALLBACK_WINDOW_SEC`.
 */
export type BeatZoom = 'full' | 1 | 2 | 4 | 8;
export const ZOOM_BAR_PRESETS = [1, 2, 4, 8] as const;
/** Zoom yang dipakai saat play ditekan sementara tampilan masih FULL. */
export const DEFAULT_FOLLOW_BARS = 4;
/** Lebar jendela geser kalau BPM belum ketemu. */
export const FALLBACK_WINDOW_SEC = 8;

/**
 * Langkah tempel saat menaruh loop, dalam ketukan.
 *
 * Aturannya: menempel ke PANJANG LOOP itu sendiri, dibatasi maksimal satu bar.
 * Dengan begitu loop selalu ubin rapi di grid — loop 1/4 bar bisa mendarat di
 * ketukan mana pun, loop 4 bar tetap mendarat di awal bar. Shift memberi
 * langkah yang lebih halus: satu ketukan, atau panjang loop kalau ia memang
 * sudah lebih pendek dari satu ketukan.
 */
function snapStepBeats(grid: BeatGrid, bars: number, fine: boolean): number {
  const loopBeats = Math.max(bars, MIN_LOOP_BARS) * grid.beatsPerBar;
  if (fine) return Math.min(1, loopBeats);
  return Math.min(grid.beatsPerBar, loopBeats);
}

export interface BeatState {
  readonly grid: BeatGrid | null;
  /** Region loop di SOURCE-space, sudah dibatasi ke dalam clip. */
  readonly region: ClampedRegion | null;
  readonly bars: number;
  readonly repeat: number;
  readonly snap: boolean;
  readonly setBars: (n: number) => void;
  readonly setRepeat: (n: number) => void;
  readonly setSnap: (v: boolean) => void;
  /** Pindahkan awal region ke posisi source (akan di-snap). */
  readonly moveTo: (sourceAt: Samples, fine: boolean) => void;
  /** Geser region ± sekian bar, tetap di dalam clip. */
  readonly shiftBars: (delta: number) => void;
  /** Snap sebuah posisi TIMELINE ke grid — dipakai tombol SPLIT. */
  readonly snapTimeline: (at: Samples) => Samples;
  /** true kalau region ini sedang diputar berulang (audisi). */
  readonly looping: boolean;
  /**
   * Tandai bahwa region sedang DITARIK. Selama true, perpindahannya tidak
   * dikirim ke pemutar audisi.
   *
   * Tanpa ini, tiap `pointermove` membangun ulang voice audisi dan yang
   * terdengar hanya deretan klik. Sorotan di layar tetap mengikuti tangan;
   * yang ditahan hanya audionya, sampai jari dilepas.
   */
  readonly setRegionDragging: (v: boolean) => void;
  readonly zoom: BeatZoom;
  readonly setZoom: (z: BeatZoom) => void;
  /** Lebar jendela geser dalam SAMPLE source, atau null kalau zoom FULL. */
  readonly windowLen: Samples | null;
}

/**
 * Semua state beat untuk satu clip. Sengaja LOKAL komponen, tidak masuk store:
 * region loop adalah pilihan sementara sebelum menekan tombol, bukan bagian
 * dari karya. Yang benar-benar milik project — BPM dan offset yang dikoreksi —
 * memang sudah disimpan di asset.
 */
export function useBeatState(
  clip: StudioClip | undefined,
  asset: StudioAsset | undefined,
  sampleRate: number,
  speedRatio: number,
): BeatState {
  const grid = useMemo(() => resolveBeatGrid(asset), [asset]);
  const clipLoop = useStudio((s) => s.clipLoop);
  const playing = useStudio((s) => s.playing);
  const [bars, setBars] = useState<number>(4);
  const [repeat, setRepeat] = useState<number>(1);
  const [snap, setSnap] = useState<boolean>(true);
  const [start, setStart] = useState<Samples | null>(null);
  const [zoom, setZoom] = useState<BeatZoom>('full');
  const [regionDragging, setRegionDragging] = useState(false);

  // Ganti clip = region lama tidak lagi punya arti. Direset ke null (= otomatis
  // dari awal clip), bukan dipertahankan: memakai ulang posisi dari clip lain
  // membuat sorotan muncul di tempat yang tidak pernah dipilih user di sini.
  const clipId = clip?.id;
  useEffect(() => {
    setStart(null);
  }, [clipId]);

  const region = useMemo<ClampedRegion | null>(() => {
    if (clip === undefined || grid === null) return null;
    const barLen = samplesPerBar(grid, sampleRate);
    if (!Number.isFinite(barLen) || barLen <= 0) return null;
    const clipEnd = clip.sourceStart + clip.sourceLen;
    // Default: bar pertama yang jatuh DI DALAM clip. `Math.ceil` lewat snap ke
    // bar terdekat bisa mendarat sebelum awal clip, dan region yang mulai
    // sebelum materinya akan memutar bagian yang tidak terlihat di layar.
    let from = start ?? snapSourceToBeat(clip.sourceStart, grid, sampleRate, 'bar');
    if (from < clip.sourceStart) from += barLen * Math.ceil((clip.sourceStart - from) / barLen);
    const wanted = Math.round(barLen * bars);
    const at = Math.min(from, Math.max(clip.sourceStart, clipEnd - 1));
    return clampLoopSpec({
      sourceStart: at,
      sourceLen: Math.min(wanted, clipEnd - at),
      repeat,
      assetFrames: clipEnd,
    });
  }, [clip, grid, sampleRate, start, bars, repeat]);

  const looping = clipLoop !== null && clip !== undefined && clipLoop.clipId === clip.id;

  /**
   * Menekan PLAY saat tampilan masih FULL memindahkannya ke jendela geser.
   *
   * Ini SATU-SATUNYA keajaiban di modul ini, dan disengaja: yang dicari orang
   * saat menekan play adalah waveform yang bergerak, bukan gambar diam dengan
   * garis melintas. Perubahannya terlihat (tombol zoom ikut menyala) dan bisa
   * dibatalkan dengan satu klik ke FULL — setelah itu ia tidak akan memaksa
   * lagi selama sesi zoom yang sama, karena hanya transisi berhenti→main yang
   * memicunya, bukan keadaan "sedang main".
   */
  const wasSounding = useRef(false);
  useEffect(() => {
    // LOOP PLAY ikut memicunya, bukan hanya transport: keduanya sama-sama
    // "sesuatu mulai berbunyi di panel ini".
    const sounding = playing || looping;
    const started = sounding && !wasSounding.current;
    wasSounding.current = sounding;
    if (started) setZoom((z) => (z === 'full' ? DEFAULT_FOLLOW_BARS : z));
  }, [playing, looping]);

  const windowLen = useMemo<Samples | null>(() => {
    if (zoom === 'full') return null;
    if (grid === null) return Math.round(FALLBACK_WINDOW_SEC * sampleRate);
    return Math.max(1, Math.round(samplesPerBar(grid, sampleRate) * zoom));
  }, [zoom, grid, sampleRate]);

  // Region LOKAL adalah sumber kebenaran; `clipLoop` di store hanya cerminan
  // "sedang berbunyi + region yang mana". Efek ini yang membuat mengubah
  // panjang bar atau menggeser region SAAT audisi berjalan langsung terdengar,
  // tanpa perlu menekan LOOP PLAY lagi.
  const liveStart = looping ? clipLoop.sourceStart : null;
  const liveLen = looping ? clipLoop.sourceLen : null;
  useEffect(() => {
    if (!looping || region === null || regionDragging) return;
    if (region.sourceStart === liveStart && region.sourceLen === liveLen) return;
    studioActions.moveClipLoop(region.sourceStart, region.sourceLen);
  }, [looping, region, liveStart, liveLen, regionDragging]);

  return {
    grid,
    region,
    bars,
    repeat,
    snap,
    looping,
    setRegionDragging,
    zoom,
    setZoom,
    windowLen,
    // TIDAK dibulatkan ke bilangan bulat lagi — itu yang dulu membuat semua
    // pecahan runtuh jadi 1 bar.
    setBars: (n) =>
      setBars(Math.max(MIN_LOOP_BARS, Math.min(MAX_LOOP_BARS, Number.isFinite(n) ? n : 1))),
    setRepeat: (n) => setRepeat(Math.max(1, Math.min(MAX_LOOP_REPEAT, Math.round(n)))),
    setSnap,
    moveTo: (at, fine) => {
      if (grid === null) return;
      setStart(snapSourceToGrid(at, grid, sampleRate, snapStepBeats(grid, bars, fine)));
    },
    shiftBars: (delta) => {
      if (grid === null || region === null || clip === undefined) return;
      // Digeser sepanjang REGION-nya sendiri, bukan sebar penuh: untuk loop
      // 1/4 bar, melompat satu bar berarti melewati tiga posisi yang justru
      // ingin dicoba. "Loop berikutnya" adalah gerakan yang sebenarnya dicari.
      const at = region.sourceStart + delta * region.sourceLen;
      const last = clip.sourceStart + clip.sourceLen - region.sourceLen;
      setStart(Math.max(clip.sourceStart, Math.min(last, Math.round(at))));
    },
    snapTimeline: (at) => {
      if (grid === null || clip === undefined) return at;
      // TIMELINE → SOURCE → snap → kembali. Dua konversi, dengan ratio yang
      // sama dengan `splitClipAtPlayhead` — grid hidup di source, playhead di
      // timeline, dan menyamakan keduanya diam-diam adalah cara paling mudah
      // membuat snap meleset di lane yang di-speed-up.
      const src = clip.sourceStart + (at - clip.start) * speedRatio;
      const snapped = snapSourceToBeat(src, grid, sampleRate, 'beat');
      return Math.round(clip.start + (snapped - clip.sourceStart) / speedRatio);
    },
  };
}

/**
 * Garis grid + sorotan region loop. Dua-duanya di satu canvas: keduanya
 * digambar ulang oleh dependency yang sama, dan canvas kedua hanya menambah
 * satu lapisan compositing tanpa memberi apa pun.
 */
export function BeatOverlay({
  grid,
  region,
  sourceStart,
  sourceLen,
  sampleRate,
  playheadSource = null,
}: {
  readonly grid: BeatGrid | null;
  readonly region: ClampedRegion | null;
  readonly sourceStart: Samples;
  readonly sourceLen: Samples;
  readonly sampleRate: number;
  /**
   * Posisi playhead di SOURCE-space, atau null kalau tidak sedang di dalam
   * jendela ini. Digambar di canvas INI dan bukan bersama waveform: waveform
   * mahal dan hanya perlu digambar ulang saat materinya berubah, sedangkan
   * garis ini bergerak 16×/detik.
   */
  readonly playheadSource?: Samples | null;
}): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  useCanvasDraw(
    ref,
    (ctx, size) => {
      const { width: w, height: h } = size;
      if (sourceLen <= 0) return;
      if (grid !== null) {
        drawBeatGrid(ctx, {
          grid,
          sampleRate,
          from: sourceStart,
          len: sourceLen,
          width: w,
          height: h,
          region,
        });
      }
      // Playhead digambar walau grid belum ada — posisi yang sedang berbunyi
      // tidak bergantung pada ketemunya BPM.
      if (playheadSource !== null) {
        drawPlayhead(ctx, playheadSource, sourceStart, sourceLen, w, h);
      }
    },
    [grid, region, sourceStart, sourceLen, sampleRate, playheadSource],
  );
  return (
    <canvas
      ref={ref}
      data-beat-overlay
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
      }}
    />
  );
}

/**
 * Lapisan penangkap pointer untuk memindahkan region loop.
 *
 * Terpisah dari canvas karena canvas-nya `pointerEvents: none` (ia harus
 * membiarkan handle fade di atasnya tetap bisa diklik). Lapisan ini duduk di
 * bawah handle fade (`zIndex` lebih kecil) sehingga tidak pernah merebut drag
 * yang dimaksudkan untuk fade.
 */
export function LoopRegionPicker({
  enabled,
  onPick,
}: {
  readonly enabled: boolean;
  readonly onPick: (frac: number, fine: boolean) => void;
}): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<number | null>(null);
  if (!enabled) return null;

  const pick = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const rect = ref.current?.getBoundingClientRect();
    if (rect === undefined || rect.width <= 0) return;
    onPick((e.clientX - rect.left) / rect.width, e.shiftKey);
  };

  return (
    <div
      ref={ref}
      data-loop-picker
      title="klik/tarik untuk menaruh awal loop · tahan Shift untuk menempel ke ketukan, bukan bar"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        drag.current = e.pointerId;
        try {
          ref.current?.setPointerCapture(e.pointerId);
        } catch {
          // jsdom / browser lama — klik tunggal tetap bekerja.
        }
        pick(e);
      }}
      onPointerMove={(e) => {
        if (drag.current !== e.pointerId) return;
        pick(e);
      }}
      onPointerUp={(e) => {
        if (drag.current !== e.pointerId) return;
        drag.current = null;
        if (ref.current?.hasPointerCapture?.(e.pointerId) === true) {
          ref.current.releasePointerCapture(e.pointerId);
        }
      }}
      style={{
        position: 'absolute',
        inset: 0,
        cursor: 'crosshair',
        touchAction: 'none',
        zIndex: 1,
      }}
    />
  );
}

/** Input angka kecil; diterapkan saat blur/Enter, bukan tiap ketikan. */
function NumField({
  label,
  value,
  suffix,
  width = 54,
  onCommit,
}: {
  readonly label: string;
  readonly value: number | null;
  readonly suffix?: string;
  readonly width?: number;
  readonly onCommit: (n: number | null) => void;
}): JSX.Element {
  const shown = value === null ? '' : String(Math.round(value * 100) / 100);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
      <input
        aria-label={label}
        value={text}
        inputMode="decimal"
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const n = Number.parseFloat(text);
          onCommit(Number.isFinite(n) ? n : null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        style={{
          width: `${width}px`,
          height: '24px',
          background: '#000',
          border: '1px solid var(--cy-border)',
          color: 'var(--cy-text)',
          fontFamily: 'var(--cy-font-mono)',
          fontSize: '11px',
          padding: '0 6px',
          outline: 'none',
          textAlign: 'right',
        }}
      />
      {suffix === undefined ? null : (
        <span style={{ fontSize: '9px', color: 'var(--cy-text-muted)' }}>{suffix}</span>
      )}
    </label>
  );
}

const ROW: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  flexWrap: 'wrap',
};

/**
 * Satu KELOMPOK kontrol, disusun mendatar bersebelahan.
 *
 * Susunan sebelumnya empat baris penuh-lebar dengan label 62 px di kiri dan
 * pembacaan angka didorong ke ujung kanan pakai `marginLeft: auto`. Di layar
 * lebar itu berarti tiap baris punya lubang kosong ratusan piksel di tengah, dan
 * mata harus melintasinya untuk menghubungkan tombol dengan angkanya. Empat
 * baris juga membuat bar sticky ini tinggi — padahal ia menempel di atas dan
 * memakan ruang timeline terus-menerus.
 *
 * Sekarang tiga kelompok bersebelahan, masing-masing dengan angkanya SENDIRI di
 * bawahnya. `flex-wrap` + `flex-basis` membuatnya turun jadi dua lajur lalu satu
 * lajur di layar sempit, tanpa satu pun media query.
 */
function Group({
  label,
  basis,
  min,
  first = false,
  children,
}: {
  readonly label: string;
  readonly basis: number;
  readonly min: number;
  readonly first?: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div
      data-beat-group={label}
      style={{
        flex: `1 1 ${basis}px`,
        minWidth: `${min}px`,
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        // Pemisah, bukan kotak: garis tipis sudah cukup untuk memisahkan
        // kelompok tanpa menambah empat border baru ke bar yang sudah padat.
        borderLeft: first ? 'none' : '1px solid var(--cy-border)',
        paddingLeft: first ? 0 : '14px',
      }}
    >
      <span style={{ fontSize: '9px', letterSpacing: '.18em', color: 'var(--cy-text-muted)' }}>
        {label}
      </span>
      {children}
    </div>
  );
}

/** Pembacaan angka/keterangan milik kelompoknya, tepat di bawah kontrolnya. */
function Caption({
  children,
  accent = false,
}: {
  readonly children: ReactNode;
  readonly accent?: boolean;
}): JSX.Element {
  return (
    <span style={{ fontSize: '10px', color: accent ? '#6ee7ff' : 'var(--cy-text-dim)' }}>
      {children}
    </span>
  );
}

/** Kontrol grid + loop cut, dipasang di bawah kotak waveform. */
export type BeatGroupId = 'grid' | 'view' | 'loop' | 'cut';
const ALL_GROUPS: readonly BeatGroupId[] = ['grid', 'view', 'loop', 'cut'];

export function BeatControls({
  beat,
  clip,
  asset,
  sampleRate,
  onCut,
  groups = ALL_GROUPS,
}: {
  readonly beat: BeatState;
  readonly clip: StudioClip;
  readonly asset: StudioAsset | undefined;
  readonly sampleRate: number;
  readonly onCut: (note: string) => void;
  /**
   * Kelompok mana yang dirender. Ada karena kontrol ini sekarang tersebar di
   * beberapa popup menu — GRID di menu BEAT, sisanya di menu LOOP — tapi
   * semuanya tetap satu komponen: dua salinan berarti tombol yang sama bisa
   * berperilaku beda tergantung dari mana ia dibuka.
   */
  readonly groups?: readonly BeatGroupId[];
}): JSX.Element {
  const show = (id: BeatGroupId): boolean => groups.includes(id);
  let firstDrawn = false;
  /** Kelompok PERTAMA yang benar-benar digambar tidak diberi garis pemisah. */
  const isFirst = (): boolean => {
    if (firstDrawn) return false;
    firstDrawn = true;
    return true;
  };
  const { grid, region } = beat;
  const assetId = asset?.id;

  const nudgeOffset = (deltaSec: number): void => {
    if (assetId === undefined || grid === null) return;
    studioActions.setAssetBeatGrid(assetId, { offsetSec: grid.offsetSec + deltaSec });
  };

  /** Panjang putaran yang SUDAH terpasang di clip ini, atau null. */
  const clipLoopLen = activeLoopLen(clip);
  const regionSec = region === null ? 0 : samplesToSec(region.sourceLen, sampleRate);
  const regionAtSec =
    region === null ? 0 : samplesToSec(region.sourceStart - clip.sourceStart, sampleRate);

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '14px', flexWrap: 'wrap' }}>
      {!show('grid') ? null : (
      <Group label="GRID" basis={310} min={300} first={isFirst()}>
        {assetId === undefined ? (
          <Caption>clip ini belum punya audio</Caption>
        ) : (
          <>
            <div style={ROW}>
              <NumField
                label="BPM"
                value={grid?.bpm ?? null}
                suffix="BPM"
                onCommit={(n) =>
                  studioActions.setAssetBeatGrid(assetId, {
                    bpm: n === null ? null : Math.min(MAX_GRID_BPM, Math.max(MIN_GRID_BPM, n)),
                  })
                }
              />
              <Button
                size="sm"
                variant="ghost"
                title="anggap dua kali lebih cepat"
                onClick={() => studioActions.shiftAssetTempoOctave(assetId, 1)}
                style={{ padding: '0 8px' }}
              >
                ×2
              </Button>
              <Button
                size="sm"
                variant="ghost"
                title="anggap dua kali lebih lambat"
                onClick={() => studioActions.shiftAssetTempoOctave(assetId, -1)}
                style={{ padding: '0 8px' }}
              >
                ÷2
              </Button>
              <Button
                size="sm"
                variant={grid?.manual === true ? 'outline' : 'ghost'}
                disabled={grid?.manual !== true}
                title="buang koreksi manual, kembali ke hasil deteksi"
                onClick={() => studioActions.resetAssetBeatGrid(assetId)}
                style={{ padding: '0 8px' }}
              >
                AUTO
              </Button>
            </div>
            <div style={ROW}>
              <span
                style={{ fontSize: '9px', letterSpacing: '.12em', color: 'var(--cy-text-muted)' }}
              >
                DOWNBEAT
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={grid === null}
                title="geser grid ke kiri (Shift = 1 ms)"
                onClick={(e) => nudgeOffset(-(e.shiftKey ? OFFSET_STEP_FINE_SEC : OFFSET_STEP_SEC))}
                style={{ padding: '0 8px' }}
              >
                ◀
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={grid === null}
                title="geser grid ke kanan (Shift = 1 ms)"
                onClick={(e) => nudgeOffset(e.shiftKey ? OFFSET_STEP_FINE_SEC : OFFSET_STEP_SEC)}
                style={{ padding: '0 8px' }}
              >
                ▶
              </Button>
            </div>
            <Caption>
              {grid === null
                ? asset?.tempoPending === true
                  ? 'menganalisis tempo…'
                  : 'BPM belum terdeteksi — ketik sendiri untuk memakai grid'
                : grid.manual
                  ? 'grid manual'
                  : 'grid dari deteksi'}
            </Caption>
          </>
        )}
      </Group>
      )}

      {!show('view') ? null : (
      <Group label="VIEW" basis={230} min={215} first={isFirst()}>
        <div style={ROW}>
          <Button
            size="sm"
            variant={beat.zoom === 'full' ? 'outline' : 'ghost'}
            title="tampilkan seluruh clip, diam"
            onClick={() => beat.setZoom('full')}
            style={{ padding: '0 10px' }}
          >
            FULL
          </Button>
          {/* Label angka saja, TANPA kata "BAR" — kelompok LOOP di sebelah sudah
              punya tombol "1 BAR"…"16 BAR", dan dua deret yang terbaca sama
              persis membuat mata (dan tangan) memilih deret yang salah. */}
          {ZOOM_BAR_PRESETS.map((n) => (
            <Button
              key={n}
              size="sm"
              variant={beat.zoom === n ? 'outline' : 'ghost'}
              title={`jendela ${n} bar yang bergeser mengikuti playhead`}
              onClick={() => beat.setZoom(n)}
              style={{ padding: '0 10px' }}
            >
              {n}
            </Button>
          ))}
        </div>
        <Caption>
          {beat.zoom === 'full'
            ? 'bar terlihat — FULL: waveform diam'
            : grid === null
              ? `tanpa BPM — jendela ${FALLBACK_WINDOW_SEC} detik`
              : 'bar terlihat — tarik waveform untuk menaruh loop'}
        </Caption>
        <Caption>
          {beat.windowLen === null
            ? 'jendela: seluruh clip'
            : `jendela ${samplesToSec(beat.windowLen, sampleRate).toFixed(2)} s`}
        </Caption>
      </Group>
      )}

      {!show('loop') ? null : (
      <Group label="LOOP" basis={520} min={480} first={isFirst()}>
        <div style={ROW}>
          {LOOP_BAR_PRESETS.map((n) => (
            <Button
              key={n}
              size="sm"
              variant={Math.abs(beat.bars - n) < 1e-6 ? 'outline' : 'ghost'}
              disabled={grid === null}
              title={
                n < 1
                  ? `${formatBars(n)} bar = ${formatBeats(n)} — untuk roll dan stutter`
                  : `${formatBars(n)} bar`
              }
              onClick={() => beat.setBars(n)}
              style={{ padding: '0 8px' }}
            >
              {formatBars(n)} BAR
            </Button>
          ))}
        </div>
        <div style={ROW}>
          <Button
            size="sm"
            variant="ghost"
            disabled={grid === null || region === null}
            title="loop sebelumnya — geser sepanjang region itu sendiri"
            onClick={() => beat.shiftBars(-1)}
            style={{ padding: '0 8px' }}
          >
            ◀
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={grid === null || region === null}
            title="loop berikutnya — geser sepanjang region itu sendiri"
            onClick={() => beat.shiftBars(1)}
            style={{ padding: '0 8px' }}
          >
            ▶
          </Button>
          <Button
            size="sm"
            variant={beat.looping ? 'solid' : 'outline'}
            disabled={grid === null || region === null}
            title={
              beat.looping
                ? 'berhenti mengulang'
                : 'putar HANYA region ini, berulang — mute/solo lane diabaikan selama audisi'
            }
            onClick={() => {
              if (beat.looping) {
                studioActions.stopClipLoop();
                return;
              }
              if (region === null) return;
              studioActions.startClipLoop(clip.id, region.sourceStart, region.sourceLen);
            }}
          >
            {beat.looping ? 'STOP LOOP' : 'LOOP PLAY'}
          </Button>
          {/* PASANG KE CLIP — jawaban untuk "kenapa harus dipotong dulu".
              Bertetangga dengan LOOP PLAY dan bukan dengan LOOP CUT karena
              keduanya tidak merusak apa pun: yang satu memutar region, yang
              satu menyuruh clip memutarnya terus. LOOP CUT ada di kelompok CUT
              bersama hal-hal yang benar-benar mengubah susunan timeline. */}
          <Button
            size="sm"
            variant={clipLoopLen !== null ? 'solid' : 'outline'}
            disabled={clipLoopLen === null && (grid === null || region === null)}
            title={
              clipLoopLen !== null
                ? 'lepaskan loop — clip kembali diputar lurus'
                : 'pasang region ini ke clip: diulang sepanjang clip, tanpa memotong dan tanpa menambah clip baru'
            }
            onClick={() => {
              if (clipLoopLen !== null) {
                studioActions.removeClipLoopRegion(clip.id);
                onCut('loop dilepas — clip diputar lurus lagi');
                return;
              }
              if (region === null) return;
              studioActions.setClipLoopRegion(clip.id, {
                sourceStart: region.sourceStart,
                sourceLen: region.sourceLen,
              });
              onCut(
                `loop ${formatBars(beat.bars)} bar dipasang ke clip — ${loopRepeatsText(
                  clip.sourceLen,
                  region.sourceLen,
                )} sepanjang clip`,
              );
            }}
          >
            {clipLoopLen !== null ? 'LEPAS LOOP' : 'LOOP CLIP'}
          </Button>
        </div>
        <Caption accent={beat.looping || clipLoopLen !== null}>
          {clipLoopLen !== null
            ? `clip mengulang ${samplesToSec(clipLoopLen, sampleRate).toFixed(2)} s · ` +
              `${loopRepeatsText(clip.sourceLen, clipLoopLen)} sepanjang clip`
            : region === null
              ? '—'
              : beat.looping
                ? `mengulang ${formatBars(beat.bars)} bar · ${regionSec.toFixed(2)} s`
                : `region ${regionAtSec.toFixed(2)} s → ${(regionAtSec + regionSec).toFixed(2)} s`}
        </Caption>
      </Group>
      )}

      {/* Kelompok terakhir sengaja dipisah dari LOOP: yang di sebelah kiri
          MENDENGARKAN, yang di sini MENGUBAH clip. Dulu keduanya berdesakan di
          satu baris dan LOOP CUT terdorong ke ujung — terlalu dekat dengan
          tombol yang cuma memutar, padahal ia merusak. */}
      {!show('cut') ? null : (
      <Group label="CUT" basis={260} min={250} first={isFirst()}>
        <div style={ROW}>
          <span style={{ fontSize: '9px', letterSpacing: '.12em', color: 'var(--cy-text-muted)' }}>
            ULANG
          </span>
          <NumField
            label="Jumlah pengulangan"
            value={beat.repeat}
            width={44}
            suffix="×"
            onCommit={(n) => beat.setRepeat(n ?? 1)}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={grid === null || region === null}
            title={
              grid === null
                ? 'butuh BPM — deteksi belum selesai atau tidak ketemu'
                : 'potong clip jadi region loop, lalu ulangi'
            }
            onClick={() => {
              if (region === null) return;
              studioActions.beatLoopCut(clip.id, {
                sourceStart: region.sourceStart,
                sourceLen: region.sourceLen,
                repeat: region.repeat,
                assetFrames: asset?.frames,
              });
              onCut(
                `loop ${formatBars(beat.bars)} bar × ${region.repeat} — ${(regionSec * region.repeat).toFixed(1)} s`,
              );
            }}
          >
            LOOP CUT
          </Button>
        </div>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '5px',
            fontSize: '10px',
            color: 'var(--cy-text-dim)',
          }}
        >
          <input
            type="checkbox"
            checked={beat.snap}
            disabled={grid === null}
            onChange={(e) => beat.setSnap(e.target.checked)}
            style={{ accentColor: '#ffd400' }}
          />
          SNAP SPLIT
        </label>
        <Caption>{region === null ? '—' : `hasil: ${(regionSec * region.repeat).toFixed(2)} s`}</Caption>
      </Group>
      )}
    </div>
  );
}
