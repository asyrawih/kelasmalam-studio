/**
 * Layout blok kontrol SharedArrayBuffer — docs/01-threads-memory.md §1b.
 *
 * SUMBER KEBENARAN GANDA (harus dijaga sinkron):
 *   - `crates/rt/src/layout.rs`      ← kanonik
 *   - `web/src/audio/sab-layout.ts`  ← file ini
 *
 * Cara regenerate / verifikasi:
 *   1. `cargo test -p daw-rt --lib -- --nocapture print_layout_json` mencetak
 *      JSON offset kanonik ke stdout (`daw_rt::layout::layout_json()`).
 *   2. `pnpm -C web test` menjalankan `sab-layout.test.ts` yang memanggil
 *      perintah itu dan membandingkannya dengan konstanta di bawah lewat
 *      `assertLayout()`. Kalau `cargo` tidak ada, tes itu skip — job `wasm`
 *      di CI yang menegakkannya.
 *   3. Kalau berbeda → JANGAN edit satu sisi saja; ubah docs/01 §1b dulu.
 *
 * Semua offset kelipatan 64 byte (satu cache line) untuk menghindari false
 * sharing: field yang ditulis dua thread berbeda tidak boleh berbagi cache line,
 * karena ping-pong cache line terlihat sebagai jitter di audio thread.
 */

/** Total alokasi blok kontrol. Terpakai 0x8600; sisanya cadangan. */
export const SAB_SIZE = 65536;

// ── BLOCK 0: TRANSPORT STATE (audio → UI, SeqLock) ────────────────────────────
export const TRANSPORT_SEQ = 0x0000; // u32, ganjil = sedang ditulis
export const TRANSPORT_STATE = 0x0004; // u32: 0=stop 1=play 2=record
export const PLAYHEAD = 0x0008; // u64
export const LOOP_START = 0x0010; // u64
export const LOOP_END = 0x0018; // u64
export const XRUN_COUNT = 0x0020; // u32
export const CPU_LOAD_Q16 = 0x0024; // u32, fraksi deadline dalam Q16

// ── BLOCK 1: COMMAND RING (UI → audio, SPSC) ──────────────────────────────────
export const CMD_WRITE_IDX = 0x0040; // u32 atomic (producer = UI)
export const CMD_READ_IDX = 0x0080; // u32 atomic (consumer = audio)
export const CMD_DATA = 0x00c0; // Command[1024] × 16 byte
export const CMD_CAPACITY = 1024; // power of two
export const CMD_STRIDE = 16; // byte per command
export const CMD_MASK = CMD_CAPACITY - 1;

// ── BLOCK 2: PARAM BLOCK (UI → audio, double-buffer) ──────────────────────────
export const PARAM_GEN = 0x40c0; // u32 atomic generation counter
export const PARAM_SLOT_A = 0x4100; // f32[2048]
export const PARAM_SLOT_B = 0x6100; // f32[2048]
export const PARAM_SLOTS = 2048;

// ── BLOCK 3: METER FEEDBACK (audio → UI, SeqLock) ─────────────────────────────
export const METER_SEQ = 0x8100; // u32
export const METER_DATA = 0x8140; // Meter[33] × 32 byte
export const METER_COUNT = 33; // 32 track + master
export const METER_STRIDE = 32;
export const METER_MASTER_INDEX = 32;
/** Offset f32 di dalam satu slot meter (dalam satuan f32, bukan byte). */
export const METER_FIELD = {
  peakL: 0,
  peakR: 1,
  rmsL: 2,
  rmsR: 3,
  gainReductionDb: 4,
  clipHoldFrames: 5, // dibaca sebagai u32 lewat Uint32Array
} as const;

// ── BLOCK 4: FLAGS ────────────────────────────────────────────────────────────
export const EXPORT_CANCEL = 0x8580; // u32 (0/1), Relaxed
export const ENGINE_FAULT = 0x8584; // u32, 0 = sehat

/** Batas akhir wilayah terpakai. */
export const SAB_USED_END = 0x8600;

