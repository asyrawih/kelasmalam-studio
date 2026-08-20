/**
 * `EngineClient` — SATU-SATUNYA permukaan publik audio untuk lapisan UI/state.
 *
 *   import { EngineClient } from '../audio/engine-client';
 *
 * UI tidak boleh menyentuh `worklet-processor.ts`, `sab-layout.ts`, atau modul
 * WASM secara langsung. Semua yang dibutuhkan UI ada di file ini: lifecycle
 * AudioContext, command transport/track/clip, pembacaan meter & playhead, dan
 * orkestrasi export.
 *
 * Kontrak penting untuk pemanggil:
 *  - `create()` HARUS dipanggil dari dalam handler gesture user (klik/tap),
 *    karena `AudioContext.resume()` hanya berhasil di sana (docs/05 §Safari).
 *  - `readTransport()` dan `readMeters()` dirancang untuk dipanggil dari rAF.
 *    Keduanya nol-alokasi kalau diberi buffer keluaran (`readMetersInto`).
 *  - Semua posisi dalam **sample absolut** (number; aman sampai 2^53), tidak
 *    pernah detik float (docs/00 aturan 4).
 */

import { degradedMatrix, degradedReasons, type Caps, type DegradedMatrix } from './caps';
import {
  CMD_CAPACITY,
  CMD_MASK,
  CMD_STRIDE,
  I32,
  METER_COUNT,
  METER_MASTER_INDEX,
  METER_STRIDE,
  OP,
  PARAM_SLOTS,
  busUnit,
  trackUnit,
  TRANSPORT,
  assertNoOverlap,
  type OpCode,
  type TransportState,
} from './sab-layout';
import type { ThreadStack } from './thread-stack';
import { loadWasm, type LoadedWasm } from './wasm-loader';

export const PROCESSOR_NAME = 'daw-engine';

/** Payload `processorOptions` — mirror dari `DawProcessorOptions` di worklet. */
export interface ProcessorOptionsPayload {
  module: WebAssembly.Module;
  memory: WebAssembly.Memory;
  controlPtr: number;
  /** Stack privat worklet — lihat audio/thread-stack.ts. `null` di jalur st. */
  stack: ThreadStack | null;
  sampleRate: number;
  maxFrames: number;
  shared: boolean;
}

export interface TransportSnapshot {
  readonly state: TransportState;
  readonly playhead: number;
  readonly loopStart: number;
  readonly loopEnd: number;
  readonly xruns: number;
  /** Fraksi deadline yang terpakai (EMA). >0.75 = mulai berbahaya (docs/05). */
  readonly cpuLoad: number;
}

export interface MeterFrame {
  peakL: number;
  peakR: number;
  rmsL: number;
  rmsR: number;
  gainReductionDb: number;
}

export interface EngineClientOptions {
  /**
   * URL file worklet (classic script IIFE). Di aplikasi:
   *   import workletUrl from './audio/worklet-processor.ts?worklet&url';
   * Plugin `audioWorkletPlugin()` di vite.config.ts yang menghasilkannya.
   */
  workletUrl: string;
  /** AudioContext yang sudah dibuat di gesture user; kalau tidak ada, dibuat. */
  context?: AudioContext;
  /** Dipanggil kalau engine masuk state fatal. */
  onFault?: (message: string) => void;
}

const CMD_WORDS = CMD_STRIDE / 4; // 4 word u32 per command

export class EngineClient {
  private readonly wasm: LoadedWasm;
  private readonly ctx: AudioContext;
  private readonly node: AudioWorkletNode;
  private readonly shared: boolean;
  private readonly onFault?: (m: string) => void;

  /** Buffer command untuk jalur degraded — dikirim batched, dipakai ulang. */
  private pending: number[] = [];
  private flushScheduled = false;

