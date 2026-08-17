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
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import { isAudible, LANE_HEIGHT_PX, type StudioClip, type StudioLane } from '../model';
import { studioActions, useStudio, type StudioAsset } from '../store';
import { importFileToLane } from './audio-import';
import { importUrlToLane } from './url-to-lane';
import { drawClipWave } from './waveform';
import { fadeOverlayGradient } from './fade';
import { useCanvasDraw } from '../../ui/lib/canvas';

export interface ClipAreaProps {
  readonly scrollerRef: RefObject<HTMLDivElement>;
  readonly trackWidth: string;
  readonly onScroll: () => void;
  /** Memberi tahu parent bahwa user sedang men-drag (mematikan auto-follow). */
  readonly onDraggingChange: (dragging: boolean) => void;
  readonly onImportError: (message: string) => void;
}

/** Lebar overlay fade dalam persen lebar clip; dibatasi setengah clip. */
function fadePct(fadeMs: number, clipLen: number, sampleRate: number): number {
  if (clipLen <= 0) return 0;
  const fadeSamples = (fadeMs / 1000) * sampleRate;
  return Math.max(0, Math.min(50, (fadeSamples / clipLen) * 100));
}

/** Drag clip (pindah waktu + lane) atau drag latar (pan). */
type Gesture =
  | {
      readonly kind: 'clip';
      readonly pointerId: number;
      readonly clipId: string;
      readonly x0: number;
      readonly y0: number;
      readonly startAtDown: number;
      readonly laneIndexAtDown: number;
      readonly samplesPerPx: number;
    }
  | {
      readonly kind: 'pan';
      readonly pointerId: number;
      readonly x0: number;
      readonly scrollLeft0: number;
    };

/**
 * Waveform clip di canvas.
 *
 * Ukurannya ditentukan CSS (clip diposisikan dalam persen), dan
 * `useCanvasDraw` menggambar ulang lewat ResizeObserver — jadi zoom timeline
 * otomatis menaikkan kerapatan kolom tanpa komponen ini tahu soal zoom.
 */
function ClipWave({
  asset,
  sourceStart,
  sourceLen,
  color,
  style,
}: {
  asset: StudioAsset | undefined;
  sourceStart: number;
  sourceLen: number;
  color: string;
  style: CSSProperties;
}): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  useCanvasDraw(
    ref,
    (ctx, size) => {
      drawClipWave(ctx, asset, sourceStart, sourceLen, size.width, size.height, size.dpr, {
        outline: color,
        body: color,
        // Opacity lama (0.5) dipertahankan untuk outline; badan RMS sedikit
        // lebih pekat supaya terbaca sebagai isi, bukan sebagai warna kedua.
        outlineAlpha: 0.5,
        bodyAlpha: 0.85,
        centerLine: null,
      });
    },
    [asset, sourceStart, sourceLen, color],
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
      <canvas ref={ref} style={{ display: 'block', width: '100%', height: '100%' }} />
    </div>
  );
}

function ClipView({
  clip,
  lane,
  selected,
  asset,
  duration,
  sampleRate,
  onPointerDown,
}: {
  clip: StudioClip;
  lane: StudioLane;
  selected: boolean;
  asset: StudioAsset | undefined;
  duration: number;
  sampleRate: number;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>, clip: StudioClip) => void;
}): JSX.Element {
  const span = duration > 0 ? duration : 1;
  const left = (clip.start / span) * 100;
  const width = Math.max(0.2, (clip.len / span) * 100);

  return (
    <div
      data-clip={clip.id}
      title={clip.label}
      onPointerDown={(e) => onPointerDown(e, clip)}
      style={{
        position: 'absolute',
        top: '7px',
        bottom: '7px',
        left: `${left}%`,
        width: `${width}%`,
        background: `${lane.color}24`,
        border: `1px solid ${selected ? '#ffffff' : lane.color}`,
        boxShadow: selected ? '0 0 12px #ffd40080' : 'none',
        cursor: 'grab',
        overflow: 'hidden',
        userSelect: 'none',
        touchAction: 'none',
      }}
    >
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
        {clip.label}
      </div>
      <ClipWave
        asset={asset}
        sourceStart={clip.sourceStart}
        sourceLen={clip.sourceLen}
        color={lane.color}
        style={{
          // Mengisi seluruh clip, bukan strip 20px di dasar seperti mock design.
          // Di clip setinggi 50px, strip 20px membuang lebih dari separuh ruang
          // yang justru dipakai untuk membaca bentuk audionya.
          position: 'absolute',
          inset: '2px',
          // Overlay fade & drag clip harus tetap menerima pointer.
          pointerEvents: 'none',
        }}
      />
    </div>
  );
}

