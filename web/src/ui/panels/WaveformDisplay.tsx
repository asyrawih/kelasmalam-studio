/**
 * Waveform Display — `grid-column: span 8` di design.
 *
 * Design menggambar 180 `<div>` ber-gradien. Di sini bentuk yang sama digambar
 * ke `<canvas>` (docs/08 §Waveform Display): gradien vertikal identik
 * (#ffb020 → #ffd400 di 50% → #ffb020), garis 0-crossing #ffd40024 setinggi
 * 0.8%, region seleksi #ffd4000f dengan garis batas #ffd40059, dan playhead
 * putih 1px + bendera 11×8 px di atasnya.
 *
 * Dua canvas bertumpuk, bukan satu: waveform hanya digambar ulang saat
 * viewport/seleksi/clip berubah, playhead digambar 60 Hz di canvas overlay.
 * Kalau digabung, setiap frame playhead memaksa menggambar ulang ribuan
 * segmen waveform.
 */

import { useMemo, useRef } from 'react';
import { Badge, Button, Card } from '../cyber';
import {
  useEngineCommands,
  useMeterFrame,
  useUiStore,
  type Clip,
  type Track,
} from '../../state';
import { useCanvasDraw, useOverlayContext } from '../lib/canvas';
import { getPeakPyramid, peakOf, readPeaks } from '../lib/peaks';
import { formatClock, formatClockMs } from '../lib/time';
import { useDrag } from '../lib/drag';
import { uiActions, uiStore } from '../../state/store';

/** Aksi presentasi murni — tidak menyentuh audio, jadi TIDAK lewat
 *  `useEngineCommands()`. Hook itu khusus mutasi project/engine. */
function setSelectionRange(startSample: number, endSample: number): void {
  uiActions.setTimeSelection({ startSample, endSample });
}

function zoomIn(): void {
  const { pxPerSample } = uiStore.getState().viewport;
  uiActions.setViewport({ pxPerSample: Math.min(pxPerSample * 2, 1) });
}

const HEIGHT = 150;

function findSelected(
  tracks: readonly Track[],
  clipId: number | undefined,
): { readonly track: Track; readonly clip: Clip } | null {
  for (const t of tracks) {
    for (const c of t.clips) {
      if (clipId === undefined || c.id === clipId) return { track: t, clip: c };
    }
  }
  return null;
}

