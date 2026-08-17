/**
 * Master Meter — Card kecil di kolom kanan design (`span 4`).
 *
 * Design: dua baris L/R, masing-masing label 14px, bar setinggi 12px dengan
 * gradien `linear-gradient(90deg,#ffd400,#ffb020 78%,#ff4d4d)`, dan nilai dB
 * rata kanan selebar 52px; di bawahnya skala -60/-24/-12/-6/0.
 *
 * Bar-nya canvas dan label dB-nya ditulis lewat `textContent` dari rAF
 * bersama. Tidak ada `setState` sama sekali di panel ini — kalau ada, seluruh
 * kolom kanan me-render 60×/detik.
 *
 * Ballistics (attack instan, release 20 dB/detik berbasis waktu) hidup di
 * `useMeterFrame`, bukan di sini — supaya semua meter di aplikasi jatuh dengan
 * laju yang sama (docs/05 §Tab throttling).
 */

import { useRef } from 'react';
import { Card } from '../cyber';
import { MASTER_METER_INDEX, useMeterFrame } from '../../state';
import { dbToNorm } from '../../state/useMeterFrame';
import { formatDb } from '../../state/gain';

function MeterRow({ label, channel }: { readonly label: string; readonly channel: 0 | 1 }): JSX.Element {
  const barRef = useRef<HTMLCanvasElement>(null);
  const dbRef = useRef<HTMLSpanElement>(null);
  /** Di-cache per lebar canvas — jangan alokasi per frame (docs/08). */
  const grad = useRef<{ w: number; value: CanvasGradient } | null>(null);

  useMeterFrame((frame) => {
    const canvas = barRef.current;
    const db = frame.displayDb[MASTER_METER_INDEX * 2 + channel] ?? -100;

    const text = dbRef.current;
    if (text !== null) {
      const s = `${formatDb(db)} dB`;
      if (text.textContent !== s) text.textContent = s;
    }

    if (canvas === null) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      grad.current = null;
    }
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (grad.current === null || grad.current.w !== w) {
      const g = ctx.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, '#ffd400');
      g.addColorStop(0.78, '#ffb020');
      g.addColorStop(1, '#ff4d4d');
      grad.current = { w, value: g };
    }
    ctx.fillStyle = grad.current.value;
    ctx.fillRect(0, 0, dbToNorm(db) * w, h);
  });

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
      <span style={{ fontSize: '11px', color: 'var(--cy-text-muted)', width: '14px' }}>{label}</span>
      <canvas
        ref={barRef}
        style={{
          flex: 1,
          height: '12px',
          background: '#000',
          border: '1px solid var(--cy-border)',
          boxSizing: 'border-box',
        }}
      />
      <span
        ref={dbRef}
        style={{
          fontSize: '11px',
          color: 'var(--cy-text-dim)',
          width: '52px',
          textAlign: 'right',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        -inf dB
      </span>
    </div>
  );
}

export function MasterMeter(): JSX.Element {
  return (
    <Card title="Master Meter" notched>
      <div style={{ display: 'grid', gap: '10px', paddingTop: '2px' }}>
        <MeterRow label="L" channel={0} />
        <MeterRow label="R" channel={1} />
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: '10px',
            color: 'var(--cy-text-muted)',
            letterSpacing: '.14em',
          }}
        >
          <span>-60</span>
          <span>-24</span>
          <span>-12</span>
          <span>-6</span>
          <span>0</span>
        </div>
      </div>
    </Card>
  );
}
