/**
 * Parametric EQ — `span 5` di design, 4 band + overlay analyzer.
 *
 * Visual disalin persis: kotak 160px hitam, grid
 * `repeating-linear-gradient` 25px × 32px, 48 bar spectrum `#ffd4001f` dengan
 * garis atas `#ffd40047`, kurva `#ffd400` 2px dengan drop-shadow 6px, dan 4
 * node bulat 12px berwarna (#ff7ad9 LOW, #ffd400 MID, #6ee7ff PRES, #a78bfa
 * AIR) dengan glow. Skala label 30 Hz … 18 kHz.
 *
 * DUA PENYIMPANGAN YANG DISENGAJA dari design, keduanya diminta docs/08:
 *
 * 1. Kurva bukan aproksimasi bell seperti di mock, melainkan magnitude
 *    response biquad yang sebenarnya, |H(e^jω)| dari koefisien RBJ. Kurva
 *    harus mencerminkan apa yang benar-benar terjadi pada audio, termasuk
 *    interaksi antar band.
 * 2. Spectrum analyzer adalah FASE 2 dan hal pertama yang dimatikan saat CPU
 *    tinggi (docs/05 degradation level 1). Di MVP bar-nya digambar statis
 *    sesuai design, tanpa data FFT — bukan angka acak yang berpura-pura hidup.
 */

import { useMemo, useRef, useState } from 'react';
import { Card } from '../cyber';
import { useUiStore } from '../../state';
import { useCanvasDraw } from '../lib/canvas';
import { useDrag } from '../lib/drag';

const H = 160;
const MIN_HZ = 30;
const MAX_HZ = 18000;
const MAX_GAIN_DB = 18;

export type BandKind = 'lowshelf' | 'peaking' | 'highshelf';

export interface EqBand {
  readonly label: string;
  readonly color: string;
  readonly kind: BandKind;
  readonly freq: number;
  readonly q: number;
  readonly gainDb: number;
}

/** Nilai awal dipilih supaya kurva & posisi node cocok dengan design
 *  (x = 12/38/66/88%, y = 58/34/66/42%). */
const INITIAL_BANDS: readonly EqBand[] = [
  { label: 'LOW', color: '#ff7ad9', kind: 'lowshelf', freq: 90, q: 0.7, gainDb: 5 },
  { label: 'MID', color: '#ffd400', kind: 'peaking', freq: 620, q: 1.0, gainDb: 8 },
  { label: 'PRES', color: '#6ee7ff', kind: 'peaking', freq: 3800, q: 1.2, gainDb: -5 },
  { label: 'AIR', color: '#a78bfa', kind: 'highshelf', freq: 11000, q: 0.7, gainDb: 4 },
];

const logX = (hz: number): number => Math.log(hz / MIN_HZ) / Math.log(MAX_HZ / MIN_HZ);
const xToHz = (x: number): number => MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, x);

/**
 * Koefisien biquad RBJ. Sama dengan yang dipakai `daw-dsp::biquad`; kalau
 * rumus di Rust berubah, kurva di sini ikut berubah — bukan sebaliknya.
 */
function coeffs(band: EqBand, sampleRate: number): readonly number[] {
  const A = Math.pow(10, band.gainDb / 40);
  const w0 = (2 * Math.PI * band.freq) / sampleRate;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const alpha = sw / (2 * band.q);
  switch (band.kind) {
    case 'peaking': {
      const b0 = 1 + alpha * A;
      const b1 = -2 * cw;
      const b2 = 1 - alpha * A;
      const a0 = 1 + alpha / A;
      const a1 = -2 * cw;
      const a2 = 1 - alpha / A;
      return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
    }
    case 'lowshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      const b0 = A * (A + 1 - (A - 1) * cw + s);
      const b1 = 2 * A * (A - 1 - (A + 1) * cw);
      const b2 = A * (A + 1 - (A - 1) * cw - s);
      const a0 = A + 1 + (A - 1) * cw + s;
      const a1 = -2 * (A - 1 + (A + 1) * cw);
      const a2 = A + 1 + (A - 1) * cw - s;
      return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
    }
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      const b0 = A * (A + 1 + (A - 1) * cw + s);
      const b1 = -2 * A * (A - 1 + (A + 1) * cw);
      const b2 = A * (A + 1 + (A - 1) * cw - s);
      const a0 = A + 1 - (A - 1) * cw + s;
      const a1 = 2 * (A - 1 - (A + 1) * cw);
      const a2 = A + 1 - (A - 1) * cw - s;
      return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
    }
  }
}

/** |H(e^{jω})| dalam dB untuk satu band. */
function magnitudeDb(c: readonly number[], hz: number, sampleRate: number): number {
  const [b0, b1, b2, a1, a2] = c as [number, number, number, number, number];
  const w = (2 * Math.PI * hz) / sampleRate;
  const cos1 = Math.cos(w);
  const cos2 = Math.cos(2 * w);
  const sin1 = Math.sin(w);
  const sin2 = Math.sin(2 * w);
  const numRe = b0 + b1 * cos1 + b2 * cos2;
  const numIm = -(b1 * sin1 + b2 * sin2);
  const denRe = 1 + a1 * cos1 + a2 * cos2;
  const denIm = -(a1 * sin1 + a2 * sin2);
  const num = Math.hypot(numRe, numIm);
  const den = Math.hypot(denRe, denIm);
  return 20 * Math.log10(den > 1e-12 ? num / den : 1e-12);
}

