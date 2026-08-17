/**
 * Automation Lane — `span 4` di design, di atas Render / Bounce.
 *
 * Design: kotak 92px hitam, grid vertikal tiap 12.5%, kurva SVG `#ffb020` 2px,
 * dan 4 titik belah ketupat 9px (`transform: rotate(45deg)`). Bentuk kurvanya
 * disalin dari `autoPath` di design dan digambar sebagai kurva Bézier yang
 * sama, hanya lewat canvas.
 *
 * TODO(phase-2): otomasi belum ada di model (`daw-timeline` belum punya
 * `Automation { target, points }`, dan command AUTO_* belum ada opcode di
 * `audio/sab-layout.ts`). Titik di sini bisa di-drag dan bentuknya berubah,
 * tapi TIDAK ada yang dikirim ke engine — begitu model ada, `onEnd` mengirim
 * satu `Edit::MoveAutoPoint` (docs/08 §Automation Lane). Engine me-render
 * otomasi sebagai ramp segment, bukan event per sample.
 */

import { useRef, useState } from 'react';
import { Card } from '../cyber';
import { useCanvasDraw } from '../lib/canvas';
import { useDrag } from '../lib/drag';

const H = 92;

interface Point {
  /** 0..1 posisi horizontal. */
  readonly x: number;
  /** 0..1 dari atas. */
  readonly y: number;
}

/** Disalin dari `autoPoints` di design (x%, y%). */
const INITIAL: readonly Point[] = [
  { x: 0, y: 0.78 },
  { x: 0.35, y: 0.27 },
  { x: 0.65, y: 0.58 },
  { x: 1, y: 0.2 },
];

export function AutomationLane(): JSX.Element {
  const [points, setPoints] = useState<readonly Point[]>(INITIAL);
  const ref = useRef<HTMLCanvasElement>(null);
  const dragIndex = useRef(-1);

  useCanvasDraw(
    ref,
    (ctx, size) => {
      const { width, height } = size;

      ctx.fillStyle = '#161616';
      for (let i = 1; i < 8; i++) ctx.fillRect(Math.round((i * width) / 8), 0, 1, height);

      // Kurva halus melalui titik — bentuk yang sama dengan `autoPath` design
      // (`M0,70 C60,70 80,20 140,24 …`): Bézier kubik dengan kontrol horizontal.
      ctx.beginPath();
      points.forEach((p, i) => {
        const x = p.x * width;
        const y = p.y * height;
        if (i === 0) {
          ctx.moveTo(x, y);
          return;
        }
        const prev = points[i - 1]!;
        const px = prev.x * width;
        const py = prev.y * height;
        const cx = (x - px) * 0.5;
        ctx.bezierCurveTo(px + cx, py, x - cx, y, x, y);
      });
      ctx.strokeStyle = '#ffb020';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Titik belah ketupat 9px.
      ctx.fillStyle = '#ffb020';
      for (const p of points) {
        const x = p.x * width;
        const y = p.y * height;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(Math.PI / 4);
        ctx.fillRect(-4.5, -4.5, 9, 9);
        ctx.restore();
      }
    },
    [points],
  );

  const drag = useDrag<readonly Point[]>({
    onStart: (ctx) => {
      let best = -1;
      let bestDist = 12;
      points.forEach((p, i) => {
        const d = Math.hypot(ctx.x - p.x * ctx.rect.width, ctx.y - p.y * ctx.rect.height);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      });
      dragIndex.current = best;
      return points;
    },
    onMove: (ctx, start) => {
      const i = dragIndex.current;
      if (i < 0) return;
      const x = Math.max(0, Math.min(1, ctx.x / ctx.rect.width));
      const y = Math.max(0, Math.min(1, ctx.y / ctx.rect.height));
      setPoints(start.map((p, k) => (k === i ? { x, y } : p)));
    },
    onEnd: () => {
      dragIndex.current = -1;
    },
  });

  return (
    <Card title="Automation Lane" subtitle="filter cutoff" notched>
      <div
        {...drag}
        style={{
          position: 'relative',
          height: `${H}px`,
          background: '#000',
          border: '1px solid var(--cy-border)',
          overflow: 'hidden',
          touchAction: 'none',
          cursor: 'crosshair',
        }}
      >
        <canvas ref={ref} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
      </div>
    </Card>
  );
}
