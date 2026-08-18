/**
 * AudioWorkletProcessor DawOnWeb.
 *
 * File ini di-build sebagai entry TERPISAH berformat **IIFE** (lihat
 * `audioWorkletPlugin()` di vite.config.ts): `audioWorklet.addModule()` memuat
 * file sebagai *classic script*, jadi tidak boleh ada satu pun `import`
 * statement di hasil build. Karena itu file ini tidak meng-import apa pun dari
 * modul lain — konstanta layout diduplikasi di bawah dan dijaga oleh tes
 * `sab-layout.test.ts`. (Duplikasi ini disengaja; men-share modul akan
 * memaksa bundler menghasilkan ESM.)
 *
 * Aturan keras di dalam `process()` (docs/01 §1c, docs/05):
 *   - NOL alokasi, nol `postMessage` per blok, nol string.
 *   - Selalu `return true` — mengembalikan `false` menghapus node permanen.
 *   - Tidak boleh melempar: exception apa pun menempatkan node di state error
 *     permanen dan `process()` tidak akan pernah dipanggil lagi (senyap total).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── Ambient AudioWorklet scope (tidak ada di lib.dom) ────────────────────────
declare const sampleRate: number;
declare const currentFrame: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

// ── Konstanta layout (mirror sab-layout.ts — lihat catatan di atas) ──────────
const IDX_XRUN_COUNT = 0x0020 >> 2;
const IDX_CPU_LOAD_Q16 = 0x0024 >> 2;
const IDX_ENGINE_FAULT = 0x8584 >> 2;
const SAB_SIZE = 65536;

const RENDER_QUANTUM = 128;
/** EMA CPU load: koefisien untuk ~200 blok (≈0.5 s @48k). */
const CPU_EMA_ALPHA = 0.005;

/** Bentuk `processorOptions` — HARUS sama dengan `engine-client.ts`. */
interface DawProcessorOptions {
  /** Modul yang sudah dikompilasi di main thread (structured-cloneable). */
  module: WebAssembly.Module;
  /** Linear memory bersama; `shared: true` di jalur isolated. */
  memory: WebAssembly.Memory;
  /** Offset blok kontrol di dalam `memory`. */
  controlPtr: number;
  /** Stack privat thread ini (lihat audio/thread-stack.ts). `null` di jalur st. */
  stack: { ptr: number; top: number } | null;
  /** `ctx.sampleRate` apa adanya — jangan dipaksa 48k (docs/05 §Safari). */
  sampleRate: number;
  /** Blok maksimum yang akan diminta; biasanya 128. */
  maxFrames: number;
  /** true kalau memory shared (jalur SAB). */
  shared: boolean;
}

/** Export mentah dari `crates/wasm-bridge/src/raw.rs`. */
interface RawExports {
  memory?: WebAssembly.Memory;
  /** Global `__stack_pointer` — ada hanya di artefak mt yang mengekspornya. */
  __stack_pointer?: WebAssembly.Global;
  engine_new(sampleRate: number, ctlPtr: number, maxFrames: number): number;
  engine_free(ptr: number): void;
  engine_process(ptr: number, frames: number): number;
  engine_out_ptr(ptr: number): number;
  engine_out_stride(): number;
  engine_out_channels(): number;
  engine_seek(ptr: number, lo: number, hi: number): void;
  engine_push_command(
    ptr: number,
    op: number,
    flags: number,
    target: number,
    param: number,
    atLo: number,
    atHi: number,
  ): void;
  engine_load_snapshot(ptr: number, bytes: number, len: number): number;
  engine_latch_params(ptr: number, values: number, len: number): void;
  scratch_alloc(len: number): number;
  scratch_free(ptr: number, len: number): void;
  abi_version(): number;
}

/**
 * Modul membawa DUA surface; surface bindgen menimbulkan import
 * `./engine_bg.js` / `__wbindgen_*` yang tidak pernah dipanggil dari worklet.
 * Instantiate tetap butuh semuanya terisi, jadi kita bangun stub dari
 * `WebAssembly.Module.imports()`. Stub yang terpanggil = bug; ia melempar,
 * tapi hanya di luar `process()` karena hot path tidak menyentuh bindgen.
 */
function buildStubImports(
  module: WebAssembly.Module,
  memory: WebAssembly.Memory,
): WebAssembly.Imports {
  const imports: WebAssembly.Imports = {};
  for (const desc of WebAssembly.Module.imports(module)) {
    const ns = (imports[desc.module] ??= {} as WebAssembly.ModuleImports);
    if (desc.kind === 'memory') {
      ns[desc.name] = memory;
    } else if (desc.kind === 'function') {
      ns[desc.name] = () => {
        throw new Error(`import non-RT dipanggil dari worklet: ${desc.module}.${desc.name}`);
      };
    } else if (desc.kind === 'global') {
      ns[desc.name] = 0 as unknown as WebAssembly.Global;
    } else if (desc.kind === 'table') {
      ns[desc.name] = new WebAssembly.Table({ initial: 0, element: 'anyfunc' });
    }
  }
  return imports;
}

