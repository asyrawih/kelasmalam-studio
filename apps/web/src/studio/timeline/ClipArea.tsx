/**
 * Area clip yang menggulir: satu baris per lane dengan grid
 * `repeating-linear-gradient` 8.333% (= 12 kolom, sama dengan design), clip
 * diposisikan absolut dalam persen terhadap durasi, dan garis playhead putih.
 *
 * Semua interaksi memakai POINTER EVENT + `setPointerCapture`, bukan listener
 * window seperti di design: tidak ada listener yang bocor kalau komponen
 * ter-unmount di tengah drag, dan drag tetap benar saat kursor keluar elemen.
 *
 * Pointer capture sengaja dipasang di ELEMEN SCROLLER, bukan di elemen clip:
 * saat clip pindah lane, elemen clip-nya ter-remount (key-nya berpindah induk)
 * dan capture-nya akan hilang di tengah drag. Scroller tidak pernah remount.
 */

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { isAudible, laneHeightPx, type StudioClip, type StudioLane } from '../model';
import { studioActions, studioStore, useStudio, type ClipOrigin, type StudioAsset } from '../store';
import { runFileImport, runUrlImport } from './lane-import';
import { registerLaneLocator } from './library-drop';
import { LaneImportOverlay } from './LaneImportOverlay';
import { activeLoopLen } from './clip-loop';
import { BAND_COLORS, drawClipWave, drawLoopedClipWave } from './waveform';
import { visibleWindow, type WaveWindow } from './wave-window';
import { fadeOverlayGradient } from './fade';
import { useCanvasDraw } from '../../ui/lib/canvas';
import { arrangementGridLines, drawArrangementBeatGrid } from './arrangement-beat-grid';
import { clearTimelineCursor, setTimelineCursor } from './timeline-cursor';
import { snapClipMove } from './clip-snap';
import { useAudioFilePicker } from '../../platform/useAudioFilePicker';
import { useNativeFileDrop } from '../../platform/useNativeFileDrop';

export interface ClipAreaProps {
  readonly scrollerRef: RefObject<HTMLDivElement>;
  readonly trackWidth: string;
  readonly onScroll: () => void;
  /** Memberi tahu parent bahwa user sedang men-drag (mematikan auto-follow). */
  readonly onDraggingChange: (dragging: boolean) => void;
  readonly onImportError: (message: string) => void;
  /**
   * Double-click pada sebuah clip. Opsional: `ClipArea` tetap berguna tanpa
   * pemilik dialog (tes memakainya begitu), dan clip-nya sudah terpilih
   * sebelum panggilan ini — pemanggil hanya perlu memutuskan MENAMPILKAN apa.
   */
  readonly onOpenDetail?: (clipId: string) => void;
}

/** Lebar overlay fade dalam persen lebar clip; dibatasi setengah clip. */
function fadePct(fadeMs: number, clipLen: number, sampleRate: number): number {
  if (clipLen <= 0) return 0;
  const fadeSamples = (fadeMs / 1000) * sampleRate;
  return Math.max(0, Math.min(50, (fadeSamples / clipLen) * 100));
}

/** Drag clip (pindah waktu + lane) atau drag timeline (pan). */
type Gesture =
  | {
      readonly kind: 'clip';
      readonly pointerId: number;
      readonly x0: number;
      readonly y0: number;
      /**
       * Posisi SEMUA clip terpilih saat pointer turun. Selisih dihitung
       * terhadap ini, bukan terhadap posisi sekarang — lihat `moveClips`.
       */
      readonly origins: readonly ClipOrigin[];
      readonly samplesPerPx: number;
    }
  | {
      readonly kind: 'pan';
      readonly pointerId: number;
      readonly x0: number;
      readonly scrollLeft0: number;
    }
  | {
      readonly kind: 'trim';
      readonly pointerId: number;
      readonly clipId: string;
      readonly edge: 'left' | 'right';
      readonly samplesPerPx: number;
      /** Posisi track (px) tempat pointer turun — supaya tepi tidak melompat. */
      readonly grabOffset: number;
    }
  | {
      readonly kind: 'slip';
      readonly pointerId: number;
      readonly clipId: string;
      readonly x0: number;
      /** `sourceStart` saat tarikan dimulai. Lihat `slipClip`. */
      readonly sourceStart0: number;
      readonly samplesPerPx: number;
      readonly speedRatio: number;
    }
  | {
      readonly kind: 'marquee';
      readonly pointerId: number;
      /** Titik jangkar dalam koordinat TRACK (bukan layar) — lihat catatan. */
      readonly x0: number;
      readonly y0: number;
      /** Seleksi sebelum kotak dimulai; dipertahankan saat Shift/Ctrl ditahan. */
      readonly base: readonly string[];
      /**
       * Lane KOSONG tempat pointer turun, atau null.
       *
       * Disimpan saat pointer TURUN, bukan dicari lagi saat dilepas: begitu
       * import pertama selesai lane-nya tidak kosong lagi, dan mencari ulang
       * di akhir akan membuat perilaku ketukan bergantung pada apa yang
       * kebetulan sudah mendarat di sana.
       */
      readonly emptyLaneId: string | null;
      /** Posisi ketukan dalam sample; jadi titik mulai clip kalau picker dibuka. */
      readonly atSamples: number;
    };

/**
 * Ambang double-click: dua ketukan pada clip yang SAMA, dalam jendela waktu ini
 * dan nyaris tanpa perpindahan.
 *
 * 400 ms mengikuti ambang yang lazim dipakai sistem operasi. Batas geraknya ada
 * karena tangan selalu bergeser sedikit di antara dua ketukan cepat; tanpa
 * toleransi itu double-click gagal justru bagi orang yang mengetuk paling
 * cepat.
 */
const DOUBLE_TAP_MS = 400;
const DOUBLE_TAP_PX = 6;