/** Index Int32Array (offset byte / 4) — Atomics selalu bekerja pada index elemen. */
export const I32 = {
  transportSeq: TRANSPORT_SEQ >> 2,
  transportState: TRANSPORT_STATE >> 2,
  playheadLo: PLAYHEAD >> 2,
  playheadHi: (PLAYHEAD + 4) >> 2,
  loopStartLo: LOOP_START >> 2,
  loopStartHi: (LOOP_START + 4) >> 2,
  loopEndLo: LOOP_END >> 2,
  loopEndHi: (LOOP_END + 4) >> 2,
  xrunCount: XRUN_COUNT >> 2,
  cpuLoadQ16: CPU_LOAD_Q16 >> 2,
  cmdWriteIdx: CMD_WRITE_IDX >> 2,
  cmdReadIdx: CMD_READ_IDX >> 2,
  cmdData: CMD_DATA >> 2,
  paramGen: PARAM_GEN >> 2,
  paramSlotA: PARAM_SLOT_A >> 2,
  paramSlotB: PARAM_SLOT_B >> 2,
  meterSeq: METER_SEQ >> 2,
  meterData: METER_DATA >> 2,
  exportCancel: EXPORT_CANCEL >> 2,
  engineFault: ENGINE_FAULT >> 2,
} as const;

/**
 * Opcode command (UI → audio). Nilainya HARUS sama dengan `daw_rt::Command::op`
 * di sisi Rust. Ditulis eksplisit (bukan enum otomatis) supaya penambahan di
 * tengah tidak diam-diam menggeser nilai yang lain.
 */
export const OP = {
  NOOP: 0,
  PLAY: 1,
  STOP: 2,
  /** `at_sample` = posisi tujuan. */
  SEEK: 3,
  /** `target` = unit, `param` = bit pattern f32 dB. */
  SET_GAIN_DB: 4,
  /** `target` = unit, `param` = bit pattern f32 (-1..1). */
  SET_PAN: 5,
  /** `target` = unit, `param` = 0/1. */
  SET_MUTE: 6,
  /** `target` = track, `flags` = indeks send, `param` = bit f32 amount. */
  SET_SEND: 7,
  /** `at_sample` = awal loop. */
  SET_LOOP_START: 8,
  /** `at_sample` = akhir loop. */
  SET_LOOP_END: 9,
  /** `param` = 0/1. */
  SET_LOOP_ENABLED: 10,
  /** `target` = indeks clip di project. */
  TRIGGER_CLIP: 11,
  STOP_ALL_VOICES: 12,
} as const;

/**
 * Penomoran "unit" mixer (lihat `crates/engine/src/graph.rs`):
 * track 0..31 → unit 0..31, bus b → unit 32 + b.
 */
export const MAX_TRACKS = 32;
export function trackUnit(track: number): number {
  return track;
}
export function busUnit(bus: number): number {
  return MAX_TRACKS + bus;
}
export type OpCode = (typeof OP)[keyof typeof OP];

/** Nilai `TRANSPORT_STATE`. */
export const TRANSPORT = { STOP: 0, PLAY: 1, RECORD: 2 } as const;
export type TransportState = (typeof TRANSPORT)[keyof typeof TRANSPORT];

/**
 * Bentuk JSON yang dikeluarkan `daw_rt::layout::layout_json()`.
 * Cetak dengan:
 *   cargo test -p daw-rt --lib -- --nocapture print_layout_json
 */
export interface RustLayoutJson {
  sabSize: number;
  cacheLine: number;
  cmdCapacity: number;
  cmdEntrySize: number;
  paramSlots: number;
  meterCount: number;
  meterEntrySize: number;
  usedEnd: number;
  off: Record<string, number>;
}

/**
 * Bandingkan konstanta di file ini dengan JSON dari Rust. Melempar dengan
 * daftar SEMUA ketidakcocokan sekaligus (bukan gagal di yang pertama) supaya
 * satu run tes cukup untuk memperbaiki semuanya.
 */