class DawProcessor extends AudioWorkletProcessor {
  private readonly memory: WebAssembly.Memory;
  private readonly raw: RawExports | null = null;
  private readonly enginePtr: number = 0;
  private readonly ctl: Int32Array | null = null;

  /** View output yang di-cache TAPI divalidasi tiap blok (docs/05). */
  private memBuffer: ArrayBufferLike | null = null;
  private outView: Float32Array = new Float32Array(0);
  private outPtr = 0;
  private outStride = 0;
  private outChannels = 2;

  private lastFrame = -1;
  private cpuEma = 0;
  private readonly deadlineMs: number;
  private readonly hasPerfNow = typeof performance !== 'undefined' && !!performance.now;
  private faulted = false;

  constructor(options: { processorOptions: DawProcessorOptions }) {
    super();
    const o = options.processorOptions;
    this.memory = o.memory;
    this.deadlineMs = (RENDER_QUANTUM / (o.sampleRate || sampleRate)) * 1000;

    try {
      // Instantiasi SINKRON di constructor. Constructor dijamin selesai sebelum
      // `process()` pertama — itulah alasan modul dikirim lewat processorOptions
      // dan bukan port.postMessage (yang masuk task queue, bisa kalah cepat).
      // `new WebAssembly.Instance(module, ...)` legal di worklet; yang dilarang
      // adalah KOMPILASI sinkron modul besar, bukan instantiasi.
      const instance = new WebAssembly.Instance(
        o.module,
        buildStubImports(o.module, o.memory),
      );
      const raw = instance.exports as unknown as RawExports;

      // HAL PERTAMA sesudah instantiate, sebelum satu pun fungsi ber-bingkai
      // dipanggil. Semua instance dari modul mt memulai `__stack_pointer` di
      // alamat yang SAMA, jadi tanpa langkah ini stack worklet tumbuh persis di
      // atas stack main thread dan keduanya saling menimpa — kerusakannya baru
      // meledak jauh kemudian, di kode yang tidak bersalah (lihat
      // audio/thread-stack.ts). `engine_new` di bawah sudah memakai stack, jadi
      // urutan dua baris ini tidak boleh ditukar.
      if (o.stack !== null && raw.__stack_pointer !== undefined) {
        raw.__stack_pointer.value = o.stack.top;
      }

      const ptr = raw.engine_new(o.sampleRate || sampleRate, o.controlPtr, o.maxFrames || RENDER_QUANTUM);
      if (ptr === 0) throw new Error('engine_new mengembalikan null');

      this.raw = raw;
      this.enginePtr = ptr;
      this.outPtr = raw.engine_out_ptr(ptr);
      this.outStride = raw.engine_out_stride();
      this.outChannels = raw.engine_out_channels();
      this.ctl = new Int32Array(o.memory.buffer, o.controlPtr, SAB_SIZE / 4);
      this.refreshView();

      this.port.postMessage({ type: 'ready', abi: raw.abi_version() });
    } catch (err) {
      this.faulted = true;
      // Error dilaporkan SEKALI di sini, bukan dari process().
      this.port.postMessage({ type: 'fault', message: String(err) });
    }

    // Jalur degraded (tanpa SAB): command datang batched lewat port. Diproses
    // di message handler — DI LUAR process() — lalu langsung diterapkan.
    this.port.onmessage = (ev: MessageEvent) => this.onMessage(ev);
  }

