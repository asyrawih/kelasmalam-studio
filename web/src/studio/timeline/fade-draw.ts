/**
 * Menggambar kurva fade ke canvas, DALAM RUANG SOURCE.
 *
 * Dulu overlay fade digambar sebagai fraksi CLIP — `inFrac`/`outFrac` dari 0..1
 * sepanjang kotak. Itu bekerja selama kotaknya menampilkan seluruh clip, dan
 * langsung runtuh begitu ada jendela geser: di sana kotak menampilkan 4 bar dari
 * clip 3 menit, dan fraksi clip menunjuk tempat yang bukan tempatnya.
 *
 * Jalan keluar yang dulu diambil — MENYEMBUNYIKAN fade saat di-zoom — salah:
 * fade tetap ada dan tetap terdengar, jadi menyembunyikannya berarti user tidak
 * bisa melihat sesuatu yang sedang mempengaruhi suaranya. Yang benar adalah
 * memetakannya: daerah fade punya posisi SOURCE yang pasti, dan posisi itu bisa
 * digambar di jendela mana pun. Kalau kebetulan di luar jendela, ia memang tidak
 * terlihat — dan itu jujur.
 *
 * Satu implementasi dipakai kedua tampilan (utuh & jendela geser). Dua salinan
 * berarti bentuk kurva bisa berbeda hanya karena user menekan tombol zoom.
 */

import { fadeInGain, fadeOutGain } from './fade';
import type { FadeCurve, Samples } from '../model';

export interface FadeRegions {
  /** Batas clip di SOURCE-space. */
  readonly sourceStart: Samples;
  readonly sourceEnd: Samples;
  /** Panjang fade di SOURCE-space (0 = tidak ada). */
  readonly fadeInSource: number;
  readonly fadeOutSource: number;
  readonly curve: FadeCurve;
}

export interface FadeDrawOptions extends FadeRegions {
  /** Jendela yang sedang tampak, SOURCE-space. */
  readonly from: Samples;
  readonly len: Samples;
  readonly width: number;
  readonly height: number;
}

/**
 * Panjang fade dalam SAMPLE SOURCE.
 *
 * `fadeInMs` diukur di waktu TIMELINE; lane 2× lebih cepat memakan dua kali
 * lipat materi untuk fade yang sama panjangnya di layar timeline.
 */
export function fadeSourceLen(fadeMs: number, sampleRate: number, speedRatio: number): number {
  return Math.max(0, (fadeMs / 1000) * sampleRate * speedRatio);
}

/** Bidang teredam + GARIS GAIN SUNGGUHAN melintasi daerah fade. */
export function drawFadeCurves(ctx: CanvasRenderingContext2D, o: FadeDrawOptions): void {
  const { from, len, width: w, height: h } = o;
  if (len <= 0 || w <= 0) return;
  const x = (s: number): number => ((s - from) / len) * w;

  const region = (fromSource: number, toSource: number, gainAt: (t: number) => number): void => {
    const x0 = x(fromSource);
    const x1 = x(toSource);
    // Seluruh daerah fade di luar jendela: tidak ada yang perlu digambar.
    if (x1 <= 0 || x0 >= w) return;
    const span = x1 - x0;
    if (span <= 0) return;
    // Jumlah langkah mengikuti lebar yang BENAR-BENAR tampak, bukan lebar
    // daerah fade: fade 16 detik di jendela 4 bar hanya menyisakan beberapa
    // piksel, dan menggambarnya dengan ribuan langkah membakar frame.
    const visible = Math.min(x1, w) - Math.max(x0, 0);
    const steps = Math.max(8, Math.min(240, Math.round(visible)));

    // 1. Bidang gelap DI ATAS kurva — bagian sinyal yang dibuang.
    ctx.beginPath();
    ctx.moveTo(x0, 0);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      ctx.lineTo(x0 + span * t, h * (1 - gainAt(t)));
    }
    ctx.lineTo(x1, 0);
    ctx.closePath();
    ctx.fillStyle = '#000000b3';
    ctx.fill();

    // 2. Garis kurvanya sendiri. Dihitung dari fungsi yang SAMA dengan yang
    //    dipakai audio, jadi yang dilihat user adalah gain yang benar-benar
    //    akan terdengar — bukan garis lurus yang membuat pilihan
    //    LINEAR/EQUAL-POWER tampak tidak berefek apa pun.
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const px = x0 + span * t;
      const py = h * (1 - gainAt(t));
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = '#ffd400';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  };

  if (o.fadeInSource > 0) {
    region(o.sourceStart, o.sourceStart + o.fadeInSource, (t) => fadeInGain(o.curve, t));
  }
  if (o.fadeOutSource > 0) {
    region(o.sourceEnd - o.fadeOutSource, o.sourceEnd, (t) => fadeOutGain(o.curve, t));
  }
}
