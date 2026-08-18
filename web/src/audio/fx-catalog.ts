/**
 * Katalog efek — cermin dari `daw_engine::fx::CATALOG`, dibaca lewat
 * `fxCatalogJson()`.
 *
 * Ini yang membuat menambah efek tidak menambah kode UI. Tiap efek
 * mendeklarasikan parameternya di Rust sebagai data statis; panel FX merakit
 * knob dari data itu. Efek ke-20 muncul di UI tanpa satu baris TypeScript baru
 * — tidak ada `switch (effect.kind)` di mana pun.
 *
 * ## Kenapa matematika taper ada di kedua sisi
 *
 * Knob bekerja dalam posisi 0..1; engine bekerja dalam nilai (Hz, dB, ms).
 * Konversinya karena itu dibutuhkan di UI DAN di Rust. Kalau keduanya
 * menyimpang, knob di posisi tengah menunjuk angka yang berbeda dari yang
 * dipakai engine — tanpa error, cuma terasa meleset. `fx-catalog.test.ts`
 * membandingkan implementasi di sini dengan fixture yang dicetak Rust, jadi
 * penyimpangan itu jadi tes gagal alih-alih keluhan yang sulit direproduksi.
 */

export type Unit =
  | 'linear'
  | 'percent'
  | 'db'
  | 'hz'
  | 'ms'
  | 'beats'
  | 'ratio'
  | 'semitones'
  | 'degrees'
  | 'choice';

export type Category = 'eq' | 'dynamics' | 'filter' | 'timeBased' | 'modulation' | 'pitch';

/** Enum bertag dari serde: `{ kind: "power", k: 2 }`. */
export type Taper =
  | { readonly kind: 'linear' }
  | { readonly kind: 'log' }
  | { readonly kind: 'power'; readonly k: number }
  | { readonly kind: 'stepped'; readonly k: number };

export type Smoothing =
  | { readonly kind: 'stepped' }
  | { readonly kind: 'block' }
  | { readonly kind: 'sample'; readonly tauMs: number };

/** Bit `daw_engine::fx::desc::pflag`. */
export const PFLAG = {
  BEAT_SYNC: 1 << 0,
  BIPOLAR: 1 << 1,
  PRIMARY: 1 << 2,
  JUMPS: 1 << 3,
} as const;

export interface ParamDesc {
  readonly id: string;
  readonly name: string;
  readonly unit: Unit;
  readonly min: number;
  readonly max: number;
  readonly default: number;
  readonly taper: Taper;
  readonly smoothing: Smoothing;
  readonly flags: number;
  readonly choices: readonly string[];
}

export interface EffectDesc {
  readonly kind: number;
  readonly id: string;
  readonly name: string;
  readonly category: Category;
  readonly params: readonly ParamDesc[];
  readonly summary: readonly number[];
  readonly maxTailMs: number;
  readonly latencyFrames: number;
}

/**
 * Batasi ke rentang. NaN jatuh ke default, bukan diteruskan — bentuk
 * `!(v > min)` sengaja dipakai karena `v > min` bernilai false untuk NaN.
 * Sama persis dengan `ParamDesc::clamp` di Rust.
 */
export function clampParam(p: ParamDesc, v: number): number {
  if (!(v > p.min)) {
    if (Number.isNaN(v)) return p.default;
    return p.min;
  }
  return v > p.max ? p.max : v;
}

/** Posisi knob 0..1 → nilai. Harus sama dengan `ParamDesc::from_norm`. */
export function fromNorm(p: ParamDesc, t: number): number {
  const tc = !(t > 0) ? 0 : t > 1 ? 1 : t;
  let v: number;
  switch (p.taper.kind) {
    case 'log':
      v =
        p.min > 0 && p.max > 0
          ? p.min * Math.pow(p.max / p.min, tc)
          : p.min + tc * (p.max - p.min);
      break;
    case 'power': {
      const k = p.taper.k > 0 ? p.taper.k : 1;
      v = p.min + (p.max - p.min) * Math.pow(tc, k);
      break;
    }
    case 'stepped': {
      const n = p.taper.k;
      if (n < 2) {
        v = p.min;
      } else {
        const steps = n - 1;
        v = p.min + (Math.round(tc * steps) / steps) * (p.max - p.min);
      }
      break;
    }
    default:
      v = p.min + tc * (p.max - p.min);
      break;
  }
  return clampParam(p, v);
}

/** Nilai → posisi knob 0..1. Kebalikan `fromNorm`. */
export function toNorm(p: ParamDesc, value: number): number {
  const v = clampParam(p, value);
  const span = p.max - p.min;
  let t: number;
  switch (p.taper.kind) {
    case 'log':
      t =
        p.min > 0 && p.max > 0 && v > 0 && p.max !== p.min
          ? Math.log(v / p.min) / Math.log(p.max / p.min)
          : span !== 0
            ? (v - p.min) / span
            : 0;
      break;
    case 'power': {
      const k = p.taper.k > 0 ? p.taper.k : 1;
      t = span !== 0 ? Math.pow((v - p.min) / span, 1 / k) : 0;
      break;
    }
    default:
      t = span !== 0 ? (v - p.min) / span : 0;
      break;
  }
  return !(t > 0) ? 0 : t > 1 ? 1 : t;
}

/** Label siap tampil untuk satu nilai parameter. */
export function formatParam(p: ParamDesc, v: number): string {
  switch (p.unit) {
    case 'choice':
      return p.choices[Math.round(v)] ?? String(v);
    case 'percent':
      return `${Math.round(v * 100)}%`;
    case 'db':
      return `${v >= 0 ? '+' : ''}${v.toFixed(1)} dB`;
    case 'hz':
      return v >= 1000 ? `${(v / 1000).toFixed(2)} kHz` : `${v.toFixed(0)} Hz`;
    case 'ms':
      return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v.toFixed(1)} ms`;
    case 'ratio':
      return `${v.toFixed(1)}:1`;
    case 'semitones':
      return `${v >= 0 ? '+' : ''}${v.toFixed(0)} st`;
    case 'degrees':
      return `${v.toFixed(0)}°`;
    default:
      return v.toFixed(2);
  }
}

/** Nilai default seluruh parameter satu efek, urut sesuai `params`. */
export function defaultParams(effect: EffectDesc): number[] {
  return effect.params.map((p) => p.default);
}

/**
 * Urai JSON dari `fxCatalogJson()`.
 *
 * Melempar kalau bentuknya tidak dikenali. Katalog yang rusak berarti panel FX
 * tidak bisa dirakit sama sekali, jadi gagal keras di sini lebih baik daripada
 * knob yang diam-diam kosong.
 */
export function parseCatalog(json: string): EffectDesc[] {
  const raw: unknown = JSON.parse(json);
  if (!Array.isArray(raw)) throw new Error('katalog FX: bukan array');
  return raw.map((e, i) => {
    const d = e as EffectDesc;
    if (typeof d.id !== 'string' || !Array.isArray(d.params)) {
      throw new Error(`katalog FX: entri ${i} tidak berbentuk EffectDesc`);
    }
    return d;
  });
}

export function catalogById(list: readonly EffectDesc[]): Map<string, EffectDesc> {
  return new Map(list.map((d) => [d.id, d]));
}