/**
 * Batas gerak sebuah KETUKAN pada lane kosong (px, koordinat track).
 *
 * Ketukan itulah yang membuka file manager. Ambangnya ada supaya gerakan yang
 * SEBENARNYA kotak seleksi tidak ikut membuka dialog: menarik kotak melewati
 * lane kosong adalah hal biasa, dan dialog yang muncul setelahnya akan
 * membatalkan seleksi yang baru saja dibuat. Nilainya sama dengan toleransi
 * double-click — dua-duanya menjawab pertanyaan yang sama, "apakah tangan ini
 * diam?".
 */
const TAP_PX = DOUBLE_TAP_PX;

/** Kotak seleksi dalam koordinat track, siap digambar. */
interface MarqueeBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Jendela yang sedang terlihat, dalam koordinat TRACK (px).
 *
 * `track === 0` berarti BELUM TERUKUR — elemen belum di-layout, atau kita
 * sedang di jsdom yang tidak punya layout sama sekali. Pemakainya harus
 * membacanya sebagai "gambar lebar penuh", bukan sebagai "tidak ada yang
 * terlihat": jendela yang dihitung dari nol akan menyembunyikan seluruh
 * waveform, dan di tes itu terlihat seperti waveform yang hilang.
 */
interface TrackView {
  /** `scrollLeft` scroller. */
  readonly left: number;
  /** Lebar viewport yang terlihat. */
  readonly width: number;
  /** Lebar penuh track. */
  readonly track: number;
}

const UNMEASURED: TrackView = { left: 0, width: 0, track: 0 };

/**
 * Ukur viewport, dan ukur ulang saat scroll atau ukuran berubah.
 *
 * Pengukuran dikoalesir ke satu `requestAnimationFrame`: event `scroll` bisa
 * datang lebih rapat dari satu frame, dan tiap `setState` di sini me-render
 * ulang seluruh pohon clip. Satu pengukuran per frame adalah batas atas yang
 * memang dibutuhkan — jendelanya sendiri sudah dikuantisasi, jadi sebagian
 * besar frame tidak mengubah apa pun dan `setState` mengembalikan objek lama.
 */
function useTrackView(
  scrollerRef: RefObject<HTMLDivElement>,
  trackRef: RefObject<HTMLDivElement>,
): TrackView {
  const [view, setView] = useState<TrackView>(UNMEASURED);

  useEffect(() => {
    const scroller = scrollerRef.current;
    const track = trackRef.current;
    if (scroller === null || track === null) return;

    let frame = 0;
    const measure = (): void => {
      frame = 0;
      const next: TrackView = {
        left: scroller.scrollLeft,
        width: scroller.clientWidth,
        track: track.getBoundingClientRect().width,
      };
      // Identitas dipertahankan kalau tidak ada yang berubah, supaya guliran di
      // dalam satu kuantum tidak menghasilkan render sama sekali.
      setView((cur) =>
        cur.left === next.left && cur.width === next.width && cur.track === next.track ? cur : next,
      );
    };
    const schedule = (): void => {
      if (frame !== 0) return;
      // Lingkungan tanpa rAF (jsdom lama) mengukur langsung — lebih baik satu
      // pengukuran sinkron daripada tidak pernah mengukur sama sekali.
      if (typeof requestAnimationFrame !== 'function') {
        measure();
        return;
      }
      frame = requestAnimationFrame(measure);
    };

    measure();
    scroller.addEventListener('scroll', schedule, { passive: true });
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(schedule);
      ro.observe(track);
      ro.observe(scroller);
    }
    return () => {
      if (frame !== 0 && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
      scroller.removeEventListener('scroll', schedule);
      ro?.disconnect();
    };
  }, [scrollerRef, trackRef]);

  return view;
}

/** Jarak pembungkus waveform dari tepi clip (`inset` di `ClipView`), px. */
const WAVE_INSET = 2;

/**
 * Waveform clip di canvas.
 *
 * CANVAS-NYA TIDAK SELEBAR CLIP. Dulu begitu — `width: 100%` dari sebuah clip
 * yang sendirinya diposisikan dalam persen terhadap track — dan itu berarti
 * lagu 27 menit pada zoom 400 px/detik meminta canvas selebar 648.000 px,
 * jauh melewati batas dimensi canvas browser. Sekarang lebarnya mengikuti
 * `win` (lihat `wave-window.ts`): hanya irisan yang terlihat, dipasang pada
 * `left: win.x`. `fullWidth` tetap dikirim ke penggambar supaya pemetaan
 * sample→pixel dihitung terhadap clip UTUH — kalau tidak, waveform akan
 * meregang mengikuti jendela setiap kali user menggulir.
 *
 * Komponen ini hanya dipasang setelah track terukur. Itu penting: fallback
 * canvas selebar clip pada render pertama bisa membekukan main thread sebelum
 * efek pengukuran sempat berjalan (10 menit pada zoom tinggi sudah puluhan
 * ribu piksel). `win` karena itu selalu merupakan irisan yang dibatasi
 * viewport, bukan sinyal untuk menggambar clip penuh.
 */
