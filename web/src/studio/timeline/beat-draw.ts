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
export const MIN_BEAT_LINE_PX = 8;
export const MIN_BAR_LINE_PX = 3;
/** Di bawah ini nomor bar tidak muat dan hanya jadi bubur. */
const MIN_BAR_LABEL_PX = 28;

/**
 * Garis grid digambar sebagai SANDWICH LUMINANSI: halo gelap dulu, garis
 * terang di atasnya.
 *
 * Alasannya ada di palet waveform-nya sendiri (`waveform.ts`): badan gelombang
 * memakai gradien amber `#ffb020`→`#ffd400` dan pita `high` nyaris putih
 * (`#eef4ff`). Putih transparan di atas itu hilang TEPAT di bagian yang paling
 * ramai — grid terbaca jelas di ruang kosong lalu lenyap begitu ada materi,
 * yaitu kebalikan dari gunanya.
 *
 * Menaikkan alfa saja tidak cukup: yang kurang bukan TERANG-nya melainkan
 * BEDA-nya dengan apa pun yang kebetulan ada di belakangnya. Halo gelap tidak
 * punya hue, jadi ia bekerja di atas ketiga pita sekaligus tanpa menambah
 * warna kelima ke bidang yang sudah penuh (alasan yang sama dipakai `anchorAt`
 * di bawah untuk memilih BENTUK, bukan warna).
 *
 * `MIN_BEAT_LINE_PX` ikut naik dari 6 ke 8 karena garis sekarang lebih tebal
 * 2 piksel: pada jarak 6 piksel halonya saling bersambung dan grid berubah
 * jadi bidang gelap — persis mode gagal yang dicegah ambang ini.
 */
const GRID_HALO = '#000000a6';
/** Selisih lebar halo terhadap garisnya, dalam piksel (1 piksel tiap sisi). */
const GRID_HALO_PX = 2;
const BEAT_LINE = '#ffffff8c';
const BAR_LINE = '#ffffffe6';
const BAR_LABEL = '#ffffffd9';

/**
 * Menggambar satu berkas garis DUA KALI: halo gelap yang lebih tebal, lalu
 * garis terangnya di atasnya.
 *
 * Jalurnya dibangun ulang lewat `path` alih-alih disimpan sebagai `Path2D`
 * supaya tidak menuntut API yang tidak ada di mock canvas pengujian; jumlah
 * garis di satu jendela hanya puluhan, jadi harganya tidak terukur.
 */
function strokeWithHalo(
  ctx: CanvasRenderingContext2D,
  color: string,
  width: number,
  path: (c: CanvasRenderingContext2D) => void,
): void {
  ctx.lineWidth = width + GRID_HALO_PX;
  ctx.strokeStyle = GRID_HALO;
  ctx.beginPath();
  path(ctx);
  ctx.stroke();

  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.beginPath();
  path(ctx);
  ctx.stroke();
}

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
  /**
   * Posisi ANCHOR grid (SOURCE-space), digambar sebagai segitiga merah.
   *
   * Hanya diisi saat mode GRID EDIT menyala. Tanpa penanda ini, tombol ×2/÷2
   * dan renggang/rapat terasa acak: semuanya mem-pivot di anchor, dan anchor
   * adalah satu-satunya garis yang TIDAK ikut bergerak — tapi ia tidak bisa
   * dibedakan dari 200 garis bar lain yang bentuknya sama persis.
   *
   * Segitiga merah, mengikuti rekordbox (`recordbox/01a` §5: *"red triangle =
   * first beat of bar"*). Bentuk, bukan warna saja: garis bar di sini sudah
   * memakai putih transparan, dan menambah warna kelima ke bidang yang sama
   * membuat semuanya berhenti terbaca.
   */
  readonly anchorAt?: Samples | null;
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

  if (beatPx >= MIN_BEAT_LINE_PX) {
    strokeWithHalo(ctx, BEAT_LINE, 1, (c) => {
      for (const l of lines) {
        if (l.downbeat) continue;
        const px = Math.round(x(l.at)) + 0.5;
        c.moveTo(px, h * 0.18);
        c.lineTo(px, h * 0.82);
      }
    });
  }

  // Garis bar setebal 1.5 piksel, bukan 1: pada jendela 8 detik ada 16 garis
  // beat mengapit tiap garis bar, dan kalau semuanya setebal sama maka satu-
  // satunya pembedanya tinggal tinggi garis — terlalu halus untuk dibaca
  // sekilas saat lagu berjalan.
  strokeWithHalo(ctx, BAR_LINE, 1.5, (c) => {
    for (const l of lines) {
      if (!l.downbeat) continue;
      const px = Math.round(x(l.at)) + 0.5;
      c.moveTo(px, 0);
      c.lineTo(px, h);
    }
  });

  const anchorAt = o.anchorAt ?? null;
  if (anchorAt !== null && anchorAt >= from && anchorAt < from + len) {
    const ax = Math.round(x(anchorAt)) + 0.5;
    // Halo yang sama: merah di atas badan amber punya masalah kontras yang
    // sama persis dengan putih, dan anchor adalah garis yang paling tidak
    // boleh hilang saat grid sedang disunting.
    strokeWithHalo(ctx, '#ff4d4d', 1.5, (c) => {
      c.moveTo(ax, 0);
      c.lineTo(ax, h);
    });

    ctx.fillStyle = '#ff4d4d';
    ctx.beginPath();
    ctx.moveTo(ax - 5, 0);
    ctx.lineTo(ax + 5, 0);
    ctx.lineTo(ax, 8);
    ctx.closePath();
    ctx.fill();
  }

  if (barPx >= MIN_BAR_LABEL_PX) {
    ctx.font = '9px var(--cy-font-mono, monospace)';
    ctx.textBaseline = 'top';
    // Angka bar duduk di jalur paling atas, tempat pita `high` yang nyaris
    // putih paling sering muncul. Diberi garis luar gelap dengan alasan yang
    // sama seperti garis grid-nya, bukan sekadar dinaikkan alfanya.
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = GRID_HALO;
    ctx.fillStyle = BAR_LABEL;
    for (const l of lines) {
      if (!l.downbeat) continue;
      const label = String(l.bar + 1);
      const lx = Math.round(x(l.at)) + 3;
      ctx.strokeText(label, lx, 3);
      ctx.fillText(label, lx, 3);
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
  // Halo yang sama seperti garis grid: playhead putih 1 piksel di atas puncak
  // gelombang paling terang adalah garis yang paling mahal untuk hilang.
  strokeWithHalo(ctx, color, 1, (c) => {
    c.moveTo(Math.round(px) + 0.5, 0);
    c.lineTo(Math.round(px) + 0.5, height);
  });
}
