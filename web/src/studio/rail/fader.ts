/**
 * Taper fader + konversi dB — salinan UI dari docs/07 §7b.
 *
 * Kebenarannya hidup di Rust (`fader_taper`); file ini ada supaya rail bisa
 * menggambar posisi fader dan menulis label dB tanpa round-trip ke engine.
 * Yang disimpan di model & dikirim ke engine SELALU dB, tidak pernah travel.
 *
 * Catatan: file ini sengaja berdiri sendiri (tidak meng-import
 * `src/state/gain.ts`) karena `src/state/**` adalah sisa UI lama yang sedang
 * dirombak; rail tidak boleh ikut mati kalau folder itu dihapus.
 */

/** Unity (0 dB) tepat di 75% travel — docs/07. */
const UNITY = 0.75;
/** Di bawah ini dianggap senyap (docs/07: -96 dB → linear 0 tepat). */
export const SILENCE_DB = -96;
export const MAX_FADER_DB = 6;

/** travel 0..1 → dB. Piecewise linear di domain dB, persis tabel docs/07. */
export function faderToDb(travel: number): number {
  const t = Math.min(1, Math.max(0, travel));
  if (t <= 0) return Number.NEGATIVE_INFINITY;
  if (t < 0.25) {
    const db = -40 - (0.25 - t) * 4 * 56; // -40 .. -96
    return db <= SILENCE_DB ? Number.NEGATIVE_INFINITY : db;
  }
  if (t < 0.5) return -40 + (t - 0.25) * 4 * 20; // -40 .. -20
  if (t < UNITY) return -20 + (t - 0.5) * 4 * 20; // -20 ..   0
  return (t - UNITY) * 4 * MAX_FADER_DB; //   0 ..  +6
}

/** Inverse eksak `faderToDb` — mengetik nilai lalu men-drag tidak boleh melompat. */
export function dbToFader(db: number): number {
  if (!Number.isFinite(db)) return 0;
  if (db >= 0) return Math.min(1, UNITY + db / (4 * MAX_FADER_DB));
  if (db >= -20) return 0.5 + (db + 20) / 80;
  if (db >= -40) return 0.25 + (db + 40) / 80;
  if (db <= SILENCE_DB) return 0;
  return 0.25 - (-40 - db) / 224;
}

export const dbToLin = (db: number): number => (Number.isFinite(db) ? Math.pow(10, db / 20) : 0);

/** Label seperti design: `-1.5`, `+3.0`, `-inf`. */
export function formatDb(db: number, digits = 1): string {
  if (!Number.isFinite(db)) return '-inf';
  const s = db.toFixed(digits);
  return db > 0 ? `+${s}` : s;
}

/** Snap 0.5 dB seperti slider EQ di design. */
export const snapHalfDb = (db: number): number => Math.round(db * 2) / 2;
