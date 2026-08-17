/**
 * Arrangement / Timeline — `grid-column: span 12` di design.
 *
 * Pembagian DOM vs canvas mengikuti docs/08 §Arrangement:
 *   • Kolom header track (210px) tetap DOM — teks, tombol M/S, jarang berubah,
 *     butuh fokus keyboard.
 *   • SELURUH lane clip adalah SATU canvas untuk semua track. Design memakai
 *     ~40 `<div>` waveform per clip × 9 clip; itu ratusan node yang harus
 *     direkonsiliasi setiap zoom/scroll.
 *   • Ghost drag digambar di canvas overlay terpisah (docs/06 §Drag preview),
 *     supaya menggerakkan pointer tidak menggambar ulang seluruh arrangement.
 *
 * Visual yang direproduksi persis dari design: lane 52px dengan grid
 * `repeating-linear-gradient` 12.5%, clip inset 6px atas/bawah dengan
 * background `{color}1f`, border 1px `{color}`, sudut kanan-bawah ter-potong
 * 6px, label 9px letterspacing .16em di padding 4px 6px, dan strip waveform
 * setinggi 12px di `bottom:4px` dengan opacity .55.
 *
 * Virtualisasi: hanya clip yang beririsan dengan viewport yang digambar, dan
 * penggambaran hanya terjadi saat viewport/project/seleksi/drag-selesai
 * berubah — bukan tiap frame.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Card } from '../cyber';
import {
  useEngineCommands,
  useMeterFrame,
  useUiStore,
  type Clip,
  type GridDivision,
  type Track,
} from '../../state';
import { uiActions, uiStore } from '../../state/store';
import { useCanvasDraw, useOverlayContext } from '../lib/canvas';
import { useDrag, type DragContext } from '../lib/drag';
import { getPeakPyramid, readPeaks } from '../lib/peaks';
import { sampleToPx, samplesPerBar, snapSample } from '../lib/time';

const HEADER_W = 210;
const RULER_H = 26;
const LANE_H = 52;
const CLIP_INSET = 6;
/** Lebar zona trim di ujung clip, dalam pixel. Di bawah ini = badan clip. */
const TRIM_PX = 6;
/** Handle fade di sudut atas clip. */
const FADE_PX = 10;

type DragKind = 'move' | 'trim-start' | 'trim-end' | 'fade-in' | 'fade-out';

interface DragState {
  readonly kind: DragKind;
  readonly clip: Clip;
  readonly trackId: number;
  /** Nilai yang sedang ditampilkan ghost. */
  posSamples: number;
  lenSamples: number;
  fadeSamples: number;
}

/** Hit-test JS di atas canvas: badan clip vs trim vs fade. Ini menggantikan
 *  puluhan elemen DOM yang masing-masing punya handler sendiri. */
function hitTest(
  tracks: readonly Track[],
  x: number,
  y: number,
  view: { startSample: number; pxPerSample: number },
): { readonly trackId: number; readonly clip: Clip; readonly kind: DragKind } | null {
  const row = Math.floor(y / LANE_H);
  const track = tracks[row];
  if (track === undefined) return null;
  for (const clip of track.clips) {
    const x0 = sampleToPx(clip.timelinePos, view);
    const x1 = sampleToPx(clip.timelinePos + clip.sourceLen / clip.speedRatio, view);
    if (x < x0 || x > x1) continue;
    const yInLane = y - row * LANE_H;
    if (x - x0 <= TRIM_PX) return { trackId: track.id, clip, kind: 'trim-start' };
    if (x1 - x <= TRIM_PX) return { trackId: track.id, clip, kind: 'trim-end' };
    if (yInLane <= CLIP_INSET + FADE_PX) {
      if (x - x0 <= FADE_PX * 3) return { trackId: track.id, clip, kind: 'fade-in' };
      if (x1 - x <= FADE_PX * 3) return { trackId: track.id, clip, kind: 'fade-out' };
    }
    return { trackId: track.id, clip, kind: 'move' };
  }
  return null;
}