  /** Slot param double-buffer yang sedang disiapkan (bayangan lokal). */
  /**
   * Bayangan blok param. Diisi **NaN**, bukan nol.
   *
   * `commitParams()` menerbitkan SELURUH slot tiap kali, bukan hanya yang
   * berubah. Kalau slot yang belum pernah disentuh bernilai nol, engine
   * membacanya sebagai gain nol — dan geseran pertama pada SATU fader akan
   * menyenyapkan seluruh project. NaN berarti "tidak dikemudikan UI", dan
   * engine melewatinya. Nol tidak bisa dipakai sebagai penanda kosong karena
   * nol adalah gain yang sah (lihat `param-map.ts`).
   */
  private readonly paramShadow = new Float32Array(PARAM_SLOTS).fill(NaN);
  private paramDirty = false;

  private disposed = false;

  private constructor(wasm: LoadedWasm, ctx: AudioContext, node: AudioWorkletNode, opts: EngineClientOptions) {
    this.wasm = wasm;
    this.ctx = ctx;
    this.node = node;
    this.shared = wasm.variant === 'mt' && wasm.caps.sab;
    this.onFault = opts.onFault;

    node.port.onmessage = (ev: MessageEvent) => {
      const d = ev.data as { type?: string; message?: string };
      if (d.type === 'fault') this.onFault?.(d.message ?? 'engine fault');
    };
  }