export function assertLayout(rust: RustLayoutJson): void {
  const bad: string[] = [];
  const cmpOff = (rustKey: string, ts: number, tsName: string): void => {
    const got = rust.off[rustKey];
    if (got === undefined) bad.push(`${rustKey}: tidak ada di JSON Rust`);
    else if (got !== ts) bad.push(`${tsName}: TS=0x${ts.toString(16)} Rust=0x${got.toString(16)}`);
  };
  cmpOff('TRANSPORT_SEQ', TRANSPORT_SEQ, 'TRANSPORT_SEQ');
  cmpOff('TRANSPORT_STATE', TRANSPORT_STATE, 'TRANSPORT_STATE');
  cmpOff('TRANSPORT_PLAYHEAD', PLAYHEAD, 'PLAYHEAD');
  cmpOff('TRANSPORT_LOOP_START', LOOP_START, 'LOOP_START');
  cmpOff('TRANSPORT_LOOP_END', LOOP_END, 'LOOP_END');
  cmpOff('TRANSPORT_XRUN_COUNT', XRUN_COUNT, 'XRUN_COUNT');
  cmpOff('TRANSPORT_CPU_LOAD_Q16', CPU_LOAD_Q16, 'CPU_LOAD_Q16');
  cmpOff('CMD_WRITE_IDX', CMD_WRITE_IDX, 'CMD_WRITE_IDX');
  cmpOff('CMD_READ_IDX', CMD_READ_IDX, 'CMD_READ_IDX');
  cmpOff('CMD_DATA', CMD_DATA, 'CMD_DATA');
  cmpOff('PARAM_GEN', PARAM_GEN, 'PARAM_GEN');
  cmpOff('PARAM_SLOT_A', PARAM_SLOT_A, 'PARAM_SLOT_A');
  cmpOff('PARAM_SLOT_B', PARAM_SLOT_B, 'PARAM_SLOT_B');
  cmpOff('METER_SEQ', METER_SEQ, 'METER_SEQ');
  cmpOff('METER_DATA', METER_DATA, 'METER_DATA');
  cmpOff('EXPORT_CANCEL', EXPORT_CANCEL, 'EXPORT_CANCEL');
  cmpOff('PANIC_FLAG', ENGINE_FAULT, 'ENGINE_FAULT');
  cmpOff('FLAGS_END', SAB_USED_END, 'SAB_USED_END');

  const scalars: Array<[string, number, number]> = [
    ['sabSize', rust.sabSize, SAB_SIZE],
    ['cmdCapacity', rust.cmdCapacity, CMD_CAPACITY],
    ['cmdEntrySize', rust.cmdEntrySize, CMD_STRIDE],
    ['paramSlots', rust.paramSlots, PARAM_SLOTS],
    ['meterCount', rust.meterCount, METER_COUNT],
    ['meterEntrySize', rust.meterEntrySize, METER_STRIDE],
    ['usedEnd', rust.usedEnd, SAB_USED_END],
  ];
  for (const [name, r, ts] of scalars) {
    if (r !== ts) bad.push(`${name}: TS=${ts} Rust=${r}`);
  }

  // Field di dalam satu slot meter (offset byte relatif).
  const meterFields: Array<[string, number]> = [
    ['METER_FIELD_PEAK_L', METER_FIELD.peakL * 4],
    ['METER_FIELD_PEAK_R', METER_FIELD.peakR * 4],
    ['METER_FIELD_RMS_L', METER_FIELD.rmsL * 4],
    ['METER_FIELD_RMS_R', METER_FIELD.rmsR * 4],
    ['METER_FIELD_GAIN_REDUCTION_DB', METER_FIELD.gainReductionDb * 4],
    ['METER_FIELD_CLIP_HOLD_FRAMES', METER_FIELD.clipHoldFrames * 4],
  ];
  for (const [k, v] of meterFields) cmpOff(k, v, k);

  if (bad.length > 0) {
    throw new Error(`Layout SAB Rust↔TS tidak sinkron:\n  ${bad.join('\n  ')}`);
  }
}

/** Sanity check internal — tidak butuh Rust; dipanggil juga saat dev. */
export function assertNoOverlap(): void {
  const checks: Array<[string, boolean]> = [
    ['CMD_DATA muat', CMD_DATA + CMD_CAPACITY * CMD_STRIDE <= PARAM_GEN],
    ['PARAM_SLOT_A muat', PARAM_SLOT_A + PARAM_SLOTS * 4 <= PARAM_SLOT_B],
    ['PARAM_SLOT_B muat', PARAM_SLOT_B + PARAM_SLOTS * 4 <= METER_SEQ],
    ['METER muat', METER_DATA + METER_COUNT * METER_STRIDE <= EXPORT_CANCEL],
    ['FLAGS muat', ENGINE_FAULT + 4 <= SAB_USED_END],
    ['SAB cukup besar', SAB_USED_END <= SAB_SIZE],
  ];
  const bad = checks.filter(([, ok]) => !ok).map(([n]) => n);
  if (bad.length > 0) throw new Error(`Layout SAB tumpang tindih: ${bad.join(', ')}`);
}
