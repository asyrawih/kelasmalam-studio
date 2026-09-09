/**
 * Konversi gain untuk lapisan UI.
 *
 * Kebenaran taper hidup di Rust (`fader_to_db` di docs/07). Salinan di sini ada
 * SEMATA supaya UI bisa menggambar posisi fader dan menulis label dB tanpa
 * round-trip ke engine. Rumusnya disalin persis dari docs/07 — kalau di Rust
 * berubah, file ini ikut berubah, bukan sebaliknya.
 *
 * Yang dikirim ke engine tetap dB (lihat `EngineClient.setTrackGain(track, db)`),
 * jadi kurva ini tidak pernah "dipakai dua kali" di dua tempat berbeda.
 */

const UNITY_TRAVEL = 0.75;
export const MIN_FADER_DB = -60;
export const MAX_FADER_DB = 6;

/** travel 0..1 → dB. travel 0 = -Infinity (senyap), bukan -60. */
export function faderToDb(travel: number): number {
  const t = Math.max(0, Math.min(1, travel));
  if (t <= 0) return Number.NEGATIVE_INFINITY;
  if (t >= UNITY_TRAVEL) return ((t - UNITY_TRAVEL) / (1 - UNITY_TRAVEL)) * MAX_FADER_DB;
  return 40 * Math.log10(t / UNITY_TRAVEL) * 1.5;
}

/** Inverse eksak dari `faderToDb` — properti yang diminta docs/07: mengetik
 *  "-6.0 dB" lalu menyeret fader tidak boleh melompat. */
export function dbToFader(db: number): number {
  if (!Number.isFinite(db)) return 0;
  if (db >= 0) return UNITY_TRAVEL + (db / MAX_FADER_DB) * (1 - UNITY_TRAVEL);
  return UNITY_TRAVEL * Math.pow(10, db / 60);
}

export const dbToLin = (db: number): number => (Number.isFinite(db) ? Math.pow(10, db / 20) : 0);

export const linToDb = (lin: number): number =>
  lin > 1e-6 ? 20 * Math.log10(lin) : Number.NEGATIVE_INFINITY;

/** Label seperti di design: `-6.2`, `+1.5`, `-inf`. */
export function formatDb(db: number, digits = 1): string {
  if (!Number.isFinite(db)) return '-inf';
  const s = db.toFixed(digits);
  return db > 0 ? `+${s}` : s;
}

/** Pan law -3 dB equal power (docs/07). Dipakai UI hanya untuk label/preview. */
export function panGains(pan: number): readonly [number, number] {
  const a = ((Math.max(-1, Math.min(1, pan)) + 1) * Math.PI) / 4;
  return [Math.cos(a), Math.sin(a)];
}

/** `C`, `L12`, `R30` — format label pan di design. */
export function formatPan(pan: number): string {
  const v = Math.round(pan * 100);
  if (v === 0) return 'C';
  return (v < 0 ? 'L' : 'R') + Math.abs(v);
}