  /** Bangun engine. Panggil dari handler gesture user. */
  static async create(opts: EngineClientOptions): Promise<EngineClient> {
    assertNoOverlap();
    const wasm = await loadWasm();

    // JANGAN memaksa sampleRate: Safari/macOS mengikuti device, dan memaksa
    // memicu resampling internal (docs/05 §Safari).
    const ctx = opts.context ?? new AudioContext({ latencyHint: 'interactive' });
    if (ctx.state !== 'running') await ctx.resume().catch(() => undefined);

    await ctx.audioWorklet.addModule(opts.workletUrl);

    const processorOptions: ProcessorOptionsPayload = {
      module: wasm.module,
      memory: wasm.memory,
      controlPtr: wasm.controlPtr,
      // Dialokasi DI SINI, di main thread, sebelum worklet ada. Mengalokasinya
      // dari dalam worklet berarti `malloc` sudah berjalan di atas stack yang
      // bertabrakan — persis yang mau dihindari.
      stack: wasm.newThreadStack(),
      sampleRate: ctx.sampleRate,
      maxFrames: 128,
      shared: wasm.variant === 'mt' && wasm.caps.sab,
    };

    const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions,
    });
    node.connect(ctx.destination);

    return new EngineClient(wasm, ctx, node, opts);
  }

  get caps(): Caps {
    return this.wasm.caps;
  }
  get degraded(): DegradedMatrix {
    return degradedMatrix(this.wasm.caps);
  }
  get degradedNotes(): string[] {
    return degradedReasons(this.wasm.caps);
  }
  get sampleRate(): number {
    return this.ctx.sampleRate;
  }
  get audioContext(): AudioContext {
    return this.ctx;
  }

  /** Idempoten & murah — panggil di setiap handler klik (docs/05 §Safari). */
  async unlock(): Promise<void> {
    if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => undefined);
  }

  // ── Command API ───────────────────────────────────────────────────────────

  play(atSample = 0): void {
    this.push(OP.PLAY, 0, 0, 0, atSample);
  }
  stop(): void {
    this.push(OP.STOP, 0, 0, 0, 0);
  }
  /**
   * CATATAN: engine memperlakukan `at_sample` sekaligus sebagai payload DAN
   * sebagai jadwal (`apply()` menunda command yang `at_sample > playhead`).
   * Untuk seek maju, engine menjadwalkannya ke posisi itu — efeknya sama
   * dengan "lompat ke sana saat sampai", jadi UI harus menghentikan transport
   * dulu kalau ingin lompat seketika ke depan.
   */
  seek(sample: number): void {
    this.push(OP.SEEK, 0, 0, 0, sample);
  }
  setLoop(start: number, end: number): void {
    this.push(OP.SET_LOOP_START, 0, 0, 0, start);
    this.push(OP.SET_LOOP_END, 0, 0, 0, end);
  }
  setLoopEnabled(on: boolean): void {
    this.push(OP.SET_LOOP_ENABLED, 0, 0, on ? 1 : 0, 0);
  }

  /** Gain track dalam dB. `track` = indeks track (0..31). */
  setTrackGain(track: number, db: number): void {
    this.push(OP.SET_GAIN_DB, 0, trackUnit(track), f32bits(db), 0);
  }
  /** Gain bus dalam dB. Master adalah salah satu bus di project model. */
  setBusGain(bus: number, db: number): void {
    this.push(OP.SET_GAIN_DB, 0, busUnit(bus), f32bits(db), 0);
  }
  setPan(track: number, pan: number): void {
    this.push(OP.SET_PAN, 0, trackUnit(track), f32bits(clamp(pan, -1, 1)), 0);
  }
  setMute(track: number, on: boolean): void {
    this.push(OP.SET_MUTE, 0, trackUnit(track), on ? 1 : 0, 0);
  }
  /**
   * Solo TIDAK ada sebagai op engine — itu keputusan yang benar: solo adalah
   * fungsi dari state UI (track mana yang solo), dan menerjemahkannya jadi
   * mute pada track lain menjaga engine bebas dari state turunan.
   */
  setSolo(soloedTracks: readonly number[], allTracks: readonly number[]): void {
    const any = soloedTracks.length > 0;
    for (const t of allTracks) this.setMute(t, any && !soloedTracks.includes(t));
  }
  /** `send` = indeks send pada track (0..MAX_SENDS-1), `amount` linear. */
  setSend(track: number, send: number, amount: number): void {
    this.push(OP.SET_SEND, send, trackUnit(track), f32bits(amount), 0);
  }

  /** Bunyikan satu clip (indeks clip di project snapshot). */
  triggerClip(clipIndex: number, atSample = 0): void {
    this.push(OP.TRIGGER_CLIP, 0, clipIndex, 0, atSample);
  }
  stopAllVoices(): void {
    this.push(OP.STOP_ALL_VOICES, 0, 0, 0, 0);
  }

  /**
   * Edit struktural (tambah/pindah/trim/fade clip, tempo map, routing) TIDAK
   * lewat command ring: model project adalah satu sumber kebenaran di Rust,
   * dan perubahannya dikirim sebagai snapshot baru lewat `loadProject()`.
   * Command ring khusus untuk yang harus sample-accurate & sering: transport,
   * gain, pan, mute, send, trigger.
   */

  /**
   * Set parameter kontinu (fader/knob) lewat blok param double-buffer.
   * Lebih murah dari command untuk nilai yang berubah tiap frame UI: tulis
   * sebanyak apa pun, lalu `commitParams()` sekali per rAF.
   */
  setParam(slot: number, value: number): void {
    if (slot < 0 || slot >= PARAM_SLOTS) return;
    this.paramShadow[slot] = value;
    this.paramDirty = true;
  }

  /**
   * Publikasikan blok param. Ordering docs/01 §1b: UI menulis ke slot
   * `(gen+1) & 1`, LALU `Atomics.store` (Release implisit di `Atomics.store`)
   * pada `param_gen`. Audio thread membaca `gen` dengan Acquire dan memakai
   * slot `gen & 1` — jadi ia tidak pernah melihat slot yang setengah tertulis.
   */
  commitParams(): void {
    if (!this.paramDirty) return;
    this.paramDirty = false;
    if (!this.shared) {
      this.node.port.postMessage({ type: 'params', values: this.paramShadow.slice() });
      return;
    }
    const i32 = this.i32();
    const f32 = this.f32();
    const gen = Atomics.load(i32, I32.paramGen);
    const nextGen = (gen + 1) >>> 0;
    const base = (nextGen & 1) === 0 ? I32.paramSlotA : I32.paramSlotB;
    f32.set(this.paramShadow, base);
    Atomics.store(i32, I32.paramGen, nextGen | 0);
  }

  /**
   * Kirim snapshot project ke engine realtime. Di jalur shared, bytes disalin
   * ke linear memory dan hanya (ptr,len) yang di-postMessage. Di jalur degraded
   * bytes-nya ditransfer (zero-copy pindah kepemilikan).
   */
  loadProject(snapshot: Uint8Array): void {
    // Bytes ditransfer (zero-copy pindah kepemilikan); worklet menyalinnya ke
    // scratch-nya sendiri lalu memanggil `engine_load_snapshot` DI LUAR
    // process(). Ukurannya puluhan KB dan ini bukan hot path, jadi jalur shared
    // dan degraded sengaja sama — satu jalur lebih sedikit untuk salah.
    const copy = snapshot.slice();
    this.node.port.postMessage({ type: 'snapshot', bytes: copy }, [copy.buffer]);
  }

  // ── Pembacaan state (dipanggil dari rAF) ──────────────────────────────────

  /**
   * Baca blok transport dengan retry SeqLock. Kalau writer sedang menulis
   * (seq ganjil) atau seq berubah di tengah, ulangi — maksimal beberapa kali,
   * lalu kembalikan nilai terakhir. UI tidak boleh spin tanpa batas.
   */
  readTransport(): TransportSnapshot {
    const fallback: TransportSnapshot = {
      state: TRANSPORT.STOP,
      playhead: 0,
      loopStart: 0,
      loopEnd: 0,
      xruns: 0,
      cpuLoad: 0,
    };
    if (!this.shared) return this.lastTransport ?? fallback;

    const i32 = this.i32();
    for (let attempt = 0; attempt < 8; attempt++) {
      const s0 = Atomics.load(i32, I32.transportSeq);
      if (s0 & 1) continue;
      const snap: TransportSnapshot = {
        state: i32[I32.transportState] as TransportState,
        playhead: u64(i32[I32.playheadLo]!, i32[I32.playheadHi]!),
        loopStart: u64(i32[I32.loopStartLo]!, i32[I32.loopStartHi]!),
        loopEnd: u64(i32[I32.loopEndLo]!, i32[I32.loopEndHi]!),
        xruns: i32[I32.xrunCount]! >>> 0,
        cpuLoad: (i32[I32.cpuLoadQ16]! >>> 0) / 65536,
      };
      if (Atomics.load(i32, I32.transportSeq) === s0) {
        this.lastTransport = snap;
        return snap;
      }
    }
    return this.lastTransport ?? fallback;
  }
  private lastTransport: TransportSnapshot | null = null;

  /**
   * Baca meter ke buffer yang disediakan pemanggil — NOL alokasi per frame.
   * `out` harus punya panjang `METER_COUNT` (32 track + master di index 32).
   */
  readMetersInto(out: MeterFrame[]): boolean {
    if (!this.shared || out.length < METER_COUNT) return false;
    const i32 = this.i32();
    const f32 = this.f32();
    for (let attempt = 0; attempt < 8; attempt++) {
      const s0 = Atomics.load(i32, I32.meterSeq);
      if (s0 & 1) continue;
      const base = I32.meterData;
      const stride = METER_STRIDE / 4;
      for (let i = 0; i < METER_COUNT; i++) {
        const o = base + i * stride;
        const m = out[i]!;
        m.peakL = f32[o]!;
        m.peakR = f32[o + 1]!;
        m.rmsL = f32[o + 2]!;
        m.rmsR = f32[o + 3]!;
        m.gainReductionDb = f32[o + 4]!;
      }
      if (Atomics.load(i32, I32.meterSeq) === s0) return true;
    }
    return false;
  }

  /** Helper: buat buffer meter kosong dengan panjang yang benar. */
  static createMeterBuffer(): MeterFrame[] {
    return Array.from({ length: METER_COUNT }, () => ({
      peakL: 0,
      peakR: 0,
      rmsL: 0,
      rmsR: 0,
      gainReductionDb: 0,
    }));
  }

  static readonly MASTER_METER_INDEX = METER_MASTER_INDEX;

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.node.port.postMessage({ type: 'dispose' });
    this.node.disconnect();
    await this.ctx.close().catch(() => undefined);
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private i32(): Int32Array {
    // View diambil ulang tiap kali: `memory.grow` (import asset) membuat view
    // lama panjang 0 tanpa error apa pun (docs/05).
    return new Int32Array(this.wasm.memory.buffer, this.wasm.controlPtr, 65536 / 4);
  }
  private f32(): Float32Array {
    return new Float32Array(this.wasm.memory.buffer, this.wasm.controlPtr, 65536 / 4);
  }

  /**
   * Tulis satu command ke ring SPSC.
   *
   * ORDERING (docs/01 §1b — jangan diubah tanpa membaca tabelnya):
   *   1. tulis payload `cmd_data[i]` dengan store BIASA (bukan atomic),
   *   2. `Atomics.store(cmd_write_idx, i+1)` — ini Release: menjamin payload
   *      sudah terlihat consumer SEBELUM index maju. Tanpa ini audio thread
   *      bisa melihat index baru dengan payload lama → memproses sampah.
   * Pembacaan `cmd_read_idx` memakai `Atomics.load` (Acquire) untuk menghitung
   * ruang kosong. Kalau ring penuh, command DIBUANG (bukan menunggu): producer
   * UI tidak boleh blok, dan kehilangan satu gerakan fader jauh lebih baik
   * daripada UI membeku.
   */
  private push(op: OpCode, flags: number, target: number, param: number, atSample: number): void {
    if (this.disposed) return;
    if (!this.shared) {
      // Jalur degraded: kumpulkan dan kirim batched per rAF (docs/01 §1d).
      this.pending.push(op, flags, target, param, atSample >>> 0, Math.floor(atSample / 2 ** 32));
      this.scheduleFlush();
      return;
    }
    const i32 = this.i32();
    const w = Atomics.load(i32, I32.cmdWriteIdx) >>> 0;
    const r = Atomics.load(i32, I32.cmdReadIdx) >>> 0;
    if (((w - r) >>> 0) >= CMD_CAPACITY) return; // ring penuh → drop
    const slot = I32.cmdData + (w & CMD_MASK) * CMD_WORDS;

    // Layout Command (16 byte): [op|flags|target(u16)] [param u32] [at u64]
    i32[slot] = (op & 0xff) | ((flags & 0xff) << 8) | ((target & 0xffff) << 16);
    i32[slot + 1] = param | 0;
    i32[slot + 2] = atSample >>> 0;
    i32[slot + 3] = Math.floor(atSample / 2 ** 32) | 0;

    Atomics.store(i32, I32.cmdWriteIdx, (w + 1) | 0);
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    const flush = () => {
      this.flushScheduled = false;
      if (this.pending.length === 0) return;
      const cmds = Int32Array.from(this.pending);
      this.pending.length = 0;
      this.node.port.postMessage({ type: 'commands', cmds }, [cmds.buffer]);
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
    else setTimeout(flush, 16);
  }
}

/** Bit pattern f32 → u32, supaya nilai float muat di field `param` (u32). */
const BITS_BUF = new ArrayBuffer(4);
const BITS_F32 = new Float32Array(BITS_BUF);
const BITS_I32 = new Int32Array(BITS_BUF);
function f32bits(v: number): number {
  BITS_F32[0] = v;
  return BITS_I32[0]!;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function u64(lo: number, hi: number): number {
  return (lo >>> 0) + (hi >>> 0) * 2 ** 32;
}