  private onMessage(ev: MessageEvent): void {
    const raw = this.raw;
    if (!raw || this.faulted) return;
    const data = ev.data as {
      type?: string;
      cmds?: Int32Array;
      lo?: number;
      hi?: number;
      ptr?: number;
      len?: number;
      bytes?: Uint8Array;
      values?: Float32Array;
    };
    if (data.type === 'snapshot') {
      // Jalur shared: main thread sudah menyalin bytes ke linear memory dan
      // hanya mengirim (ptr,len). Jalur degraded: bytes ikut lewat postMessage
      // (transferable) dan disalin ke scratch di sini.
      let ptr = data.ptr ?? 0;
      let len = data.len ?? 0;
      let owned = false;
      if (data.bytes) {
        len = data.bytes.length;
        ptr = raw.scratch_alloc(len);
        new Uint8Array(this.memory.buffer, ptr, len).set(data.bytes);
        owned = true;
      }
      const ok = ptr !== 0 ? raw.engine_load_snapshot(this.enginePtr, ptr, len) : 0;
      if (owned) raw.scratch_free(ptr, len);
      // Pointer output bisa berubah kalau engine diganti; ambil ulang.
      this.outPtr = raw.engine_out_ptr(this.enginePtr);
      this.refreshView();
      this.port.postMessage({ type: 'snapshot-applied', ok: ok === 1 });
      return;
    }
    if (data.type === 'commands' && data.cmds) {
      // 6 word per command: op, flags, target, param, atLo, atHi
      const c = data.cmds;
      for (let i = 0; i + 5 < c.length; i += 6) {
        raw.engine_push_command(
          this.enginePtr,
          c[i]!,
          c[i + 1]!,
          c[i + 2]!,
          c[i + 3]!,
          c[i + 4]!,
          c[i + 5]!,
        );
      }
    } else if (data.type === 'params' && data.values) {
      // Jalur degraded saja: di jalur shared, UI menulis langsung ke blok
      // kontrol dan engine_process yang menyalinnya, jadi pesan ini tidak
      // pernah dikirim. Nilai lewat scratch MILIK worklet — `controlPtr` yang
      // dioperkan berasal dari instance main thread dan di mode `st` menunjuk
      // memori linear yang berbeda.
      const v = data.values;
      const bytes = v.length * 4;
      const ptr = raw.scratch_alloc(bytes);
      if (ptr !== 0) {
        new Float32Array(this.memory.buffer, ptr, v.length).set(v);
        raw.engine_latch_params(this.enginePtr, ptr, v.length);
        raw.scratch_free(ptr, bytes);
      }
    } else if (data.type === 'seek') {
      raw.engine_seek(this.enginePtr, data.lo ?? 0, data.hi ?? 0);
    } else if (data.type === 'dispose') {
      raw.engine_free(this.enginePtr);
      this.faulted = true;
    }
  }

  /**
   * Re-acquire view output. Satu perbandingan referensi per blok; `memory.grow`
   * di thread lain (import asset) membuat view lama panjang 0 tanpa error.
   */
  private refreshView(): void {
    this.memBuffer = this.memory.buffer;
    this.outView = new Float32Array(
      this.memory.buffer,
      this.outPtr,
      this.outStride * this.outChannels,
    );
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const raw = this.raw;

    // Belum siap / fault → senyap, tapi TETAP hidup. `return false` akan
    // menghapus node dan tidak bisa dipulihkan.
    if (!raw || this.faulted || !out || out.length === 0) {
      if (out) for (let ch = 0; ch < out.length; ch++) out[ch]!.fill(0);
      return true;
    }

    const frames = out[0]!.length;

    // ── Deteksi xrun lewat gap currentFrame (docs/05) ────────────────────────
    if (this.lastFrame >= 0) {
      const expected = this.lastFrame + frames;
      if (currentFrame > expected) {
        const lost = ((currentFrame - expected) / frames) | 0;
        if (lost > 0 && this.ctl) Atomics.add(this.ctl, IDX_XRUN_COUNT, lost);
      }
    }
    this.lastFrame = currentFrame;

    const t0 = this.hasPerfNow ? performance.now() : 0;

    const rendered = raw.engine_process(this.enginePtr, frames);

    // ── Salin planar WASM → outputs[0][ch] ──────────────────────────────────
    if (this.outView.length === 0 || this.memBuffer !== this.memory.buffer) {
      this.refreshView();
    }
    const view = this.outView;
    const stride = this.outStride;
    const nch = out.length;
    for (let ch = 0; ch < nch; ch++) {
      const dst = out[ch]!;
      // Mono output dari sumber stereo: pakai channel 0. Channel > 1 di output
      // yang lebih lebar dari engine → ulangi channel terakhir engine.
      const src = ch < this.outChannels ? ch : this.outChannels - 1;
      const base = src * stride;
      if (rendered === frames && view.length >= base + frames) {
        // `set` dengan subarray tidak mengalokasi buffer baru (subarray hanya
        // membuat view; V8 meng-inline jalur ini).
        dst.set(view.subarray(base, base + frames));
      } else {
        dst.fill(0);
      }
    }

    // ── CPU load EMA → SAB ──────────────────────────────────────────────────
    if (this.hasPerfNow && this.ctl) {
      const elapsed = performance.now() - t0;
      const load = elapsed / this.deadlineMs;
      this.cpuEma += CPU_EMA_ALPHA * (load - this.cpuEma);
      // Q16, di-clamp: nilai >4.0 tidak informatif dan bisa overflow tampilan.
      const q16 = Math.min(this.cpuEma, 4) * 65536;
      Atomics.store(this.ctl, IDX_CPU_LOAD_Q16, q16 | 0);
    }

    return true;
  }
}

// Nama harus sama dengan yang dipakai `new AudioWorkletNode(ctx, PROCESSOR_NAME)`.
registerProcessor('daw-engine', DawProcessor);

// Menandai file sebagai modul untuk TS tanpa menghasilkan import/export di
// output IIFE (bundler menghapusnya; `export {}` tidak menghasilkan statement).
export {};

// Referensi supaya konstanta fault tidak dianggap tak terpakai oleh linter —
// dipakai oleh main thread lewat blok kontrol, bukan dari sini.
void IDX_ENGINE_FAULT;
