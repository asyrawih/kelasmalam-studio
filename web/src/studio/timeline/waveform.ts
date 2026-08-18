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
import { loopTileCount } from './clip-loop';
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

/**
 * Lebar minimum satu ubin loop sebelum menggambarnya jadi sia-sia. Di bawah ini
 * satu putaran lebih tipis dari beberapa piksel dan yang tergambar bukan lagi
 * bentuk, melainkan derau.
 */
export const MIN_LOOP_TILE_PX = 3;
/** Seam digambar hanya kalau ubinnya cukup lebar untuk dilihat sebagai batas. */
const SEAM_MIN_TILE_PX = 8;

/**
 * Waveform clip yang LOOP: satu putaran, DIULANG, bukan materi yang memanjang.
 *
 * Ini bukan hiasan. Clip yang loop hanya membaca `[sourceStart, sourceStart +
 * loopLen)`, jadi menggambar `sourceLen` apa adanya akan menampilkan materi yang
 * TIDAK berbunyi — dan pada clip yang lebih panjang dari file-nya, sebagian
 * kotaknya bahkan kosong. Gambar yang tidak cocok dengan yang terdengar adalah
 * cacat yang paling mahal di UI editing (lihat `drawPlaceholderWave`).
 *
 * Biayanya tetap sebanding dengan LEBAR, bukan jumlah ubin: tiap ubin hanya
 * menggambar kolom sebanyak lebarnya sendiri.
 */
export function drawLoopedClipWave(
  ctx: CanvasRenderingContext2D,
  asset: StudioAsset | undefined,
  sourceStart: number,
  sourceLen: number,
  loopLen: number,
  width: number,
  height: number,
  dpr: number,
  style: WaveStyle,
): void {
  if (asset === undefined) {
    drawPlaceholderWave(ctx, width, height, style.outline);
    return;
  }
  if (!(width > 0) || !(height > 0) || !(loopLen > 0) || !(sourceLen > 0)) return;

  const tiles = loopTileCount(sourceLen, loopLen);
  const tileW = (loopLen / sourceLen) * width;
  if (tiles <= 1 || tileW < MIN_LOOP_TILE_PX) {
    // Ubin sub-piksel: yang tergambar per putaran tidak akan terbaca berapa pun
    // usahanya. Satu putaran diregangkan sepanjang clip — materinya jujur
    // (memang itu yang berbunyi), hanya JUMLAH putarannya yang tidak terbaca,
    // dan pada kerapatan ini ia memang tidak pernah terbaca.
    drawAssetWave(ctx, asset, sourceStart, loopLen, width, height, dpr, style);
    return;
  }

  for (let i = 0; i < tiles; i++) {
    const x = i * tileW;
    const visible = Math.min(tileW, width - x);
    if (visible <= 0) break;
    ctx.save();
    // Clip: ubin TERAKHIR hampir selalu terpotong di tengah putaran, persis
    // seperti bunyinya — loop berhenti di ujung clip, bukan di ujung putaran.
    ctx.beginPath();
    ctx.rect(x, 0, visible, height);
    ctx.clip();
    ctx.translate(x, 0);
    drawAssetWave(ctx, asset, sourceStart, loopLen, tileW, height, dpr, style);
    ctx.restore();
  }

  if (tileW >= SEAM_MIN_TILE_PX && typeof style.outline === 'string') {
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = style.outline;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    for (let i = 1; i < tiles; i++) {
      const x = Math.round(i * tileW) + 0.5;
      if (x >= width) break;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    }
    ctx.stroke();
    ctx.restore();
  }
}
