/**
 * Waveform SELURUH lagu + penanda cue dan loop + posisi sekarang.
 *
 * Memakai `drawAssetWave` — penggambar yang SAMA dengan timeline Studio — bukan
 * penggambar kedua. Waveform yang berubah bentuk hanya karena dilihat dari
 * halaman lain adalah cacat yang mustahil dilacak dari layar; alasan yang sama
 * sudah ditulis panjang di kepala `studio/timeline/waveform.ts`.
 *
 * `OverviewStrip.tsx` milik Studio TIDAK dipakai: ia membaca `studioStore`
 * secara langsung dan menggambar lane, bukan satu lagu.
 */

import { useRef } from 'react';

import { useCanvasDraw } from '../../ui/lib/canvas';
import { BAND_COLORS, drawAssetWave, drawPlaceholderWave } from '../../studio/timeline/waveform';
import type { DeckView } from '../deck-view';
import { HOT_CUE_SLOTS, type DeckId, type TrackCues } from '../model';
import { djActions } from '../store';

export interface DeckOverviewProps {
  readonly view: DeckView;
  readonly cues: TrackCues;
  readonly id: DeckId;
  readonly accent: string;
  readonly height: number;
}

export function DeckOverview({ view, cues, id, accent, height }: DeckOverviewProps): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  const { deck, asset } = view;
  const frames = Math.max(1, deck.frames);

  useCanvasDraw(
    ref,
    (ctx, s) => {
      if (asset === undefined) {
        drawPlaceholderWave(ctx, s.width, s.height, accent);
        return;
      }

      // Berwarna per pita, sama seperti jendela besar. Di strip seluruh lagu
      // inilah warna paling berguna: intro tanpa kick, breakdown, dan drop
      // terbaca sebagai BLOK warna sebelum satu detik pun diputar — yang tidak
      // bisa dilakukan siluet amber, karena ketiganya sama-sama "agak keras".
      drawAssetWave(ctx, asset, 0, frames, s.width, s.height, s.dpr, {
        outline: accent,
        body: accent,
        outlineAlpha: 0.3,
        bodyAlpha: 0.92,
        centerLine: null,
        bands: BAND_COLORS,
      });

      const x = (at: number): number => (at / frames) * s.width;

      // Loop: bidang dulu, garis batas belakangan, supaya batasnya tetap
      // terbaca sebagai garis dan tidak tertutup bidangnya sendiri.
      if (deck.loop.inAt !== null && deck.loop.outAt !== null) {
        const lx = x(deck.loop.inAt);
        const lw = Math.max(1, x(deck.loop.outAt) - lx);
        ctx.fillStyle = deck.loop.active ? `${accent}30` : `${accent}14`;
        ctx.fillRect(lx, 0, lw, s.height);
      }

      // Hot cue: pita tipis berwarna slot-nya. Warna berbeda per slot memang
      // seluruh gunanya — dikenali dari sudut mata, bukan dibaca.
      for (const slot of HOT_CUE_SLOTS) {
        const cue = cues.hotCues[slot];
        if (cue === null) continue;
        ctx.fillStyle = cue.color;
        ctx.fillRect(Math.round(x(cue.at)), 0, 2, s.height);
        ctx.fillStyle = cue.color;
        ctx.font = '8px monospace';
        ctx.textBaseline = 'top';
        ctx.fillText(slot, Math.round(x(cue.at)) + 3, 1);
      }

      // Cue point utama.
      ctx.fillStyle = '#ff4d4d';
      ctx.fillRect(Math.round(x(cues.cuePoint)), 0, 1, s.height);

      // Posisi sekarang, digambar TERAKHIR supaya tidak pernah tertutup.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(Math.round(x(deck.playhead)), 0, 1, s.height);
    },
    [asset, frames, deck.playhead, deck.loop, cues, accent],
  );

  return (
    <div
      onPointerDown={(e) => {
        if (deck.assetId === null) return;
        const rect = e.currentTarget.getBoundingClientRect();
        if (rect.width <= 0) return;
        djActions.seek(id, ((e.clientX - rect.left) / rect.width) * frames);
      }}
      title="klik untuk melompat ke posisi mana pun di lagu"
      style={{
        position: 'relative',
        height: `${height}px`,
        background: 'var(--cy-surface-1)',
        border: '1px solid var(--cy-border)',
        cursor: deck.assetId === null ? 'default' : 'pointer',
        touchAction: 'none',
      }}
    >
      <canvas ref={ref} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
    </div>
  );
}