export function ArrangementTimeline(): JSX.Element {
  const cmd = useEngineCommands();
  const project = useUiStore((s) => s.project);
  const viewport = useUiStore((s) => s.viewport);
  const grid = useUiStore((s) => s.grid);
  const snapEnabled = useUiStore((s) => s.snapEnabled);
  const selectedClipIds = useUiStore((s) => s.selectedClipIds);
  const selectedTrackId = useUiStore((s) => s.selectedTrackId);
  const bpm = useUiStore((s) => s.transport.bpm);
  const beatsPerBar = useUiStore((s) => s.transport.timeSignature[0]);

  const laneRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const getOverlay = useOverlayContext(overlayRef);
  const peakBuf = useRef<Float32Array>(new Float32Array(0));
  const drag = useRef<DragState | null>(null);
  const [, forceRedraw] = useState(0);

  const tempo = useMemo(
    () => ({ bpm, sampleRate: project.sampleRate, beatsPerBar }),
    [bpm, project.sampleRate, beatsPerBar],
  );

  const view = { startSample: viewport.startSample, pxPerSample: viewport.pxPerSample };
  const selected = useMemo(() => new Set(selectedClipIds), [selectedClipIds]);

  useCanvasDraw(
    laneRef,
    (ctx, size) => {
      const barPx = samplesPerBar(tempo) * view.pxPerSample;

      project.tracks.forEach((track, row) => {
        const top = row * LANE_H;
        // Grid: design memakai repeating-linear-gradient tiap 12.5% (= 4 bar
        // dari 32). Di canvas kita gambar garis per bar dari tempo map, jadi
        // grid tetap benar saat zoom — hasil visualnya identik pada zoom penuh.
        // Warna literal: canvas tidak bisa membaca var(--cy-grid-line).
        ctx.fillStyle = '#161616';
        if (barPx > 4) {
          const firstBar = Math.floor(view.startSample / samplesPerBar(tempo));
          for (let b = firstBar; ; b++) {
            const x = Math.round(sampleToPx(b * samplesPerBar(tempo), view)) + 0.5;
            if (x > size.width) break;
            if (x >= 0) ctx.fillRect(x, top, 1, LANE_H);
          }
        }
        // Garis bawah lane.
        ctx.fillStyle = '#282520';
        ctx.fillRect(0, top + LANE_H - 1, size.width, 1);

        for (const clip of track.clips) {
          const live = drag.current !== null && drag.current.clip.id === clip.id ? drag.current : null;
          const pos = live?.posSamples ?? clip.timelinePos;
          const lenTimeline = (live?.lenSamples ?? clip.sourceLen) / clip.speedRatio;
          const x0 = sampleToPx(pos, view);
          const x1 = sampleToPx(pos + lenTimeline, view);
          // Virtualisasi: lewati clip di luar viewport sebelum kerja apa pun.
          if (x1 < 0 || x0 > size.width) continue;

          const w = Math.max(2, x1 - x0);
          const y0 = top + CLIP_INSET;
          const h = LANE_H - CLIP_INSET * 2;
          const isSel = selected.has(clip.id);

          ctx.save();
          // clip-path polygon(0 0,100% 0,100% calc(100% - 6px),calc(100% - 6px) 100%,0 100%)
          ctx.beginPath();
          ctx.moveTo(x0, y0);
          ctx.lineTo(x0 + w, y0);
          ctx.lineTo(x0 + w, y0 + h - 6);
          ctx.lineTo(x0 + w - 6, y0 + h);
          ctx.lineTo(x0, y0 + h);
          ctx.closePath();
          ctx.clip();

          ctx.fillStyle = `${track.color}1f`;
          ctx.fillRect(x0, y0, w, h);

          // Waveform mini di dalam clip (design: tinggi 12px, bottom 4px,
          // opacity .55). Stride mengikuti speed_ratio (docs/08).
          const inner = Math.max(1, Math.floor(w - 8));
          const asset = project.assets.find((a) => a.id === clip.assetId);
          if (asset !== undefined && inner > 2) {
            if (peakBuf.current.length < inner * 2) peakBuf.current = new Float32Array(inner * 2);
            readPeaks(
              getPeakPyramid(asset),
              live?.kind === 'trim-start' ? clip.sourceStart + (pos - clip.timelinePos) : clip.sourceStart,
              live?.lenSamples ?? clip.sourceLen,
              inner,
              peakBuf.current,
            );
            ctx.globalAlpha = 0.55;
            ctx.fillStyle = track.color;
            const waveH = 12;
            const waveBottom = y0 + h - 4;
            for (let px = 0; px < inner; px++) {
              const amp = Math.max(
                Math.abs(peakBuf.current[px * 2]!),
                Math.abs(peakBuf.current[px * 2 + 1]!),
              );
              const bh = Math.max(1, amp * waveH);
              ctx.fillRect(x0 + 4 + px, waveBottom - bh, 1, bh);
            }
            ctx.globalAlpha = 1;
          }

          // Fade in/out sebagai segitiga gelap — design tidak menggambarnya
          // (mock-nya tidak punya fade), tapi model punya dan menyembunyikannya
          // berarti user tidak bisa melihat hasil tombol FADE IN.
          const fadeInPx = (clip.fadeIn.lengthSamples * view.pxPerSample) / clip.speedRatio;
          if (fadeInPx > 1) {
            ctx.fillStyle = '#050505cc';
            ctx.beginPath();
            ctx.moveTo(x0, y0);
            ctx.lineTo(x0 + fadeInPx, y0);
            ctx.lineTo(x0, y0 + h);
            ctx.closePath();
            ctx.fill();
          }

          ctx.restore();

          ctx.strokeStyle = track.color;
          ctx.lineWidth = isSel ? 2 : 1;
          ctx.beginPath();
          ctx.moveTo(x0 + 0.5, y0 + 0.5);
          ctx.lineTo(x0 + w - 0.5, y0 + 0.5);
          ctx.lineTo(x0 + w - 0.5, y0 + h - 6.5);
          ctx.lineTo(x0 + w - 6.5, y0 + h - 0.5);
          ctx.lineTo(x0 + 0.5, y0 + h - 0.5);
          ctx.closePath();
          ctx.stroke();

          ctx.fillStyle = track.color;
          // `ctx.font` diurai sebagai CSS font shorthand yang berdiri sendiri —
          // ia TIDAK bisa mengurai `var(...)`, dan nilai yang gagal diurai
          // dibuang diam-diam sehingga label clip jatuh ke 10px sans-serif
          // bawaan. Jadi stack font-nya ditulis literal di sini.
          ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
          ctx.textBaseline = 'top';
          ctx.save();
          ctx.beginPath();
          ctx.rect(x0, y0, w, h);
          ctx.clip();
          ctx.fillText(clip.name, x0 + 6, y0 + 4);
          ctx.restore();
        }
      });
    },
    [project.tracks, project.assets, view.startSample, view.pxPerSample, selected, tempo, viewport.widthPx],
  );

  // Playhead 60 Hz di overlay — tidak pernah menyentuh React state.
  useMeterFrame((frame) => {
    const o = getOverlay();
    if (o === null) return;
    // Overlay ini dipakai bergantian oleh playhead (60 Hz) dan ghost drag.
    // Selama drag berlangsung, loop meter TIDAK boleh menyentuhnya — kalau
    // tidak, `clearRect` di bawah menghapus ghost segera setelah `onMove`
    // menggambarnya dan ghost-nya berkedip lalu hilang.
    if (drag.current !== null) return;
    const { ctx, size } = o;
    ctx.clearRect(0, 0, size.width, size.height);
    const x = Math.round(sampleToPx(frame.transport.playhead, view)) + 0.5;
    if (x >= 0 && x <= size.width) {
      ctx.fillStyle = '#fff';
      ctx.shadowColor = '#ffffffaa';
      ctx.shadowBlur = 8;
      ctx.fillRect(x - 0.5, 0, 1, size.height);
      ctx.shadowBlur = 0;
    }
  });

  const beginDrag = useCallback(
    (ctx: DragContext): DragState | null => {
      const hit = hitTest(project.tracks, ctx.x, ctx.y, view);
      if (hit === null) {
        uiActions.selectClips([]);
        return null;
      }
      uiActions.selectClips([hit.clip.id]);
      uiActions.selectTrack(hit.trackId);
      const st: DragState = {
        kind: hit.kind,
        clip: hit.clip,
        trackId: hit.trackId,
        posSamples: hit.clip.timelinePos,
        lenSamples: hit.clip.sourceLen,
        fadeSamples: hit.kind === 'fade-out' ? hit.clip.fadeOut.lengthSamples : hit.clip.fadeIn.lengthSamples,
      };
      drag.current = st;
      return st;
    },
    // `view` sengaja dibaca dari closure terbaru tiap render — nilainya kecil
    // dan berubah bersama zoom.
    [project.tracks, view.startSample, view.pxPerSample],
  );

  const timelineDrag = useDrag<DragState | null>({
    onStart: beginDrag,
    onMove: (ctx, st) => {
      if (st === null) return;
      const deltaSamples = ctx.dx / view.pxPerSample;
      const snap = (v: number): number => snapSample(v, grid, tempo, snapEnabled, ctx.altKey);
      if (st.kind === 'move') {
        st.posSamples = Math.max(0, snap(st.clip.timelinePos + deltaSamples));
      } else if (st.kind === 'trim-start') {
        const p = Math.max(0, snap(st.clip.timelinePos + deltaSamples));
        const maxP = st.clip.timelinePos + st.clip.sourceLen / st.clip.speedRatio - 1;
        st.posSamples = Math.min(p, maxP);
        st.lenSamples = st.clip.sourceLen - (st.posSamples - st.clip.timelinePos) * st.clip.speedRatio;
      } else if (st.kind === 'trim-end') {
        const end = snap(st.clip.timelinePos + st.clip.sourceLen / st.clip.speedRatio + deltaSamples);
        st.lenSamples = Math.max(1, (end - st.clip.timelinePos) * st.clip.speedRatio);
      } else {
        st.fadeSamples = Math.max(0, st.fadeSamples + deltaSamples * st.clip.speedRatio);
      }
      // Ghost: canvas overlay, bukan React state (docs/06 §Drag preview).
      const o = getOverlay();
      if (o !== null) {
        const { ctx: c, size } = o;
        // Tanpa clear, setiap pointermove meninggalkan kotak putus-putus
        // sebelumnya — satu drag pendek menghasilkan puluhan ghost menumpuk.
        c.clearRect(0, 0, size.width, size.height);
        const row = project.tracks.findIndex((t) => t.id === st.trackId);
        const x0 = sampleToPx(st.posSamples, view);
        const x1 = sampleToPx(st.posSamples + st.lenSamples / st.clip.speedRatio, view);
        c.strokeStyle = '#ffd400';
        c.setLineDash([4, 3]);
        c.strokeRect(x0 + 0.5, row * LANE_H + CLIP_INSET + 0.5, x1 - x0, LANE_H - CLIP_INSET * 2 - 1);
        c.setLineDash([]);
      }
    },
    onEnd: (_ctx, st) => {
      if (st === null) return;
      // SATU command per gerakan (docs/08 §8a) — bukan satu per pointermove.
      if (st.kind === 'move') {
        cmd.moveClip(st.clip.id, st.posSamples);
      } else if (st.kind === 'trim-start') {
        cmd.trimClip(st.clip.id, 'start', st.posSamples);
      } else if (st.kind === 'trim-end') {
        cmd.trimClip(st.clip.id, 'end', st.clip.timelinePos + st.lenSamples / st.clip.speedRatio);
      } else {
        cmd.setClipFade(st.clip.id, st.kind === 'fade-in' ? 'in' : 'out', st.fadeSamples);
      }
      drag.current = null;
      // Tanpa engine, loop meter tidak jalan dan tidak ada yang membersihkan
      // overlay — ghost terakhir akan menempel permanen setelah drag selesai.
      const o = getOverlay();
      if (o !== null) o.ctx.clearRect(0, 0, o.size.width, o.size.height);
      forceRedraw((n) => n + 1);
    },
  });

  // `widthPx` di store adalah lebar lane yang dipakai untuk label ruler dan
  // konversi sample↔pixel. Sebelumnya ia diukur di dalam ref callback inline,
  // yang HANYA berjalan saat komponen render ulang — jadi mengubah ukuran
  // jendela (atau membuka panel lain yang menggeser layout) tidak pernah
  // memperbaruinya dan ruler memakai lebar basi. ResizeObserver mengukurnya
  // saat elemen benar-benar berubah ukuran.
  const laneBoxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = laneBoxRef.current;
    if (el === null) return;
    const sync = (): void => {
      const w = el.clientWidth;
      if (w > 0 && w !== uiStore.getState().viewport.widthPx) {
        uiActions.setViewport({ widthPx: w });
      }
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const laneHeight = Math.max(LANE_H, project.tracks.length * LANE_H);
  const barsVisible = 8;
  const rulerLabels = Array.from({ length: barsVisible }, (_, i) => {
    const sample = view.startSample + (i * viewport.widthPx) / barsVisible / view.pxPerSample;
    return Math.floor(sample / samplesPerBar(tempo)) + 1;
  });

  return (
    <Card
      title="Arrangement / Timeline"
      subtitle={`${project.tracks.length} tracks · 32 bars`}
      notched
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `${HEADER_W}px minmax(0,1fr)`,
          border: '1px solid var(--cy-border)',
          background: '#000',
        }}
      >
        <div
          style={{
            borderRight: '1px solid var(--cy-border)',
            borderBottom: '1px solid var(--cy-border)',
            height: `${RULER_H}px`,
            display: 'flex',
            alignItems: 'center',
            padding: '0 12px',
            fontSize: '10px',
            letterSpacing: '.18em',
            color: 'var(--cy-text-muted)',
            textTransform: 'uppercase',
          }}
        >
          Tracks
        </div>
        <div
          style={{
            position: 'relative',
            height: `${RULER_H}px`,
            borderBottom: '1px solid var(--cy-border)',
            display: 'flex',
          }}
        >
          {rulerLabels.map((label, i) => (
            <div
              key={i}
              style={{
                flex: 1,
                borderLeft: '1px solid var(--cy-border)',
                fontSize: '10px',
                color: 'var(--cy-text-muted)',
                padding: '6px 0 0 6px',
                letterSpacing: '.12em',
              }}
            >
              {label}
            </div>
          ))}
        </div>

        {/* Kolom header: DOM. */}
        <div style={{ borderRight: '1px solid var(--cy-border)' }}>
          {project.tracks.map((track) => (
            <TrackHeader key={track.id} track={track} selected={track.id === selectedTrackId} />
          ))}
        </div>

        {/* Lane: satu canvas untuk semua track + overlay ghost/playhead. */}
        <div
          {...timelineDrag}
          ref={laneBoxRef}
          style={{ position: 'relative', height: `${laneHeight}px`, touchAction: 'none', cursor: 'grab' }}
        >
          <canvas ref={laneRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
          <canvas
            ref={overlayRef}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
          />
        </div>
      </div>

      <div style={{ display: 'flex', gap: '10px', marginTop: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
        <Badge tone="accent">SNAP {grid === 'off' ? 'OFF' : (grid as GridDivision).toUpperCase()}</Badge>
        <Badge tone="default">GRID: BARS</Badge>
        <Badge tone="default">
          SELECTED: {selectedClipIds.length === 0 ? '—' : selectedClipIds.join(', ')}
        </Badge>
        <span style={{ marginLeft: 'auto', fontSize: '11px', color: 'var(--cy-text-dim)' }}>
          DRAG TO MOVE · ALT-DRAG TO IGNORE SNAP · EDGES TO TRIM
        </span>
      </div>
    </Card>
  );
}

/** Baris header track — bagian DOM dari arrangement. Disendirikan supaya satu
 *  perubahan mute hanya me-render satu baris, bukan seluruh timeline. */
function TrackHeader({ track, selected }: { readonly track: Track; readonly selected: boolean }): JSX.Element {
  const cmd = useEngineCommands();
  return (
    <div
      className="cy-hover-surface-2"
      onClick={() => uiActions.selectTrack(track.id)}
      style={{
        borderBottom: '1px solid var(--cy-border)',
        padding: '10px 12px',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        background: selected ? 'var(--cy-surface-2)' : 'var(--cy-surface-1)',
        cursor: 'pointer',
        height: `${LANE_H}px`,
        boxSizing: 'border-box',
      }}
    >
      <div style={{ width: '3px', height: '30px', background: track.color }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: '12px',
            color: 'var(--cy-text)',
            letterSpacing: '.08em',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {track.name}
        </div>
        <div style={{ fontSize: '9px', color: 'var(--cy-text-muted)', letterSpacing: '.18em', marginTop: '3px' }}>
          {track.kind}
        </div>
      </div>
      <div style={{ display: 'flex', gap: '4px' }}>
        <ToggleCell
          label="M"
          on={track.mute}
          onColor="#ff4d4d"
          onClick={() => cmd.setMute(track.id, !track.mute)}
        />
        <ToggleCell
          label="S"
          on={track.solo}
          onColor="var(--cy-accent)"
          onClick={() => cmd.setSolo(track.id, !track.solo)}
        />
      </div>
    </div>
  );
}

export function ToggleCell({
  label,
  on,
  onColor,
  onClick,
  width = 20,
}: {
  readonly label: string;
  readonly on: boolean;
  readonly onColor: string;
  readonly onClick: () => void;
  readonly width?: number;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={on}
      className="cy-btn-reset cy-focusable"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{
        width: `${width}px`,
        height: '20px',
        border: '1px solid var(--cy-border-strong)',
        display: 'grid',
        placeItems: 'center',
        fontSize: '9px',
        color: on ? onColor : 'var(--cy-text-dim)',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}