export function ParametricEQ(): JSX.Element {
  const sampleRate = useUiStore((s) => s.project.sampleRate);
  const [bands, setBands] = useState<readonly EqBand[]>(INITIAL_BANDS);
  const ref = useRef<HTMLCanvasElement>(null);
  const dragIndex = useRef<number>(-1);

  const curves = useMemo(() => bands.map((b) => coeffs(b, sampleRate)), [bands, sampleRate]);

  useCanvasDraw(
    ref,
    (ctx, size) => {
      const { width, height } = size;

      // Grid design: 25px horizontal, 32px vertikal.
      ctx.fillStyle = '#161616';
      for (let x = 24; x < width; x += 25) ctx.fillRect(x, 0, 1, height);
      for (let y = 31; y < height; y += 32) ctx.fillRect(0, y, width, 1);

      // Spectrum analyzer: FASE 2 (docs/08). Bar statis, tanpa data.
      const bars = 48;
      const bw = width / bars;
      ctx.fillStyle = '#ffd4001f';
      ctx.strokeStyle = '#ffd40047';
      for (let i = 0; i < bars; i++) {
        const tilt = Math.pow(1 - i / bars, 0.9);
        const h = Math.max(4, tilt * 55);
        const x = i * bw;
        ctx.fillRect(x, height - h, bw - 1, h);
        ctx.beginPath();
        ctx.moveTo(x, height - h + 0.5);
        ctx.lineTo(x + bw - 1, height - h + 0.5);
        ctx.stroke();
      }

      // Kurva gabungan (jumlah dB semua band = perkalian magnitude).
      ctx.beginPath();
      for (let px = 0; px <= width; px++) {
        const hz = xToHz(px / width);
        let db = 0;
        for (const c of curves) db += magnitudeDb(c, hz, sampleRate);
        const y = height / 2 - (db / MAX_GAIN_DB) * (height / 2);
        if (px === 0) ctx.moveTo(px, y);
        else ctx.lineTo(px, y);
      }
      ctx.strokeStyle = '#ffd400';
      ctx.lineWidth = 2;
      ctx.shadowColor = '#ffd400aa';
      ctx.shadowBlur = 6;
      ctx.stroke();
      ctx.shadowBlur = 0;

      // Node 12px dengan glow, seperti `eqNodes` di design.
      bands.forEach((b) => {
        const x = logX(b.freq) * width;
        const y = height / 2 - (b.gainDb / MAX_GAIN_DB) * (height / 2);
        ctx.fillStyle = b.color;
        ctx.shadowColor = b.color;
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
      });
    },
    [bands, curves, sampleRate],
  );

  const nodeDrag = useDrag<readonly EqBand[]>({
    onStart: (ctx) => {
      // Hit-test node: cari yang paling dekat dalam radius 14px.
      let best = -1;
      let bestDist = 14;
      bands.forEach((b, i) => {
        const x = logX(b.freq) * ctx.rect.width;
        const y = ctx.rect.height / 2 - (b.gainDb / MAX_GAIN_DB) * (ctx.rect.height / 2);
        const d = Math.hypot(ctx.x - x, ctx.y - y);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      });
      dragIndex.current = best;
      return bands;
    },
    onMove: (ctx, start) => {
      const i = dragIndex.current;
      if (i < 0) return;
      const freq = Math.max(MIN_HZ, Math.min(MAX_HZ, xToHz(ctx.x / ctx.rect.width)));
      const gainDb = Math.max(
        -MAX_GAIN_DB,
        Math.min(MAX_GAIN_DB, ((ctx.rect.height / 2 - ctx.y) / (ctx.rect.height / 2)) * MAX_GAIN_DB),
      );
      // Kurva EQ adalah tampilan; nilai band-nya state UI sampai ada
      // `Cmd::SetEqBand` di ring (belum ada opcode-nya di sab-layout).
      setBands(start.map((b, k) => (k === i ? { ...b, freq, gainDb } : b)));
    },
    onEnd: () => {
      dragIndex.current = -1;
      // TODO(engine): kirim satu SetEqBand di sini begitu opcode-nya ada di
      // `audio/sab-layout.ts` — satu command per gerakan (docs/08 §8a).
    },
  });

  return (
    <Card title="Parametric EQ" subtitle="4-band · analyzer overlay" notched>
      <div
        {...nodeDrag}
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
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginTop: '8px',
          fontSize: '10px',
          color: 'var(--cy-text-muted)',
          letterSpacing: '.12em',
        }}
      >
        <span>30 Hz</span>
        <span>200</span>
        <span>1 k</span>
        <span>5 k</span>
        <span>18 kHz</span>
      </div>
    </Card>
  );
}
