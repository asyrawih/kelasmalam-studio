/**
 * Clip Thumbnail — Card kecil di kolom kanan design, di atas Master Meter.
 *
 * Design: kotak hitam 56px berisi ~60 bar #ffd400 opacity .75, lalu baris
 * nama file di kiri dan durasi berwarna aksen di kanan. Bar-nya digambar ke
 * canvas dari level pyramid tertinggi (docs/08 §Clip Thumbnail).
 */

import { useMemo, useRef } from 'react';
import { Card } from '../cyber';
import { useUiStore } from '../../state';
import { useCanvasDraw } from '../lib/canvas';
import { getPeakPyramid, readPeaks } from '../lib/peaks';

export function ClipThumbnail(): JSX.Element {
  const project = useUiStore((s) => s.project);
  const selectedId = useUiStore((s) => s.selectedClipIds[0]);

  const found = useMemo(() => {
    for (const t of project.tracks) {
      for (const c of t.clips) if (selectedId === undefined || c.id === selectedId) return c;
    }
    return null;
  }, [project.tracks, selectedId]);

  const asset = found === null ? undefined : project.assets.find((a) => a.id === found.assetId);
  const ref = useRef<HTMLCanvasElement>(null);
  const buf = useRef<Float32Array>(new Float32Array(0));

  useCanvasDraw(
    ref,
    (ctx, size) => {
      if (found === null || asset === undefined) return;
      const gap = 1;
      // 60 bar (`hint-placeholder-count="60"` di design) hanya muat kalau
      // kartunya cukup lebar. Di kolom sempit `barW` jadi 0 atau NEGATIF, dan
      // fillRect dengan lebar negatif menggambar ke arah berlawanan sehingga
      // bar-bar-nya saling tumpuk jadi blok padat. Kurangi jumlah bar sebagai
      // gantinya.
      const usable = size.width - 6;
      const bars = Math.max(1, Math.min(60, Math.floor((usable + gap) / (1 + gap))));
      const barW = (usable - (bars - 1) * gap) / bars;
      if (barW <= 0) return;
      if (buf.current.length < bars * 2) buf.current = new Float32Array(bars * 2);
      readPeaks(getPeakPyramid(asset), found.sourceStart, found.sourceLen, bars, buf.current);
      ctx.fillStyle = '#ffd400';
      ctx.globalAlpha = 0.75;
      for (let i = 0; i < bars; i++) {
        const amp = Math.max(Math.abs(buf.current[i * 2]!), Math.abs(buf.current[i * 2 + 1]!));
        const h = Math.max(2, amp * size.height);
        ctx.fillRect(3 + i * (barW + gap), (size.height - h) / 2, barW, h);
      }
      ctx.globalAlpha = 1;
    },
    [found, asset],
  );

  const seconds = found === null ? 0 : found.sourceLen / project.sampleRate;

  return (
    <Card title="Clip Thumbnail" notched>
      <canvas
        ref={ref}
        style={{
          display: 'block',
          height: '56px',
          width: '100%',
          background: '#000',
          border: '1px solid var(--cy-border)',
          boxSizing: 'border-box',
        }}
      />
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginTop: '10px',
          fontSize: '11px',
          color: 'var(--cy-text-dim)',
        }}
      >
        <span>{asset?.name ?? '—'}</span>
        <span style={{ color: 'var(--cy-accent)' }}>{seconds.toFixed(2)} s</span>
      </div>
    </Card>
  );
}
