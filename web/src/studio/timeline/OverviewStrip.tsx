/**
 * Strip overview 30px: waveform mini seluruh project, kotak viewport yang
 * mencerminkan posisi & lebar scroll, dan playhead.
 *
 * Memakai PENGGAMBAR YANG SAMA dengan clip di timeline (`drawClipWave`), hanya
 * dengan viewport per-clip yang di-clip ke rentang waktunya. Versi lama
 * meringkas semuanya jadi 140 batang `max()` — cukup untuk orientasi, tapi
 * kehilangan seluruh dinamika justru di tempat user paling butuh melihat
 * "bagian mana yang keras".
 */

import { useRef } from 'react';
import { useStudio } from '../store';
import { useCanvasDraw } from '../../ui/lib/canvas';
import { BAND_COLORS, drawClipWave } from './waveform';

export interface OverviewStripProps {
  /** Posisi kiri viewport dalam persen. */
  readonly viewLeftPct: number;
  /** Lebar viewport dalam persen. */
  readonly viewWidthPct: number;
}

export function OverviewStrip({ viewLeftPct, viewWidthPct }: OverviewStripProps): JSX.Element {
  const lanes = useStudio((s) => s.lanes);
  const assets = useStudio((s) => s.assets);
  const duration = useStudio((s) => s.duration);
  const playhead = useStudio((s) => s.playhead);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  useCanvasDraw(
    canvasRef,
    (ctx, size) => {
      const span = duration > 0 ? duration : 1;
      for (const lane of lanes) {
        for (const clip of lane.clips) {
          const x = (clip.start / span) * size.width;
          const w = (clip.len / span) * size.width;
          // Clip selebar < 1 px tidak akan terlihat dan hanya membuang path.
          if (!(w > 0.5)) continue;
          ctx.save();
          ctx.beginPath();
          ctx.rect(x, 0, w, size.height);
          ctx.clip();
          ctx.translate(x, 0);
          drawClipWave(
            ctx,
            assets[clip.assetId],
            clip.sourceStart,
            clip.sourceLen,
            w,
            size.height,
            size.dpr,
            {
              // Sama dengan overview deck DJ: tiga pita frekuensi dengan
              // opacity badan yang cukup kuat untuk membaca struktur lagu.
              outline: '#ffd400',
              body: '#ffd400',
              outlineAlpha: 0.3,
              bodyAlpha: 0.92,
              centerLine: null,
              bands: BAND_COLORS,
            },
          );
          ctx.restore();
        }
      }
    },
    [lanes, assets, duration],
  );

  const span = duration > 0 ? duration : 1;
  const playPct = Math.max(0, Math.min(100, (playhead / span) * 100));

  return (
    <div data-tl-overview
      data-overview
      style={{
        position: 'relative',
        height: '30px',
        marginTop: '8px',
        background: '#000',
        border: '1px solid var(--cy-border)',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
      />
      <div
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: `${viewLeftPct}%`,
          width: `${viewWidthPct}%`,
          border: '1px solid var(--cy-accent)',
          background: '#ffd40014',
          boxSizing: 'border-box',
        }}
      />
      <div
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: `${playPct}%`,
          width: '1px',
          background: '#fff',
        }}
      />
    </div>
  );
}