function ClipWave({
  asset,
  sourceStart,
  sourceLen,
  loopLen,
  sampleRate,
  color,
  style,
  win,
  fullWidth,
}: {
  asset: StudioAsset | undefined;
  sourceStart: number;
  sourceLen: number;
  /** Panjang putaran (SOURCE) kalau clip ini loop; null = diputar lurus. */
  loopLen: number | null;
  sampleRate: number;
  color: string;
  style: CSSProperties;
  /** Irisan yang punya canvas; null = gambar lebar penuh. */
  win: WaveWindow | null;
  /** Lebar penuh area waveform clip, px. Hanya dipakai kalau `win` ada. */
  fullWidth: number;
}): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  useCanvasDraw(
    ref,
    (ctx, size) => {
      const width = win === null ? size.width : fullWidth;
      const wave = {
        outline: color,
        body: color,
        // Opacity lama (0.5) dipertahankan untuk outline; badan RMS sedikit
        // lebih pekat supaya terbaca sebagai isi, bukan sebagai warna kedua.
        outlineAlpha: 0.5,
        bodyAlpha: 0.85,
        centerLine: null,
        bands: BAND_COLORS,
      };
      // Clip yang loop menggambar PUTARANNYA, diulang — bukan materi sepanjang
      // `sourceLen`, yang sebagian besarnya tidak pernah berbunyi.
      if (loopLen !== null) {
        drawLoopedClipWave(
          ctx,
          asset,
          sourceStart,
          sourceLen,
          loopLen,
          width,
          size.height,
          size.dpr,
          wave,
          win,
        );
      } else {
        drawClipWave(ctx, asset, sourceStart, sourceLen, width, size.height, size.dpr, wave, win);
      }
      const lines = arrangementGridLines(
        asset,
        sourceStart,
        sourceLen,
        loopLen,
        sampleRate,
        width,
        win,
      );
      drawArrangementBeatGrid(ctx, lines, size.width, size.height);
    },
    // Jendela masuk sebagai dua angka, bukan sebagai objek: `visibleWindow`
    // membuat objek baru tiap render, jadi identitasnya tidak pernah sama dan
    // canvas akan menggambar ulang tiap frame guliran walau isinya sama.
    [asset, sourceStart, sourceLen, loopLen, sampleRate, color, win?.x ?? -1, win?.w ?? -1, fullWidth],
  );
  // Canvas dibungkus div, dan ukurannya dipaksa 100% — JANGAN mengandalkan
  // `left`/`right` untuk meregangkannya.
  //
  // Canvas adalah *replaced element*: dengan `position:absolute`, `left`+`right`
  // terisi, dan `width:auto`, elemen biasa akan melar mengisi ruang, tapi
  // replaced element memakai RASIO INTRINSIKNYA. Rasio default canvas 300×150,
  // jadi dengan `height:20px` lebarnya jadi 2×20 = 40px — waveform mengecil
  // jadi bercak kecil di kiri, berapa pun lebar clip-nya.
  return (
    <div style={style}>
      <canvas
        ref={ref}
        style={
          win === null
            ? { display: 'block', width: '100%', height: '100%' }
            : {
                display: 'block',
                position: 'absolute',
                left: `${win.x}px`,
                top: 0,
                width: `${win.w}px`,
                height: '100%',
              }
        }
      />
    </div>
  );
}

function ClipView({
  clip,
  lane,
  selected,
  primary,
  asset,
  duration,
  sampleRate,
  view,
  onPointerDown,
  onTrimDown,
}: {
  clip: StudioClip;
  lane: StudioLane;
  selected: boolean;
  /** Clip yang ditampilkan Clip Detail. Ditandai lebih kuat dari sekadar terpilih. */
  primary: boolean;
  asset: StudioAsset | undefined;
  duration: number;
  sampleRate: number;
  view: TrackView;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>, clip: StudioClip) => void;
  onTrimDown: (
    e: ReactPointerEvent<HTMLDivElement>,
    clip: StudioClip,
    edge: 'left' | 'right',
  ) => void;
}): JSX.Element {
  const span = duration > 0 ? duration : 1;
  const left = (clip.start / span) * 100;
  const width = Math.max(0.2, (clip.len / span) * 100);

  // Jendela gambar dihitung dalam PX — persen tidak cukup, karena canvas
  // dipasang dengan posisi dan lebar px. `track === 0` = belum terukur; di
  // situ kita kembali ke perilaku lama (lebar penuh) daripada menebak.
  const measured = view.track > 0 && view.width > 0;
  const win = measured
    ? visibleWindow(
        (left / 100) * view.track + WAVE_INSET,
        (width / 100) * view.track - 2 * WAVE_INSET,
        view.left,
        view.width,
      )
    : null;
  // Jangan memasang canvas sebelum ukuran track tersedia. Render awal terjadi
  // sebelum `useTrackView` sempat mengukur DOM; memakai lebar penuh pada saat
  // itu membuat clip panjang mengalokasikan backing store raksasa dan dapat
  // menghentikan UI persis ketika import selesai. Clip di luar layar juga tidak
  // punya backing store sama sekali.
  const waveVisible = measured && win !== null;

  return (
    <div
      data-clip={clip.id}
      data-selected={selected ? 'true' : 'false'}
      data-primary={primary ? 'true' : 'false'}
      title={clip.label}
      onPointerDown={(e) => onPointerDown(e, clip)}
      style={{
        position: 'absolute',
        top: '7px',
        bottom: '7px',
        left: `${left}%`,
        width: `${width}%`,
        background: `${lane.color}24`,
        // Tiga keadaan, bukan dua: tidak terpilih, ikut terpilih, dan PRIMER.
        // Tanpa pembedaan itu, user tidak bisa tahu clip mana yang sedang
        // diedit Clip Detail saat empat clip tersorot serentak.
        // Semua anggota selection harus terbaca sebagai satu kelompok. Warna
        // aksen sebelumnya menyatu dengan lane kuning sehingga yang tampak
        // terpilih hanya clip primer yang putih.
        border: `1px solid ${selected ? '#ffffff' : lane.color}`,
        boxShadow: primary
          ? '0 0 12px #ffd40080'
          : selected
            ? 'inset 0 0 0 1px #ffffff55'
            : 'none',
        cursor: 'grab',
        overflow: 'hidden',
        userSelect: 'none',
        touchAction: 'none',
      }}
    >
      {/*
        GAGANG TRIM di kedua tepi.
        Lebarnya 7 px — cukup untuk ditunjuk tanpa presisi bedah, tapi tidak
        selebar itu sehingga clip pendek jadi tidak bisa diseret sama sekali
        (di bawah ~22 px keduanya akan menutupi seluruh badan clip, jadi
        gagangnya menyusut bersama clip-nya).
        `zIndex` di atas label & waveform: yang dituju mata saat mendekati tepi
        adalah tepinya, bukan apa pun yang kebetulan digambar di sana.
      */}
      {(['left', 'right'] as const).map((edge) => (
        <div
          key={edge}
          data-clip-trim={edge}
          onPointerDown={(e) => onTrimDown(e, clip, edge)}
          title={
            edge === 'left'
              ? 'tarik untuk memotong dari awal — tepi kanan tetap'
              : 'tarik untuk memotong dari akhir — tepi kiri tetap'
          }
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            [edge]: 0,
            width: 'min(7px, 30%)',
            cursor: 'ew-resize',
            zIndex: 2,
            touchAction: 'none',
          }}
        />
      ))}
      {/*
        Overlay fade: bidang gelap yang menutupi bagian yang diredam, jadi
        bentuknya langsung terbaca sebagai kemiringan pada waveform. Gradiennya
        disampel dari KURVA SUNGGUHAN (`fadeOverlayGradient`), bukan garis
        lurus — clip di timeline dan panel detail harus memperlihatkan bentuk
        yang sama, kalau tidak equal-power terlihat seperti linear di sini.
        Lebarnya dibatasi 50% supaya fade panjang di clip pendek tidak tumpang.
      */}
      {clip.fadeInMs > 0 ? (
        <div
          style={{
            position: 'absolute',
            inset: '0 auto 0 0',
            width: `${fadePct(clip.fadeInMs, clip.len, sampleRate)}%`,
            background: fadeOverlayGradient(clip.fadeCurve, 'in'),
            pointerEvents: 'none',
          }}
        />
      ) : null}
      {clip.fadeOutMs > 0 ? (
        <div
          style={{
            position: 'absolute',
            inset: '0 0 0 auto',
            width: `${fadePct(clip.fadeOutMs, clip.len, sampleRate)}%`,
            background: fadeOverlayGradient(clip.fadeCurve, 'out'),
            pointerEvents: 'none',
          }}
        />
      ) : null}
      <div
        style={{
          // Label mengambang DI ATAS waveform (z-index) dengan latar gelap
          // tipis, supaya tetap terbaca di bagian yang waveform-nya padat.
          position: 'relative',
          zIndex: 1,
          fontSize: '9px',
          letterSpacing: '.1em',
          color: lane.color,
          padding: '3px 6px',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          background: 'linear-gradient(#050505d9, #05050500)',
          pointerEvents: 'none',
        }}
      >
        {/* Tanda loop di LABEL, bukan badge sendiri: clip di timeline bisa
            setinggi 30 px dan sesempit beberapa piksel, dan lencana kedua akan
            jadi hal pertama yang menutupi waveform. */}
        {activeLoopLen(clip) === null ? '' : '⟳ '}
        {clip.label}
      </div>
      {waveVisible ? (
        <ClipWave
          asset={asset}
          sourceStart={clip.sourceStart}
          sourceLen={clip.sourceLen}
          loopLen={activeLoopLen(clip)}
          sampleRate={sampleRate}
          color={lane.color}
          win={win}
          fullWidth={(width / 100) * view.track - 2 * WAVE_INSET}
          style={{
            // Mengisi seluruh clip, bukan strip 20px di dasar seperti mock design.
            // Di clip setinggi 50px, strip 20px membuang lebih dari separuh ruang
            // yang justru dipakai untuk membaca bentuk audionya.
            position: 'absolute',
            // Diturunkan dari konstanta yang sama dengan yang dipakai menghitung
            // jendela — kalau keduanya berdiri sendiri, canvas akan melenceng
            // dari area waveform begitu salah satunya diubah.
            inset: `${WAVE_INSET}px`,
            background: '#020302',
            // Overlay fade & drag clip harus tetap menerima pointer.
            pointerEvents: 'none',
          }}
        />
      ) : null}
    </div>
  );
}