export function ClipArea({
  scrollerRef,
  trackWidth,
  onScroll,
  onDraggingChange,
  onImportError,
}: ClipAreaProps): JSX.Element {
  const lanes = useStudio((s) => s.lanes);
  const assets = useStudio((s) => s.assets);
  const duration = useStudio((s) => s.duration);
  const playhead = useStudio((s) => s.playhead);
  const sampleRate = useStudio((s) => s.sampleRate);
  const selectedClipId = useStudio((s) => s.selectedClipId);

  const gesture = useRef<Gesture | null>(null);
  const [dropLane, setDropLane] = useState<string | null>(null);

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

  const beginClipDrag = (e: ReactPointerEvent<HTMLDivElement>, clip: StudioClip): void => {
    // Klik clip TIDAK boleh ikut memicu pan latar.
    e.stopPropagation();
    e.preventDefault();
    const el = scrollerRef.current;
    if (el === null) return;
    const laneIndex = lanes.findIndex((l) => l.clips.some((c) => c.id === clip.id));
    if (laneIndex < 0) return;
    // Guard NaN/∞: sebelum layout pertama, scrollWidth bisa 0.
    const samplesPerPx = el.scrollWidth > 0 ? duration / el.scrollWidth : 0;
    gesture.current = {
      kind: 'clip',
      pointerId: e.pointerId,
      clipId: clip.id,
      x0: e.clientX,
      y0: e.clientY,
      startAtDown: clip.start,
      laneIndexAtDown: laneIndex,
      samplesPerPx,
    };
    capture(e);
    // Klik = pilih (design menyatukan select dan drag di gerakan yang sama).
    studioActions.selectClip(clip.id, lanes[laneIndex]?.id);
  };

  const beginPan = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const el = scrollerRef.current;
    if (el === null || e.button !== 0) return;
    gesture.current = {
      kind: 'pan',
      pointerId: e.pointerId,
      x0: e.clientX,
      scrollLeft0: el.scrollLeft,
    };
    capture(e);
    el.style.cursor = 'grabbing';
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const g = gesture.current;
    if (g === null || g.pointerId !== e.pointerId) return;
    const el = scrollerRef.current;
    if (el === null) return;
    if (g.kind === 'pan') {
      el.scrollLeft = g.scrollLeft0 - (e.clientX - g.x0);
      return;
    }
    const rows = Math.round((e.clientY - g.y0) / LANE_HEIGHT_PX);
    studioActions.moveClip(
      g.clipId,
      g.startAtDown + (e.clientX - g.x0) * g.samplesPerPx,
      g.laneIndexAtDown + rows,
    );
  };

  const endGesture = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const g = gesture.current;
    if (g === null || g.pointerId !== e.pointerId) return;
    gesture.current = null;
    const el = scrollerRef.current;
    if (el !== null) {
      el.style.cursor = 'grab';
      if (typeof el.hasPointerCapture === 'function' && el.hasPointerCapture(e.pointerId)) {
        el.releasePointerCapture(e.pointerId);
      }
    }
    onDraggingChange(false);
    // Dilepas → posisi/lane baru langsung berlaku ke audio yang sedang jalan.
    studioActions.setClipDragging(false);
  };

  const handleDrop = (e: ReactDragEvent<HTMLDivElement>, laneId: string): void => {
    e.preventDefault();
    e.stopPropagation();
    setDropLane(null);
    const files = Array.from(e.dataTransfer?.files ?? []);
    // Link bisa datang sebagai `text/uri-list` (drag dari address bar / tab)
    // atau `text/plain` (drag teks berisi URL). Cek dua-duanya.
    const droppedText =
      e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain') || '';
    if (files.length === 0 && droppedText.trim() === '') return;
    const el = scrollerRef.current;
    let start = 0;
    if (el !== null && el.scrollWidth > 0) {
      const rect = el.getBoundingClientRect();
      start = ((el.scrollLeft + (e.clientX - rect.left)) / el.scrollWidth) * duration;
    }
    for (const file of files) {
      void importFileToLane(file, laneId, start, sampleRate).then((r) => {
        if (!r.ok) onImportError(`${file.name}: ${r.reason ?? 'gagal'}`);
      });
    }

    if (files.length === 0 && droppedText.trim() !== '') {
      void importUrlToLane(droppedText, laneId, start, sampleRate).then((r) => {
        if (!r.ok) onImportError(r.reason ?? 'gagal mengimpor URL');
      });
    }
  };

  return (
    <div
      data-tl-scroll
      ref={scrollerRef}
      onScroll={onScroll}
      onPointerDown={beginPan}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      style={{
        minWidth: 0,
        maxWidth: '100%',
        overflowX: 'auto',
        overflowY: 'hidden',
        contain: 'inline-size',
        scrollbarWidth: 'none',
        cursor: 'grab',
        touchAction: 'pan-y',
      }}
    >
      <div style={{ width: trackWidth, minWidth: '100%', position: 'relative' }}>
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
              height: `${LANE_HEIGHT_PX}px`,
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
                selected={clip.id === selectedClipId}
                asset={assets[clip.assetId]}
                duration={duration}
                sampleRate={sampleRate}
                onPointerDown={beginClipDrag}
              />
            ))}
            {lane.clips.length === 0 ? (
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
                  pointerEvents: 'none',
                }}
              >
                DROP AUDIO DI SINI
              </div>
            ) : null}
          </div>
        ))}
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
    </div>
  );
}
