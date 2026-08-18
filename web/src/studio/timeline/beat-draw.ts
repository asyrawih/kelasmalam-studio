/**
 * Menggambar grid ketukan ke sebuah canvas.
 *
 * Dipisah dari komponennya karena ADA DUA penggambar yang memerlukannya:
 * tampilan clip utuh (`BeatOverlay`, digambar ulang saat depsnya berubah) dan
 * jendela geser (`ScrollingWave`, digambar ulang tiap frame rAF). Dua salinan
 * berarti grid bisa berpindah tempat hanya karena user menekan tombol zoom —
 * jenis cacat yang membuat orang berhenti percaya pada grid-nya.
 *
 * Semua posisi SOURCE-space; `from`/`len` adalah jendela yang sedang tampak.
 */

import type { Samples } from '../model';
import { beatLinesIn, samplesPerBeat, type BeatGrid } from '../analysis/beat-grid';

/**
 * Di bawah jarak ini (piksel) garis ketukan tidak digambar lagi — hanya garis
 * bar. Grid yang lebih rapat dari beberapa piksel berhenti menjadi informasi
 * dan berubah jadi bidang abu-abu di atas waveform.
 */
export const MIN_BEAT_LINE_PX = 6;
export const MIN_BAR_LINE_PX = 3;
/** Di bawah ini nomor bar tidak muat dan hanya jadi bubur. */
const MIN_BAR_LABEL_PX = 28;

export interface BeatGridDrawOptions {
  readonly grid: BeatGrid;
  readonly sampleRate: number;
  /** Jendela yang tampak, SOURCE-space. */
  readonly from: Samples;
  readonly len: Samples;
  readonly width: number;
  readonly height: number;
  /** Sorotan region, SOURCE-space. Boleh sebagian di luar jendela. */
  readonly region?: { readonly sourceStart: Samples; readonly sourceLen: Samples } | null;
  /** Warna bidang sorotan region. */
  readonly regionTint?: string;
  /** Warna garis batas region. */
  readonly regionStroke?: string;
}

/** Sorotan region + garis bar/beat + nomor bar. Tidak menyentuh playhead. */
export function drawBeatGrid(ctx: CanvasRenderingContext2D, o: BeatGridDrawOptions): void {
  const { grid, sampleRate, from, len, width: w, height: h } = o;
  if (len <= 0 || w <= 0) return;
  const x = (s: Samples): number => ((s - from) / len) * w;

  const beatPx = (samplesPerBeat(grid, sampleRate) / len) * w;
  const barPx = beatPx * grid.beatsPerBar;
  if (!Number.isFinite(barPx) || barPx < MIN_BAR_LINE_PX) return;

  // 1. Sorotan region DI BAWAH garis grid, supaya batasnya tetap terbaca
  //    sebagai garis dan tidak tertutup bidangnya sendiri.
  const region = o.region ?? null;
  if (region !== null) {
    const rx = x(region.sourceStart);
    const rw = (region.sourceLen / len) * w;
    ctx.fillStyle = o.regionTint ?? '#6ee7ff1f';
    ctx.fillRect(rx, 0, rw, h);
    ctx.strokeStyle = o.regionStroke ?? '#6ee7ff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(rx + 0.5, 0);
    ctx.lineTo(rx + 0.5, h);
    ctx.moveTo(rx + rw - 0.5, 0);
    ctx.lineTo(rx + rw - 0.5, h);
    ctx.stroke();
  }

  const lines = beatLinesIn(grid, sampleRate, from, len);
  ctx.lineWidth = 1;

  if (beatPx >= MIN_BEAT_LINE_PX) {
    ctx.strokeStyle = '#ffffff1a';
    ctx.beginPath();
    for (const l of lines) {
      if (l.downbeat) continue;
      const px = Math.round(x(l.at)) + 0.5;
      ctx.moveTo(px, h * 0.18);
      ctx.lineTo(px, h * 0.82);
    }
    ctx.stroke();
  }

  ctx.strokeStyle = '#ffffff4d';
  ctx.beginPath();
  for (const l of lines) {
    if (!l.downbeat) continue;
    const px = Math.round(x(l.at)) + 0.5;
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
  }
  ctx.stroke();

  if (barPx >= MIN_BAR_LABEL_PX) {
    ctx.fillStyle = '#ffffff66';
    ctx.font = '9px var(--cy-font-mono, monospace)';
    ctx.textBaseline = 'top';
    for (const l of lines) {
      if (!l.downbeat) continue;
      ctx.fillText(String(l.bar + 1), Math.round(x(l.at)) + 3, 3);
    }
  }
}

/** Garis playhead vertikal. Dilewati kalau jatuh di luar jendela. */
export function drawPlayhead(
  ctx: CanvasRenderingContext2D,
  at: Samples,
  from: Samples,
  len: Samples,
  width: number,
  height: number,
  color = '#ffffff',
): void {
  if (len <= 0) return;
  const px = ((at - from) / len) * width;
  if (px < 0 || px > width) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(Math.round(px) + 0.5, 0);
  ctx.lineTo(Math.round(px) + 0.5, height);
  ctx.stroke();
}