export function ClipArea({
  scrollerRef,
  trackWidth,
  onScroll,
  onDraggingChange,
  onImportError,
  onOpenDetail,
}: ClipAreaProps): JSX.Element {
  const lanes = useStudio((s) => s.lanes);
  const assets = useStudio((s) => s.assets);
  const duration = useStudio((s) => s.duration);
  const playhead = useStudio((s) => s.playhead);
  const sampleRate = useStudio((s) => s.sampleRate);
  const selectedClipId = useStudio((s) => s.selectedClipId);
  const selectedClipIds = useStudio((s) => s.selectedClipIds);
  const snapEnabled = useStudio((s) => s.snapEnabled);
  const laneH = laneHeightPx(useStudio((s) => s.laneHeight));
  const gesture = useRef<Gesture | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const view = useTrackView(scrollerRef, trackRef);
  /**
   * Satu picker berkas untuk SELURUH area clip, bukan satu per lane: elemen
   * input tidak bisa dibuka secara terprogram tanpa gestur user, jadi yang
   * dibutuhkan hanya satu — lane dan posisi tujuannya dititip di `pendingPick`
   * sesaat sebelum dialognya dibuka. Di desktop `picker.input` null dan
   * dialognya native; alurnya sama.
   */
  const pendingPick = useRef<{ laneId: string; start: number } | null>(null);
  const [dropLane, setDropLane] = useState<string | null>(null);
  /**
   * SELURUH job, disaring per lane saat render. Selector-nya sengaja
   * mengembalikan array yang tersimpan di state apa adanya: menyaring di dalam
   * selector menghasilkan array baru tiap panggilan, dan `getSnapshot` yang
   * selalu berbeda membuat React me-render tanpa henti (lihat kepala `store.ts`).
   */
  const importJobs = useStudio((s) => s.importJobs);
  const [marquee, setMarquee] = useState<MarqueeBox | null>(null);
  const [snapGuide, setSnapGuide] = useState<number | null>(null);
  /** Ketukan terakhir pada sebuah clip; dipakai mendeteksi double-click. */
  const lastTap = useRef<{ id: string; t: number; x: number; y: number } | null>(null);

  /**
   * Titik pointer dalam koordinat TRACK.
   *
   * Track itulah yang punya lebar penuh timeline (bisa jauh lebih lebar dari
   * viewport) dan yang ikut tergeser saat scroll. Menghitung kotak seleksi dari
   * koordinat layar akan membuat kotaknya melenceng begitu user menggulir di
   * tengah drag — dan itu terjadi setiap kali seleksi ditarik sampai ke tepi.
   */
  const trackPoint = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const el = trackRef.current;
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  };

  const span = duration > 0 ? duration : 1;
  const playPct = Math.max(0, Math.min(100, (playhead / span) * 100));

  const capture = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const el = scrollerRef.current;
    if (el !== null && typeof el.setPointerCapture === 'function') {
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // Beberapa lingkungan (jsdom) tidak mengimplementasikannya. Drag tetap
        // jalan lewat bubbling biasa.
      }
    }
    onDraggingChange(true);
    // Beri tahu playback: jangan jadwalkan ulang selama clip masih di tangan.
    studioActions.setClipDragging(true);
  };

  const beginPan = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const el = scrollerRef.current;
    if (el === null) return;
    e.preventDefault();
    gesture.current = {
      kind: 'pan',
      pointerId: e.pointerId,
      x0: e.clientX,
      scrollLeft0: el.scrollLeft,
    };
    capture(e);
    el.style.cursor = 'grabbing';
  };

  /** Posisi awal semua clip pada `ids`, untuk drag berombongan. */
  const originsOf = (ids: readonly string[]): ClipOrigin[] => {
    const wanted = new Set(ids);
    const out: ClipOrigin[] = [];
    lanes.forEach((lane, laneIndex) => {
      for (const c of lane.clips) {
        if (wanted.has(c.id)) out.push({ id: c.id, start: c.start, laneIndex });
      }
    });
    return out;
  };

  /** Pointer turun di salah satu gagang tepi clip. */
  const beginTrimDrag = (
    e: ReactPointerEvent<HTMLDivElement>,
    clip: StudioClip,
    edge: 'left' | 'right',
  ): void => {
    if (e.button !== 0) return;
    // Gagang menang atas badan clip: tanpa ini, satu pointerdown akan memulai
    // trim DAN pemindahan clip sekaligus.
    e.stopPropagation();
    if (e.shiftKey) {
      beginPan(e);
      return;
    }
    e.preventDefault();
    const el = scrollerRef.current;
    const p = trackPoint(e.clientX, e.clientY);
    if (el === null || p === null) return;
    const samplesPerPx = el.scrollWidth > 0 ? duration / el.scrollWidth : 0;
    const edgeAt = edge === 'left' ? clip.start : clip.start + clip.len;
    gesture.current = {
      kind: 'trim',
      pointerId: e.pointerId,
      clipId: clip.id,
      edge,
      samplesPerPx,
      grabOffset: p.x - (samplesPerPx > 0 ? edgeAt / samplesPerPx : 0),
    };
    capture(e);
    studioActions.selectClip(clip.id);
  };

  const beginClipDrag = (e: ReactPointerEvent<HTMLDivElement>, clip: StudioClip): void => {
    // Klik clip TIDAK boleh ikut memicu kotak seleksi / pan latar.
    e.stopPropagation();
    e.preventDefault();
    const el = scrollerRef.current;
    if (el === null) return;
    if (e.button === 0 && e.shiftKey) {
      beginPan(e);
      return;
    }
    const laneIndex = lanes.findIndex((l) => l.clips.some((c) => c.id === clip.id));
    if (laneIndex < 0) return;

    if (e.altKey) {
      // SLIP: kedua tepi diam, materinya yang bergeser di dalam jendela.
      // Alt dipilih karena itu binding yang sama di FL Studio dan Ableton —
      // dan karena ia tidak mungkin tertekan tanpa sengaja saat menyeret biasa.
      const samplesPerPx = el.scrollWidth > 0 ? duration / el.scrollWidth : 0;
      gesture.current = {
        kind: 'slip',
        pointerId: e.pointerId,
        clipId: clip.id,
        x0: e.clientX,
        sourceStart0: clip.sourceStart,
        samplesPerPx,
        speedRatio: lanes[laneIndex]?.speedRatio ?? 1,
      };
      capture(e);
      studioActions.selectClip(clip.id, lanes[laneIndex]?.id);
      return;
    }

    const additive = e.metaKey || e.ctrlKey;
    if (additive) {
      // Menambah/membuang dari seleksi, TANPA memulai drag: menyeret sambil
      // menahan Ctrl hampir selalu tidak disengaja, dan kalau ia ikut memindah
      // clip, satu klik salah bisa menggeser materi tanpa disadari.
      studioActions.toggleClipSelection(clip.id, lanes[laneIndex]?.id);
      return;
    }

    /*
     * DOUBLE-CLICK = buka Clip Detail.
     *
     * Dideteksi manual dari `pointerdown`, BUKAN lewat `onDoubleClick`: handler
     * ini memanggil `preventDefault()` supaya drag tidak ikut menyeret seleksi
     * teks, dan membatalkan `pointerdown` menekan SELURUH compatibility mouse
     * event — termasuk `dblclick`, yang karenanya tidak pernah sampai ke React.
     * Melepas `preventDefault()` demi mendapatkan `dblclick` akan menukar satu
     * fitur dengan kerusakan pada gerakan yang jauh lebih sering dipakai.
     */
    const prev = lastTap.current;
    // Selisih NEGATIF juga ditolak, bukan hanya yang terlalu besar. Dua event
    // tidak dijamin memakai titik nol yang sama: React menormalkan stempel
    // waktu sebagai `event.timeStamp || Date.now()`, jadi satu event bernilai 0
    // diam-diam berubah menjadi waktu epoch — dan selisih terhadapnya adalah
    // bilangan negatif raksasa yang lolos begitu saja dari batas atas.
    const dt = prev === null ? Number.NaN : e.timeStamp - prev.t;
    const isDouble =
      prev !== null &&
      prev.id === clip.id &&
      dt >= 0 &&
      dt < DOUBLE_TAP_MS &&
      Math.abs(e.clientX - prev.x) <= DOUBLE_TAP_PX &&
      Math.abs(e.clientY - prev.y) <= DOUBLE_TAP_PX;
    // Ketukan kedua MENGHAPUS jejaknya, bukan memperbaruinya: kalau tidak,
    // ketukan ketiga yang cepat terbaca sebagai double-click lagi dan dialog
    // yang baru saja ditutup langsung terbuka kembali.
    lastTap.current = isDouble
      ? null
      : { id: clip.id, t: e.timeStamp, x: e.clientX, y: e.clientY };
    if (isDouble) {
      // Sengaja TIDAK memulai gesture apa pun. Ketukan pertama sudah memilih
      // clip ini; memulai drag kedua hanya membuka peluang menggeser materi
      // beberapa sampel karena tangan bergetar saat men-double-click.
      gesture.current = null;
      studioActions.selectClip(clip.id, lanes[laneIndex]?.id);
      onOpenDetail?.(clip.id);
      return;
    }

    // Menyeret clip yang SUDAH terpilih membawa seluruh seleksi; menyeret clip
    // di luar seleksi menggantinya lebih dulu. Ini yang membuat "pilih empat
    // lalu geser semuanya" bekerja tanpa tombol tambahan.
    const live = studioStore.getState().selectedClipIds;
    const inSelection = live.includes(clip.id);
    const ids = inSelection ? live : [clip.id];
    if (!inSelection) studioActions.selectClip(clip.id, lanes[laneIndex]?.id);
    else studioActions.setSelectedClips(ids, clip.id);

    // Guard NaN/∞: sebelum layout pertama, scrollWidth bisa 0.
    const samplesPerPx = el.scrollWidth > 0 ? duration / el.scrollWidth : 0;
    gesture.current = {
      kind: 'clip',
      pointerId: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      origins: originsOf(ids),
      samplesPerPx,
    };
    capture(e);
  };

  /**
   * Pointer turun di LATAR.
   *
   * Dulu ini selalu pan. Sejak seleksi kotak ada, latar dipakai untuk MEMILIH —
   * gerakan yang sama dengan CapCut/Figma — dan pan memakai Shift+drag atau
   * tombol tengah mouse. Shift juga bekerja ketika pointer berada di atas clip,
   * sehingga clip panjang tidak lagi menutup satu-satunya permukaan untuk pan.
   */
  const beginBackgroundDrag = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const el = scrollerRef.current;
    if (el === null) return;
    const wantsPan = e.button === 1 || (e.button === 0 && e.shiftKey);
    if (wantsPan) {
      beginPan(e);
      return;
    }
    if (e.button !== 0) return;
    const p = trackPoint(e.clientX, e.clientY);
    if (p === null) return;
    e.preventDefault();
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    // Lane KOSONG yang diketuk = jalan pintas ke file manager (lihat
    // `endGesture`). Lane yang sudah berisi clip sengaja tidak ikut: di sana
    // klik latar adalah cara membatalkan seleksi, dan dialog yang menyembul
    // tiap kali user membatalkan seleksi akan segera terasa seperti kerusakan.
    // Dengan modifier ditahan pun tidak: itu jelas-jelas gerakan seleksi.
    const row = lanes[Math.floor(p.y / laneH)];
    const emptyLaneId = !additive && row !== undefined && row.clips.length === 0 ? row.id : null;
    gesture.current = {
      kind: 'marquee',
      pointerId: e.pointerId,
      x0: p.x,
      y0: p.y,
      base: additive ? studioStore.getState().selectedClipIds : [],
      emptyLaneId,
      atSamples: el.scrollWidth > 0 ? (p.x / el.scrollWidth) * duration : 0,
    };
    if (!additive) studioActions.clearClipSelection();
    setMarquee({ left: p.x, top: p.y, width: 0, height: 0 });
    capture(e);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const cursor = trackPoint(e.clientX, e.clientY);
    const track = trackRef.current;
    const trackWidthPx = track?.getBoundingClientRect().width ?? 0;
    if (cursor !== null && trackWidthPx > 0) {
      setTimelineCursor((Math.max(0, Math.min(trackWidthPx, cursor.x)) / trackWidthPx) * duration);
    }
    const g = gesture.current;
    if (g === null || g.pointerId !== e.pointerId) return;
    const el = scrollerRef.current;
    if (el === null) return;
    if (g.kind === 'pan') {
      el.scrollLeft = g.scrollLeft0 - (e.clientX - g.x0);
      return;
    }
    if (g.kind === 'marquee') {
      const p = trackPoint(e.clientX, e.clientY);
      if (p === null) return;
      const box: MarqueeBox = {
        left: Math.min(g.x0, p.x),
        top: Math.min(g.y0, p.y),
        width: Math.abs(p.x - g.x0),
        height: Math.abs(p.y - g.y0),
      };
      setMarquee(box);
      studioActions.setSelectedClips(clipsInBox(box, g.base));
      return;
    }
    if (g.kind === 'trim') {
      const p = trackPoint(e.clientX, e.clientY);
      if (p === null) return;
      // `grabOffset` menjaga tepi tidak MELOMPAT ke bawah kursor di gerakan
      // pertama: yang digeser adalah selisih dari titik pointer turun, bukan
      // posisi absolut kursor.
      studioActions.trimClip(g.clipId, g.edge, (p.x - g.grabOffset) * g.samplesPerPx);
      return;
    }
    if (g.kind === 'slip') {
      // TIMELINE → SOURCE: satu piksel di lane 2× lebih cepat memakan dua kali
      // lipat materi.
      const deltaSource = (e.clientX - g.x0) * g.samplesPerPx * g.speedRatio;
      // Menyeret ke KANAN memajukan jendela ke materi yang lebih AWAL — arah
      // yang sama dengan menggeser kertas di bawah jarum, sama seperti menarik
      // waveform di Clip Detail.
      studioActions.slipClip(g.clipId, g.sourceStart0, -deltaSource);
      return;
    }
    const rows = Math.round((e.clientY - g.y0) / laneH);
    const rawDelta = (e.clientX - g.x0) * g.samplesPerPx;
    if (snapEnabled) {
      const snapped = snapClipMove(lanes, g.origins, rawDelta, rows, g.samplesPerPx);
      setSnapGuide(snapped.guideSample);
      studioActions.moveClips(g.origins, snapped.deltaSamples, rows);
    } else {
      setSnapGuide(null);
      studioActions.moveClips(g.origins, rawDelta, rows);
    }
  };

  /**
   * Semua clip yang BERSINGGUNGAN dengan kotak, digabung dengan `base`.
   *
   * Bersinggungan, bukan "termuat seluruhnya": clip di timeline bisa jauh lebih
   * lebar dari layar, dan menuntut kotaknya melingkupi seluruh clip berarti
   * clip panjang tidak akan pernah bisa dipilih dengan cara ini.
   */
  const clipsInBox = (box: MarqueeBox, base: readonly string[]): string[] => {
    const el = trackRef.current;
    const width = el?.getBoundingClientRect().width ?? 0;
    if (width <= 0) return [...base];
    const from = (box.left / width) * span;
    const to = ((box.left + box.width) / width) * span;
    const laneFrom = Math.floor(box.top / laneH);
    const laneTo = Math.floor((box.top + box.height) / laneH);

    const picked = new Set(base);
    lanes.forEach((lane, i) => {
      if (i < laneFrom || i > laneTo) return;
      for (const c of lane.clips) {
        if (c.start + c.len > from && c.start < to) picked.add(c.id);
      }
    });
    return [...picked];
  };

  /**
   * Mulai import beberapa file SEKALIGUS ke satu lane.
   *
   * Tanpa `await` dan tanpa antrean: tiap file berjalan sendiri, jadi lagu
   * kedua sudah mulai dibaca saat lagu pertama masih di-decode, dan lane lain
   * tetap bisa menerima file di saat yang sama. Kegagalan satu file tidak
   * menyentuh yang lain — masing-masing melaporkan alasannya sendiri.
   */
  const startFileImports = (files: readonly File[], laneId: string, start: number): void => {
    const avoidOverlap = files.length > 1;
    for (const file of files) {
      void runFileImport(file, laneId, start, sampleRate, { avoidOverlap }).then((r) => {
        if (!r.ok) onImportError(`${file.name}: ${r.reason ?? 'gagal'}`);
      });
    }
  };

  const picker = useAudioFilePicker(
    (files) => {
      const target = pendingPick.current;
      pendingPick.current = null;
      if (target === null) return;
      startFileImports(files, target.laneId, target.start);
    },
    { dataAttr: 'data-lane-file-input' },
  );

  /** Ketukan pada lane kosong → dialog berkas, dengan tujuannya dititip dulu. */
  const openPicker = (laneId: string, start: number): void => {
    pendingPick.current = { laneId, start };
    picker.open();
  };

  /** Lane di bawah titik layar (piksel CSS), atau `null` kalau bukan lane. */
  const laneAt = (x: number, y: number): string | null => {
    const under = document.elementFromPoint(x, y);
    return under?.closest<HTMLElement>('[data-lane-row]')?.dataset['laneRow'] ?? null;
  };

  /** Posisi jatuh di timeline, dalam sample, dari `clientX`. */
  const dropStartAt = (clientX: number): number => {
    const el = scrollerRef.current;
    if (el === null || el.scrollWidth <= 0) return 0;
    const rect = el.getBoundingClientRect();
    return ((el.scrollLeft + (clientX - rect.left)) / el.scrollWidth) * duration;
  };

  /**
   * Drop dari Finder/Explorer di desktop: tidak ada event DOM `drop`, hanya
   * `File` + titik jatuh. Lane-nya dicari dari elemen di bawah titik itu, dan
   * posisinya dihitung dengan rumus yang SAMA dengan drop DOM (`dropStartAt`).
   */
  useNativeFileDrop(scrollerRef, (files, point) => {
    const laneId = laneAt(point.x, point.y);
    if (laneId === null) return;
    startFileImports(files, laneId, dropStartAt(point.x));
  });

  /**
   * Lagu kepustakaan yang diseret ke lane (`library-drop.ts`): gesturnya
   * pointer event milik baris kepustakaan, dan yang diminta dari timeline
   * hanya "titik ini lane mana, sample ke berapa" — rumusnya SAMA dengan drop
   * berkas (`dropStartAt`) — plus sorotan lane yang dilayang-layangi. Ref-nya
   * supaya locator yang terdaftar sekali tetap memakai `duration` terbaru.
   */
  const dropStartAtRef = useRef(dropStartAt);
  dropStartAtRef.current = dropStartAt;
  useEffect(
    () =>
      registerLaneLocator({
        locate: (x, y) => {
          const laneId = laneAt(x, y);
          return laneId === null ? null : { laneId, startSamples: dropStartAtRef.current(x) };
        },
        highlight: setDropLane,
      }),
    [],
  );

  const endGesture = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const g = gesture.current;
    if (g === null || g.pointerId !== e.pointerId) return;
    gesture.current = null;
    if (g.kind === 'marquee' && g.emptyLaneId !== null) {
      const p = trackPoint(e.clientX, e.clientY);
      const moved = p === null ? Number.POSITIVE_INFINITY : Math.hypot(p.x - g.x0, p.y - g.y0);
      // Dibuka dari `pointerup`, dan itu memang syaratnya: browser hanya
      // mengizinkan dialog berkas dibuka dari event yang membawa aktivasi user.
      if (moved <= TAP_PX) openPicker(g.emptyLaneId, g.atSamples);
    }
    const el = scrollerRef.current;
    if (el !== null) {
      el.style.cursor = 'grab';
      if (typeof el.hasPointerCapture === 'function' && el.hasPointerCapture(e.pointerId)) {
        el.releasePointerCapture(e.pointerId);
      }
    }
    setMarquee(null);
    setSnapGuide(null);
    onDraggingChange(false);
    // Dilepas → posisi/lane baru langsung berlaku ke audio yang sedang jalan.
    studioActions.setClipDragging(false);
  };

  const dropStart = (e: ReactDragEvent<HTMLDivElement>): number => dropStartAt(e.clientX);

  const handleDrop = (e: ReactDragEvent<HTMLDivElement>, laneId: string): void => {
    e.preventDefault();
    e.stopPropagation();
    setDropLane(null);

    // Lagu dari kepustakaan TIDAK lewat sini: gesturnya pointer event, bukan
    // drag HTML5 (lihat `library-drop.ts`), dan ia bertanya ke locator di
    // bawah. Yang sampai di sini hanya berkas dan URL dari luar halaman.
    const files = Array.from(e.dataTransfer?.files ?? []);
    // Link bisa datang sebagai `text/uri-list` (drag dari address bar / tab)
    // atau `text/plain` (drag teks berisi URL). Cek dua-duanya.
    const droppedText =
      e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain') || '';
    if (files.length === 0 && droppedText.trim() === '') return;
    const start = dropStart(e);
    startFileImports(files, laneId, start);

    if (files.length === 0 && droppedText.trim() !== '') {
      void runUrlImport(droppedText, laneId, start, sampleRate).then((r) => {
        if (!r.ok) onImportError(r.reason ?? 'gagal mengimpor URL');
      });
    }
  };

  return (
    <div
      data-tl-scroll
      ref={scrollerRef}
      onScroll={onScroll}
      onPointerDown={beginBackgroundDrag}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      onPointerLeave={() => clearTimelineCursor()}
      style={{
        minWidth: 0,
        maxWidth: '100%',
        overflowX: 'auto',
        overflowY: 'hidden',
        contain: 'inline-size',
        scrollbarWidth: 'none',
        cursor: 'default',
        touchAction: 'pan-y',
      }}
    >
      <div ref={trackRef} style={{ width: trackWidth, minWidth: '100%', position: 'relative' }}>
        {lanes.map((lane) => (
          <div
            key={lane.id}
            data-lane-row={lane.id}
            onDragOver={(e) => {
              e.preventDefault();
              setDropLane(lane.id);
            }}
            onDragLeave={() => setDropLane((cur) => (cur === lane.id ? null : cur))}
            onDrop={(e) => handleDrop(e, lane.id)}
            style={{
              position: 'relative',
              height: `${laneH}px`,
              borderBottom: '1px solid var(--cy-border)',
              background:
                'repeating-linear-gradient(90deg,transparent,transparent calc(8.333% - 1px),var(--cy-grid-line) 8.333%)',
              outline: dropLane === lane.id ? '1px solid var(--cy-accent)' : 'none',
              outlineOffset: '-1px',
              // Umpan balik bisu: tanpa ini, lane yang tidak terdengar karena
              // mute ATAU karena lane lain sedang solo terlihat persis sama
              // dengan yang berbunyi — dan itu terbaca sebagai bug playback.
              opacity: isAudible(lane, lanes) ? 1 : 0.3,
            }}
          >
            {lane.clips.map((clip) => (
              <ClipView
                key={clip.id}
                clip={clip}
                lane={lane}
                selected={selectedClipIds.includes(clip.id)}
                primary={clip.id === selectedClipId}
                asset={assets[clip.assetId]}
                duration={duration}
                sampleRate={sampleRate}
                view={view}
                onPointerDown={beginClipDrag}
                onTrimDown={beginTrimDrag}
              />
            ))}
            <LaneImportOverlay jobs={importJobs.filter((j) => j.laneId === lane.id)} />
            {/* Ajakan hanya untuk lane yang benar-benar kosong DAN diam. Selama
                import berjalan, tempatnya dipakai bar progres — dua tulisan
                bertumpuk di kotak setinggi satu lane tidak terbaca, dan
                "DROP AUDIO DI SINI" di atas file yang sedang dibaca terbaca
                seperti file-nya tidak masuk. */}
            {lane.clips.length === 0 && !importJobs.some((j) => j.laneId === lane.id) ? (
              <div
                style={{
                  position: 'absolute',
                  inset: '8px',
                  border: '1px dashed var(--cy-border-strong)',
                  display: 'grid',
                  placeItems: 'center',
                  fontSize: '9px',
                  letterSpacing: '.16em',
                  color: 'var(--cy-text-muted)',
                  // Tetap tembus pointer: ketukan yang membuka file manager
                  // ditangkap scroller (lihat `endGesture`), dan elemen yang
                  // menadah pointer di sini akan memutus kotak seleksi yang
                  // ditarik melewati lane kosong.
                  pointerEvents: 'none',
                }}
              >
                KLIK ATAU DROP AUDIO DI SINI
              </div>
            ) : null}
          </div>
        ))}
        {marquee === null ? null : (
          <div
            data-marquee
            style={{
              position: 'absolute',
              left: `${marquee.left}px`,
              top: `${marquee.top}px`,
              width: `${marquee.width}px`,
              height: `${marquee.height}px`,
              border: '1px solid var(--cy-accent)',
              background: '#ffd4001a',
              pointerEvents: 'none',
              zIndex: 3,
            }}
          />
        )}
        {snapGuide === null ? null : (
          <div
            data-snap-guide
            aria-hidden="true"
            style={{
              position: 'absolute',
              zIndex: 5,
              top: 0,
              bottom: 0,
              left: `${(snapGuide / span) * 100}%`,
              width: '1px',
              background: 'var(--cy-accent)',
              boxShadow: '0 0 8px var(--cy-accent)',
              pointerEvents: 'none',
            }}
          />
        )}
        <div
          data-playhead
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: `${playPct}%`,
            width: '1px',
            background: '#fff',
            boxShadow: '0 0 8px #fff',
            pointerEvents: 'none',
          }}
        />
      </div>
      {picker.input}
    </div>
  );
}