export function WaveformDisplay(): JSX.Element {
  const cmd = useEngineCommands();
  const project = useUiStore((s) => s.project);
  const selectedId = useUiStore((s) => s.selectedClipIds[0]);
  const timeSelection = useUiStore((s) => s.timeSelection);

  const found = useMemo(() => findSelected(project.tracks, selectedId), [project.tracks, selectedId]);
  const asset = found === null ? undefined : project.assets.find((a) => a.id === found.clip.assetId);

  const waveRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const getOverlay = useOverlayContext(overlayRef);
  const peakBuf = useRef<Float32Array>(new Float32Array(0));

  const clipLenSamples = found?.clip.sourceLen ?? 0;
  const clipDurationSec = clipLenSamples / project.sampleRate;

  useCanvasDraw(
    waveRef,
    (ctx, size) => {
      const { width, height } = size;

      // Garis 0-crossing: di design ini gradien setinggi 0.8% di tengah.
      ctx.fillStyle = '#ffd40024';
      const lineH = Math.max(1, height * 0.008);
      ctx.fillRect(0, height / 2 - lineH / 2, width, lineH);

      if (found === null || asset === undefined) return;

      const inner = Math.max(0, Math.floor(width - 4)); // padding 0 2px seperti di design
      if (inner === 0) return;

      // Design menggambar BAR DISKRIT, bukan blok padat: `sc-for` 180 buah
      // <div style="flex:1;height:{b.h}%"> dengan `gap:1px` di parent flex yang
      // `align-items:center`. Menggambar satu kolom per pixel membuat bentuknya
      // menjadi siluet padat dan hilang karakter "bar"-nya, jadi di sini
      // geometrinya disalin: N bar dengan celah 1px, tinggi simetris di tengah.
      const GAP = 1;
      const bars = Math.max(1, Math.min(180, Math.floor((inner + GAP) / (1 + GAP))));
      const barW = (inner - (bars - 1) * GAP) / bars;

      if (peakBuf.current.length < bars * 2) peakBuf.current = new Float32Array(bars * 2);
      const peaks = peakBuf.current;
      readPeaks(getPeakPyramid(asset), found.clip.sourceStart, found.clip.sourceLen, bars, peaks);

      const grad = ctx.createLinearGradient(0, 0, 0, height);
      grad.addColorStop(0, '#ffb020');
      grad.addColorStop(0.5, '#ffd400');
      grad.addColorStop(1, '#ffb020');
      ctx.fillStyle = grad;
      ctx.globalAlpha = 0.9;
      for (let i = 0; i < bars; i++) {
        const lo = peaks[i * 2]!;
        const hi = peaks[i * 2 + 1]!;
        const amp = Math.max(Math.abs(lo), Math.abs(hi));
        // `height:{b.h}%` + align-items:center => bar simetris terhadap sumbu 0.
        const h = Math.max(1, Math.min(1, amp) * height);
        ctx.fillRect(2 + i * (barW + GAP), (height - h) / 2, barW, h);
      }
      ctx.globalAlpha = 1;

      // Region seleksi (design: left 34%, width 22%).
      if (timeSelection !== null && clipLenSamples > 0) {
        const x0 = ((timeSelection.startSample - found.clip.timelinePos) / clipLenSamples) * width;
        const x1 = ((timeSelection.endSample - found.clip.timelinePos) / clipLenSamples) * width;
        ctx.fillStyle = '#ffd4000f';
        ctx.fillRect(x0, 0, x1 - x0, height);
        ctx.strokeStyle = '#ffd40059';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x0 + 0.5, 0);
        ctx.lineTo(x0 + 0.5, height);
        ctx.moveTo(x1 - 0.5, 0);
        ctx.lineTo(x1 - 0.5, height);
        ctx.stroke();
      }
    },
    [found?.clip, asset, timeSelection, clipLenSamples],
  );

  // Playhead: 60 Hz, canvas terpisah, tanpa React state.
  useMeterFrame((frame) => {
    const o = getOverlay();
    if (o === null) return;
    const { ctx, size } = o;
    // Membersihkan HARUS terjadi sebelum semua bail-out: kalau tidak, playhead
    // yang keluar dari clip (atau clip yang dilepas seleksinya) meninggalkan
    // garis putih yang menempel permanen di layar.
    ctx.clearRect(0, 0, size.width, size.height);
    if (found === null || clipLenSamples <= 0) return;
    const rel = (frame.transport.playhead - found.clip.timelinePos) / clipLenSamples;
    if (rel < 0 || rel > 1) return;
    const x = Math.round(rel * size.width) + 0.5;
    ctx.fillStyle = '#fff';
    ctx.shadowColor = '#ffffffaa';
    ctx.shadowBlur = 10;
    ctx.fillRect(x - 0.5, 0, 1, size.height);
    ctx.shadowBlur = 0;
    ctx.fillRect(x - 5.5, 0, 11, 8); // bendera 11×8 seperti di design
  });

  // Drag seleksi waktu di atas waveform.
  const selectionDrag = useDrag<number>({
    onStart: (ctx) => (found === null ? 0 : found.clip.timelinePos + (ctx.x / ctx.rect.width) * clipLenSamples),
    onMove: (ctx, start) => {
      if (found === null) return;
      const here = found.clip.timelinePos + (ctx.x / ctx.rect.width) * clipLenSamples;
      // Live: hanya state UI (seleksi bukan parameter audio), jadi tidak ada
      // yang ditulis ke param block di sini.
      setSelectionRange(Math.min(start, here), Math.max(start, here));
    },
  });

  const selSec =
    timeSelection === null
      ? null
      : {
          start: timeSelection.startSample / project.sampleRate,
          end: timeSelection.endSample / project.sampleRate,
        };

  const title = found === null ? 'no clip selected' : `${found.clip.name} · ${found.track.name}`;

  return (
    <Card title="Waveform Display" subtitle={title} notched live>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: '10px',
          letterSpacing: '.16em',
          color: 'var(--cy-text-muted)',
          textTransform: 'uppercase',
          marginBottom: '8px',
        }}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <span key={f}>{formatClock(clipDurationSec * f)}</span>
        ))}
      </div>

      <div
        {...selectionDrag}
        style={{
          position: 'relative',
          height: `${HEIGHT}px`,
          background: '#000',
          border: '1px solid var(--cy-border)',
          overflow: 'hidden',
          cursor: 'text',
          touchAction: 'none',
        }}
      >
        <canvas ref={waveRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
        <canvas
          ref={overlayRef}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
        />
      </div>

      <div style={{ display: 'flex', gap: '10px', marginTop: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
        <Button
          size="sm"
          variant="outline"
          onClick={() => zoomIn()}
        >
          ZOOM
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={found === null}
          onClick={() => {
            if (found !== null) cmd.setClipFade(found.clip.id, 'in', Math.round(project.sampleRate * 0.25));
          }}
        >
          FADE IN
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={found === null || asset === undefined}
          onClick={() => {
            if (found === null || asset === undefined) return;
            const peak = peakOf(getPeakPyramid(asset), found.clip.sourceStart, found.clip.sourceLen);
            cmd.normalizeClip(found.clip.id, peak);
          }}
        >
          NORMALIZE
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled
          title="REVERSE butuh Clip.reversed di daw-timeline (docs/08 §Waveform Display) — belum ada di model."
        >
          REVERSE
        </Button>
        <span style={{ marginLeft: 'auto', fontSize: '11px', color: 'var(--cy-text-dim)' }}>
          {selSec === null ? (
            <Badge tone="default">NO SELECTION</Badge>
          ) : (
            `SEL ${formatClockMs(selSec.start)} → ${formatClockMs(selSec.end)} · ${(selSec.end - selSec.start).toFixed(3)} s`
          )}
        </span>
      </div>
    </Card>
  );
}
