/**
 * Penggambar waveform di canvas.
 *
 * KENAPA CANVAS, BUKAN `<div>` PER BATANG. Versi lama membuat 44 div per clip
 * dan 260 div untuk panel detail. Itu memberi batas keras pada kerapatan
 * (satu batang tidak bisa lebih tipis dari satu elemen + gap), dan — lebih
 * penting — sebuah div hanya punya SATU tinggi, sehingga envelope min/max yang
 * asimetris tidak bisa digambar sama sekali. Canvas menggambar satu kolom per
 * DEVICE pixel, jadi detailnya ikut naik saat user zoom.
 *
 * Bentuk yang digambar, dari luar ke dalam:
 *   1. outline min/max — poligon terisi, dicerminkan pada garis tengah;
 *   2. badan RMS — bentuk yang sama tapi lebih terang/pekat, selalu di dalam
 *      outline. Ini yang membuat bagian sunyi terlihat sunyi meskipun
 *      transiennya menyentuh puncak.
 */

import type { StudioAsset } from '../store';
import { allocColumns, readEnvelope, type EnvelopeColumns } from './envelope';

/** Buffer kolom yang dipakai ulang lintas semua canvas. Menggambar tidak boleh
 *  mengalokasi: pada zoom/scroll fungsi ini terpanggil puluhan kali per gerakan. */
let scratch: EnvelopeColumns = allocColumns(0);
function columnsFor(width: number): EnvelopeColumns {
  if (scratch.min.length < width) scratch = allocColumns(width);
  return scratch;
}

export interface WaveStyle {
  /** Warna outline min/max. Boleh gradien (panel Clip Detail). */
  readonly outline: string | CanvasGradient;
  /** Warna badan RMS. Kalau sama dengan outline, bedanya cuma opacity. */
  readonly body: string | CanvasGradient;
  readonly outlineAlpha: number;
  readonly bodyAlpha: number;
  /** Garis tengah; null = tidak digambar. */
  readonly centerLine: string | null;
}

/** Gradien vertikal khas panel Clip Detail (#ffb020 → #ffd400 → #ffb020). */
export function clipDetailGradient(
  ctx: CanvasRenderingContext2D,
  height: number,
): CanvasGradient {
  const g = ctx.createLinearGradient(0, 0, 0, height);
  g.addColorStop(0, '#ffb020');
  g.addColorStop(0.5, '#ffd400');
  g.addColorStop(1, '#ffb020');
  return g;
}

/**
 * Gambar envelope asset untuk rentang source `[from, from+len)`.
 *
 * `width`/`height` dalam CSS pixel (konteks sudah ter-skala dpr oleh
 * `useCanvasDraw`); `dpr` dipakai untuk menentukan JUMLAH kolom, supaya satu
 * kolom = satu device pixel.
 */
export function drawAssetWave(
  ctx: CanvasRenderingContext2D,
  asset: StudioAsset,
  from: number,
  len: number,
  width: number,
  height: number,
  dpr: number,
  style: WaveStyle,
): void {
  // Canvas nol-ukuran (elemen belum di-layout, clip selebar 0%): tidak ada yang
  // bisa digambar dan semua pembagian di bawah akan menghasilkan NaN.
  if (!(width > 0) || !(height > 0)) return;

  const cols = Math.max(1, Math.floor(width * Math.max(1, dpr)));
  const cw = width / cols;
  const cy = height / 2;
  const half = height / 2;
  const cs = columnsFor(cols);
  readEnvelope(asset.envelope, from, len, cols, cs);

  if (style.centerLine !== null) {
    ctx.fillStyle = style.centerLine;
    ctx.fillRect(0, cy - 0.5, width, 1);
  }

  // Outline: satu path yang menyusuri semua max lalu balik lewat semua min.
  // Satu `fill` untuk seluruh waveform — bukan satu per kolom — supaya biaya
  // gambar tetap konstan berapa pun kerapatannya.
  const paint = (
    values: (i: number) => { top: number; bottom: number },
    color: string | CanvasGradient,
    alpha: number,
  ): void => {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let i = 0; i < cols; i += 1) {
      const { top } = values(i);
      ctx.lineTo(i * cw, top);
      ctx.lineTo((i + 1) * cw, top);
    }
    for (let i = cols - 1; i >= 0; i -= 1) {
      const { bottom } = values(i);
      ctx.lineTo((i + 1) * cw, bottom);
      ctx.lineTo(i * cw, bottom);
    }
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
  };

  // Tinggi minimum 1 px: tanpa ini, bagian yang benar-benar sunyi hilang sama
  // sekali dan waveform-nya terlihat "putus", bukan sunyi.
  const clampAmp = (v: number): number => Math.min(1, Math.abs(v)) * half;
  paint(
    (i) => ({
      top: cy - Math.max(0.5, clampAmp(cs.max[i] ?? 0)),
      bottom: cy + Math.max(0.5, clampAmp(cs.min[i] ?? 0)),
    }),
    style.outline,
    style.outlineAlpha,
  );
  paint(
    (i) => {
      const r = Math.max(0.5, clampAmp(cs.rms[i] ?? 0));
      return { top: cy - r, bottom: cy + r };
    },
    style.body,
    style.bodyAlpha,
  );
}

/**
 * Gambar placeholder untuk clip yang asset-nya tidak ada (demo, atau file yang
 * gagal dipulihkan dari IndexedDB).
 *
 * Sengaja TIDAK menyerupai audio: garis putus-putus di tengah + arsir diagonal.
 * Versi lama memakai mock deterministik dari `clip.seed` yang terlihat persis
 * seperti waveform sungguhan — dan waveform palsu yang menyamar sebagai audio
 * nyata adalah bug yang paling mahal untuk ditemukan di UI editing.
 */
export function drawPlaceholderWave(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  color: string | CanvasGradient,
): void {
  if (!(width > 0) || !(height > 0)) return;
  const cy = height / 2;
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(0, cy);
  ctx.lineTo(width, cy);
  ctx.stroke();

  ctx.setLineDash([]);
  ctx.globalAlpha = 0.14;
  ctx.beginPath();
  const step = 8;
  for (let x = -height; x < width; x += step) {
    ctx.moveTo(x, height);
    ctx.lineTo(x + height, 0);
  }
  ctx.stroke();
  ctx.restore();
}

/** Pilih otomatis: envelope asli kalau asset-nya ada, kalau tidak placeholder. */
export function drawClipWave(
  ctx: CanvasRenderingContext2D,
  asset: StudioAsset | undefined,
  sourceStart: number,
  sourceLen: number,
  width: number,
  height: number,
  dpr: number,
  style: WaveStyle,
): void {
  if (asset === undefined) {
    drawPlaceholderWave(ctx, width, height, style.outline);
    return;
  }
  drawAssetWave(ctx, asset, sourceStart, sourceLen, width, height, dpr, style);
}
