/**
 * Matematika kurva EQ: pemetaan x↔Hz, y↔dB, koefisien biquad RBJ, dan
 * |H(e^jω)|.
 *
 * Dipisah dari komponen supaya bisa dites tanpa canvas, dan supaya kurva yang
 * digambar dijamin berasal dari rumus yang sama dengan yang dipakai untuk
 * hit-test node. Kalau keduanya dihitung di dua tempat, node akan "meleset"
 * dari kurvanya sendiri begitu salah satu diubah.
 *
 * PENTING: kurva ini adalah magnitude response biquad SUNGGUHAN, bukan
 * aproksimasi bell. Yang digambar harus sama dengan yang terjadi pada audio,
 * termasuk interaksi antar band yang saling tumpang tindih.
 */

import {
  EQ_MAX_GAIN_DB,
  EQ_MAX_HZ,
  EQ_MIN_HZ,
  type EqBand,
} from '../model';

/** Batas tampilan kurva. Sengaja sedikit lebih sempit dari batas nilai
 *  (20 Hz–20 kHz) supaya node di ujung tidak menempel di tepi canvas. */
export const VIEW_MIN_HZ = 30;
export const VIEW_MAX_HZ = 18_000;

const LOG_SPAN = Math.log(VIEW_MAX_HZ / VIEW_MIN_HZ);

/** Hz → fraksi 0..1 pada sumbu log. Di luar rentang tampilan hasilnya boleh
 *  <0 atau >1; pemanggil yang memutuskan mau di-clamp atau tidak. */
export const logX = (hz: number): number => Math.log(hz / VIEW_MIN_HZ) / LOG_SPAN;

/** Fraksi 0..1 → Hz. Inverse tepat dari `logX`. */
export const xToHz = (x: number): number => VIEW_MIN_HZ * Math.pow(VIEW_MAX_HZ / VIEW_MIN_HZ, x);

export const clampHz = (hz: number): number => Math.min(EQ_MAX_HZ, Math.max(EQ_MIN_HZ, hz));
export const clampGainDb = (db: number): number =>
  Math.min(EQ_MAX_GAIN_DB, Math.max(-EQ_MAX_GAIN_DB, db));

/** dB → y pixel (0 dB di tengah, positif ke atas). */
export const dbToY = (db: number, height: number): number =>
  height / 2 - (db / EQ_MAX_GAIN_DB) * (height / 2);

/** y pixel → dB, sudah di-clamp ±EQ_MAX_GAIN_DB. */
export const yToDb = (y: number, height: number): number =>
  clampGainDb(((height / 2 - y) / (height / 2)) * EQ_MAX_GAIN_DB);

export type Coeffs = readonly [number, number, number, number, number];

/**
 * Koefisien biquad RBJ (ternormalisasi a0), urutan [b0, b1, b2, a1, a2].
 * Rumus yang sama dipakai `daw-dsp::biquad` dan `BiquadFilterNode`.
 */
export function coeffs(band: EqBand, sampleRate: number): Coeffs {
  const A = Math.pow(10, band.gainDb / 40);
  const w0 = (2 * Math.PI * band.freq) / sampleRate;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const alpha = sw / (2 * band.q);
  switch (band.kind) {
    case 'peaking': {
      const a0 = 1 + alpha / A;
      return [
        (1 + alpha * A) / a0,
        (-2 * cw) / a0,
        (1 - alpha * A) / a0,
        (-2 * cw) / a0,
        (1 - alpha / A) / a0,
      ];
    }
    case 'lowshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      const a0 = A + 1 + (A - 1) * cw + s;
      return [
        (A * (A + 1 - (A - 1) * cw + s)) / a0,
        (2 * A * (A - 1 - (A + 1) * cw)) / a0,
        (A * (A + 1 - (A - 1) * cw - s)) / a0,
        (-2 * (A - 1 + (A + 1) * cw)) / a0,
        (A + 1 + (A - 1) * cw - s) / a0,
      ];
    }
    case 'highshelf': {
      const s = 2 * Math.sqrt(A) * alpha;
      const a0 = A + 1 - (A - 1) * cw + s;
      return [
        (A * (A + 1 + (A - 1) * cw + s)) / a0,
        (-2 * A * (A - 1 + (A + 1) * cw)) / a0,
        (A * (A + 1 + (A - 1) * cw - s)) / a0,
        (2 * (A - 1 - (A + 1) * cw)) / a0,
        (A + 1 - (A - 1) * cw - s) / a0,
      ];
    }
  }
}

/** |H(e^{jω})| dalam dB untuk satu set koefisien. */
export function magnitudeDb(c: Coeffs, hz: number, sampleRate: number): number {
  const [b0, b1, b2, a1, a2] = c;
  const w = (2 * Math.PI * hz) / sampleRate;
  const cos1 = Math.cos(w);
  const cos2 = Math.cos(2 * w);
  const sin1 = Math.sin(w);
  const sin2 = Math.sin(2 * w);
  const num = Math.hypot(b0 + b1 * cos1 + b2 * cos2, -(b1 * sin1 + b2 * sin2));
  const den = Math.hypot(1 + a1 * cos1 + a2 * cos2, -(a1 * sin1 + a2 * sin2));
  return 20 * Math.log10(den > 1e-12 ? num / den : 1e-12);
}

/** Respons gabungan semua band di satu frekuensi. Kaskade filter = perkalian
 *  magnitude = penjumlahan dB. */
export function totalDb(curves: readonly Coeffs[], hz: number, sampleRate: number): number {
  let db = 0;
  for (const c of curves) db += magnitudeDb(c, hz, sampleRate);
  return db;
}

/** Radius hit-test node dalam CSS pixel. */
export const NODE_HIT_PX = 14;

/**
 * Band terdekat dari titik (x, y) dalam radius `NODE_HIT_PX`, atau -1.
 * Ukuran nol dianggap "tidak ada node" — bukan NaN.
 */
export function hitTestBand(
  bands: readonly EqBand[],
  x: number,
  y: number,
  width: number,
  height: number,
): number {
  if (width <= 0 || height <= 0) return -1;
  let best = -1;
  let bestDist = NODE_HIT_PX;
  bands.forEach((b, i) => {
    const d = Math.hypot(x - logX(b.freq) * width, y - dbToY(b.gainDb, height));
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  return best;
}

/** Format Hz ringkas untuk readout ("620 Hz", "3.8 kHz"). */
export function formatHz(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10_000 ? 1 : 2)} kHz` : `${Math.round(hz)} Hz`;
}
