/**
 * Peta slot blok parameter — cermin dari `crates/engine/src/fx/params.rs`.
 *
 * Sebelum berkas ini ada, `useEngineCommands.ts` menyimpan angka-angka ini
 * sebagai konstanta lokal dengan komentar yang mengakui masalahnya sendiri:
 * "Disepakati bersama Rust; kalau berubah di sana, ubah di sini juga (tidak ada
 * cara mengeceknya otomatis)." `param-map.test.ts` menghapus kalimat itu — ia
 * menjalankan `param_map_json()` dari Rust dan membandingkannya, persis pola
 * `sab-layout.ts` + `sab-layout.test.ts`.
 *
 * ## Nilai NaN berarti "tidak dikemudikan UI"
 *
 * `commitParams()` menerbitkan SELURUH 2048 slot tiap kali, bukan hanya yang
 * berubah. Kalau slot yang belum pernah disentuh bernilai nol, engine akan
 * membacanya sebagai gain nol dan menyenyapkan seluruh project pada drag
 * pertama. Karena itu bayangan param diisi NaN saat dibuat, dan engine hanya
 * menerapkan slot yang nilainya finite. Nol tidak bisa dipakai sebagai penanda
 * kosong — nol adalah gain yang sah.
 *
 * Tata letak:
 * ```text
 *    0 ..  256  MIXER STRIP   track t → t*8   (+0 gain linear, +1 pan)
 *  256 ..  320  BUS STRIP     bus b   → 256 + b*8
 *  320 .. 1016  CADANGAN
 * 1016 .. 1024  MASTER STRIP  (1016 = gain linear)
 * 1024 .. 2048  FX PARAM ARENA
 * ```
 */

/** Jumlah slot per buffer (double-buffer A/B). */
export const PARAM_SLOTS = 2048;

/** Slot per track. */
export const PARAMS_PER_TRACK = 8;
/** Offset gain di dalam strip track. LINEAR, bukan dB. */
export const TRACK_PARAM_GAIN = 0;
/** Offset pan (−1..+1). */
export const TRACK_PARAM_PAN = 1;

/** Awal strip bus; track memakai 32 × 8 = 256 slot pertama. */
export const BUS_PARAM_BASE = 256;
/** Slot per bus. */
export const PARAMS_PER_BUS = 8;

/** Awal wilayah cadangan (otomasi, metronom). */
export const RESERVED_BASE = 320;

/** Awal strip master. */
export const MASTER_BASE = 1016;
/** Gain master. LINEAR. */
export const MASTER_PARAM_GAIN = 1016;

/** Awal arena parameter FX. */
export const FX_PARAM_BASE = 1024;
/** Kapasitas arena parameter FX. */
export const FX_PARAM_CAP = 1024;

export const trackGainSlot = (track: number): number =>
  track * PARAMS_PER_TRACK + TRACK_PARAM_GAIN;
export const trackPanSlot = (track: number): number => track * PARAMS_PER_TRACK + TRACK_PARAM_PAN;
export const busGainSlot = (bus: number): number =>
  BUS_PARAM_BASE + bus * PARAMS_PER_BUS + TRACK_PARAM_GAIN;
export const busPanSlot = (bus: number): number =>
  BUS_PARAM_BASE + bus * PARAMS_PER_BUS + TRACK_PARAM_PAN;

/** Bentuk JSON yang dicetak `daw_engine::fx::params::param_map_json`. */
export interface RustParamMapJson {
  readonly paramSlots: number;
  readonly paramsPerTrack: number;
  readonly trackParamGain: number;
  readonly trackParamPan: number;
  readonly busParamBase: number;
  readonly paramsPerBus: number;
  readonly reservedBase: number;
  readonly masterBase: number;
  readonly masterParamGain: number;
  readonly fxParamBase: number;
  readonly fxParamCap: number;
}

/** Bandingkan dengan sisi Rust; melempar pada perbedaan pertama. */
export function assertParamMap(rust: RustParamMapJson): void {
  const pairs: readonly (readonly [string, number, number])[] = [
    ['paramSlots', rust.paramSlots, PARAM_SLOTS],
    ['paramsPerTrack', rust.paramsPerTrack, PARAMS_PER_TRACK],
    ['trackParamGain', rust.trackParamGain, TRACK_PARAM_GAIN],
    ['trackParamPan', rust.trackParamPan, TRACK_PARAM_PAN],
    ['busParamBase', rust.busParamBase, BUS_PARAM_BASE],
    ['paramsPerBus', rust.paramsPerBus, PARAMS_PER_BUS],
    ['reservedBase', rust.reservedBase, RESERVED_BASE],
    ['masterBase', rust.masterBase, MASTER_BASE],
    ['masterParamGain', rust.masterParamGain, MASTER_PARAM_GAIN],
    ['fxParamBase', rust.fxParamBase, FX_PARAM_BASE],
    ['fxParamCap', rust.fxParamCap, FX_PARAM_CAP],
  ];
  for (const [name, got, want] of pairs) {
    if (got !== want) {
      throw new Error(`param-map ${name}: Rust ${got} ≠ TS ${want}`);
    }
  }
}

/** Pemeriksaan murni-TS: wilayah tidak boleh tumpang tindih. */
export function assertParamRegions(): void {
  const MAX_TRACKS = 32;
  const MAX_BUSES = 8;
  const checks: readonly (readonly [string, boolean])[] = [
    ['strip track berhenti tepat sebelum bus', MAX_TRACKS * PARAMS_PER_TRACK === BUS_PARAM_BASE],
    ['strip bus muat', BUS_PARAM_BASE + MAX_BUSES * PARAMS_PER_BUS <= RESERVED_BASE],
    ['cadangan sebelum master', RESERVED_BASE <= MASTER_BASE],
    ['master sebelum arena FX', MASTER_BASE < FX_PARAM_BASE],
    ['arena FX menutup blok', FX_PARAM_BASE + FX_PARAM_CAP === PARAM_SLOTS],
  ];
  for (const [name, ok] of checks) {
    if (!ok) throw new Error(`param-map: ${name} — gagal`);
  }
}
