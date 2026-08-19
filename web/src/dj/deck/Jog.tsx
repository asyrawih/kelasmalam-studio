/**
 * Jog wheel: piringan, cincin posisi, dan BPM besar di tengah.
 *
 * Digambar di canvas, bukan disusun dari elemen: cincin posisi berputar terus
 * selama lagu berjalan, dan memutar elemen DOM 60×/detik untuk dua deck adalah
 * dua lapisan compositing yang tidak menghasilkan apa pun yang tidak bisa
 * digambar dengan satu `arc`.
 *
 * Menyeretnya menggeser posisi (scrub). Belum ada scratch — itu butuh resampler
 * AudioWorklet yang bisa membaca mundur, dan `AudioBufferSourceNode` tidak bisa.
 * Karena itu tarikan di sini adalah SCRUB, dan `title`-nya mengatakan begitu.
 */

import { useRef } from 'react';

import { useCanvasDraw } from '../../ui/lib/canvas';
import { useDrag } from '../../ui/lib/drag';
import type { DeckView } from '../deck-view';
import { type DeckId } from '../model';
import { djActions } from '../store';

/** Satu putaran penuh jog = sekian detik materi. Angka CDJ-ish, bukan spec. */
const SEC_PER_TURN = 8;

export interface JogProps {
  readonly view: DeckView;
  readonly id: DeckId;
  readonly accent: string;
  readonly size: number;
}

export function Jog({ view, id, accent, size }: JogProps): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  const { deck } = view;
  const progress = deck.frames > 0 ? deck.playhead / deck.frames : 0;

  useCanvasDraw(
    ref,
    (ctx, s) => {
      const cx = s.width / 2;
      const cy = s.height / 2;
      const r = Math.min(cx, cy) - 2;

      ctx.clearRect(0, 0, s.width, s.height);

      // Piringan.
      const g = ctx.createRadialGradient(cx, cy - r * 0.3, r * 0.1, cx, cy, r);
      g.addColorStop(0, '#1e1e1e');
      g.addColorStop(1, '#050505');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();

      // Canvas tidak bisa membaca custom property CSS dengan murah, jadi warna
      // border ditulis literal di sini — nilainya sama dengan --cy-border-strong.
      ctx.strokeStyle = '#4a4335';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Cincin posisi: satu putaran = seluruh lagu.
      ctx.strokeStyle = accent;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(cx, cy, r - 5, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
      ctx.stroke();

      // Penanda jarum, supaya putaran terbaca walau progresnya kecil.
      const a = -Math.PI / 2 + progress * Math.PI * 2;
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * (r - 14), cy + Math.sin(a) * (r - 14));
      ctx.lineTo(cx + Math.cos(a) * (r - 2), cy + Math.sin(a) * (r - 2));
      ctx.stroke();

      // Cincin dalam.
      ctx.strokeStyle = '#282520';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.55, 0, Math.PI * 2);
      ctx.stroke();
    },
    [progress, accent],
  );

  const drag = useDrag<number>({
    onStart: () => deck.playhead,
    onMove: (ctx, start) => {
      if (deck.assetId === null) return;
      // Tarik ke kanan = maju. Sumbu mendatar saja: memakai sudut sejati
      // membuat gerakan kecil di dekat pusat melompat jauh.
      const delta = (ctx.dx / Math.max(1, ctx.rect.width)) * SEC_PER_TURN * deck.sampleRate;
      djActions.seek(id, start + delta);
    },
  });

  return (
    <div
      {...drag}
      title="tarik mendatar untuk mencari posisi — scratch belum ada (butuh resampler AudioWorklet)"
      style={{
        position: 'relative',
        width: `${size}px`,
        height: `${size}px`,
        touchAction: 'none',
        cursor: deck.assetId === null ? 'default' : 'ew-resize',
        flexShrink: 0,
      }}
    >
      <canvas ref={ref} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          pointerEvents: 'none',
        }}
      >
        <div
          style={{
            fontFamily: 'var(--cy-font-sans)',
            fontSize: `${Math.round(size * 0.2)}px`,
            fontWeight: 700,
            color: view.effBpm === null ? 'var(--cy-text-muted)' : accent,
            fontVariantNumeric: 'tabular-nums',
            lineHeight: 1,
          }}
        >
          {view.effBpm === null ? '—' : view.effBpm.toFixed(1)}
        </div>
        <div style={{ fontSize: '9px', letterSpacing: '.16em', color: 'var(--cy-text-muted)' }}>
          BPM
        </div>
      </div>
    </div>
  );
}
