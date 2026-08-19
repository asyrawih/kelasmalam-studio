/**
 * Worklet `daw-fx` — menjalankan insert chain Rust di jalur preview.
 *
 * ## Kenapa ini ada
 *
 * Chain FX hidup di engine WASM, sementara preview berbunyi lewat graf Web
 * Audio. Tanpa jembatan, efek yang dipasang user terdengar di file hasil export
 * tapi TIDAK saat diputar — dan sebaliknya, siapa pun yang "memperbaiki" itu
 * dengan menulis ulang efeknya memakai node Web Audio langsung menciptakan dua
 * implementasi yang harus dijaga tetap sama. Persis begitulah `clip.stem` bisa
 * terdengar di preview dan hilang dari file, tanpa peringatan apa pun.
 *
 * Worklet ini menjalankan `FxRack` yang SAMA dengan yang dipakai export —
 * bypass, arena, tidur, dan urutan `prepare`/`process`-nya satu implementasi.
 * Divergensi untuk efek karena itu bukan sesuatu yang dijaga disiplin; ia tidak
 * bisa terjadi.
 *
 * ## Kenapa selalu artefak `st`, bukan `mt`
 *
 * Chain FX adalah node DSP murni: tidak butuh SharedArrayBuffer, tidak butuh
 * atomics, tidak berbagi state dengan thread lain. Artefak `mt` MENGIMPOR
 * memori bersama dan semua instance-nya memulai `__stack_pointer` di alamat
 * yang sama, jadi memakainya di sini menyeret seluruh persoalan stack-per-thread
 * (lihat `audio/thread-stack.ts`) untuk keuntungan nol. `st` membawa memorinya
 * sendiri dan tetap dibangun dengan `+simd128`, jadi DSP-nya sama cepat.
 *
 * Berkas ini dibangun jadi IIFE tanpa `import` oleh `audioWorkletPlugin()` di
 * vite.config.ts — `addModule()` memuat classic script.
 */

// Global AudioWorkletGlobalScope — tidak ada di lib DOM, jadi dideklarasikan
// di sini persis seperti di `worklet-processor.ts`.
declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

/** Kuantum Web Audio. */
const RENDER_QUANTUM = 128;

interface FxProcessorOptions {
  module: WebAssembly.Module;
  /** Diskriminan `FxKind` per slot, urut. */
  kinds: Uint16Array;
  /** 1 = dipasang dalam keadaan bypass. */
  bypass: Uint8Array;
  sampleRate: number;
}

interface FxRawExports {
  memory: WebAssembly.Memory;
  scratch_alloc(len: number): number;
  scratch_free(ptr: number, len: number): void;
  fxchain_new(sampleRate: number, kinds: number, bypass: number, len: number): number;
  fxchain_free(ptr: number): void;
  fxchain_io_ptr(ptr: number): number;
  fxchain_stride(): number;
  fxchain_process(ptr: number, frames: number): void;
  fxchain_set_param(ptr: number, slot: number, index: number, value: number): void;
  fxchain_set_bypass(ptr: number, slot: number, on: number): void;
  fxchain_set_tempo(ptr: number, framesPerBeat: number): void;
}

/**
 * Isi import modul dengan stub yang melempar.
 *
 * Duplikat kecil dari `worklet-processor.ts`: keduanya adalah shim BUILD, bukan
 * DSP, jadi tidak ada perilaku audio yang bisa menyimpang di antara keduanya —
 * dan menyatukannya berarti menyunting worklet engine yang sudah bekerja.
 */
function buildStubImports(module: WebAssembly.Module): WebAssembly.Imports {
  const imports: WebAssembly.Imports = {};
  for (const desc of WebAssembly.Module.imports(module)) {
    const ns = (imports[desc.module] ??= {} as WebAssembly.ModuleImports);
    if (desc.kind === 'function') {
      ns[desc.name] = () => {
        throw new Error(`import non-RT dipanggil dari daw-fx: ${desc.module}.${desc.name}`);
      };
    } else if (desc.kind === 'global') {
      ns[desc.name] = 0 as unknown as WebAssembly.Global;
    } else if (desc.kind === 'table') {
      ns[desc.name] = new WebAssembly.Table({ initial: 0, element: 'anyfunc' });
    }
  }
  return imports;
}

/**
 * Instance WASM dipakai bersama SELURUH node `daw-fx` di scope worklet ini.
 *
 * Artefak `st` membawa memorinya sendiri, jadi meng-instansiasi modul per node
 * berarti satu memori linear per lane ber-efek — puluhan megabyte untuk kerja
 * yang muat di satu. Semua node berjalan di thread yang sama dan tidak pernah
 * saling menyela, jadi satu instance sudah cukup dan tiap node hanya memegang
 * `FxChainRt`-nya sendiri.
 */
let sharedRaw: FxRawExports | null = null;

function instantiateOnce(module: WebAssembly.Module): FxRawExports {
  if (sharedRaw === null) {
    const instance = new WebAssembly.Instance(module, buildStubImports(module));
    sharedRaw = instance.exports as unknown as FxRawExports;
  }
  return sharedRaw;
}

class FxProcessor extends AudioWorkletProcessor {
  private raw: FxRawExports | null = null;
  private chainPtr = 0;
  private ioPtr = 0;
  private stride = 0;
  private faulted = false;

  /** View di-cache TAPI divalidasi tiap blok: `memory.grow` melepas buffer
   *  lama dan view-nya jadi panjang nol TANPA melempar (docs/05). */
  private memBuffer: ArrayBufferLike | null = null;
  private io: Float32Array = new Float32Array(0);

  constructor(options: { processorOptions: FxProcessorOptions }) {
    super();
    const o = options.processorOptions;
    try {
      // Instantiasi SINKRON di constructor: constructor dijamin selesai sebelum
      // `process()` pertama, sedangkan pesan port masuk task queue dan bisa
      // kalah cepat. Hanya node pertama yang benar-benar meng-instansiasi.
      const raw = instantiateOnce(o.module);

      const n = o.kinds.length;
      let kindsPtr = 0;
      let bypassPtr = 0;
      if (n > 0) {
        kindsPtr = raw.scratch_alloc(n * 2);
        bypassPtr = raw.scratch_alloc(n);
        new Uint16Array(raw.memory.buffer, kindsPtr, n).set(o.kinds);
        new Uint8Array(raw.memory.buffer, bypassPtr, n).set(o.bypass);
      }
      const ptr = raw.fxchain_new(o.sampleRate || sampleRate, kindsPtr, bypassPtr, n);
      if (n > 0) {
        raw.scratch_free(kindsPtr, n * 2);
        raw.scratch_free(bypassPtr, n);
      }
      if (ptr === 0) throw new Error('fxchain_new mengembalikan null');

      this.raw = raw;
      this.chainPtr = ptr;
      this.ioPtr = raw.fxchain_io_ptr(ptr);
      this.stride = raw.fxchain_stride();
      this.refreshView();
      this.port.postMessage({ type: 'ready' });
    } catch (err) {
      this.faulted = true;
      this.port.postMessage({ type: 'fault', message: String(err) });
    }

    this.port.onmessage = (ev: MessageEvent) => this.onMessage(ev);
  }

  private onMessage(ev: MessageEvent): void {
    const raw = this.raw;
    if (!raw || this.faulted) return;
    const d = ev.data as {
      type?: string;
      slot?: number;
      index?: number;
      value?: number;
      on?: boolean;
      framesPerBeat?: number;
    };
    if (d.type === 'param') {
      raw.fxchain_set_param(this.chainPtr, d.slot ?? 0, d.index ?? 0, d.value ?? 0);
    } else if (d.type === 'tempo') {
      // Tanpa ini `ParamCtx::frames_per_beat` tetap di nilai lahirnya (120 BPM)
      // dan tiap parameter bersatuan Beats berhitung di tempo itu — gejalanya
      // cuma bisa DIDENGAR sebagai "echo 1/4 ketukan tidak nyambung".
      raw.fxchain_set_tempo(this.chainPtr, d.framesPerBeat ?? 0);
    } else if (d.type === 'bypass') {
      raw.fxchain_set_bypass(this.chainPtr, d.slot ?? 0, d.on ? 1 : 0);
    } else if (d.type === 'dispose') {
      raw.fxchain_free(this.chainPtr);
      this.chainPtr = 0;
      this.raw = null;
    }
  }

  private refreshView(): void {
    const raw = this.raw;
    if (!raw) return;
    this.memBuffer = raw.memory.buffer;
    this.io = new Float32Array(raw.memory.buffer, this.ioPtr, this.stride * 2);
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const raw = this.raw;

    // Node yang gagal dibangun melewatkan sinyal apa adanya, bukan menyenyapkan
    // lagunya. Efek yang hilang jauh lebih baik daripada audio yang hilang.
    const passthrough = (): boolean => {
      const src = inputs[0];
      for (let c = 0; c < out.length; c += 1) {
        const dst = out[c]!;
        const s = src?.[Math.min(c, (src.length || 1) - 1)];
        if (s && s.length === dst.length) dst.set(s);
        else dst.fill(0);
      }
      return true;
    };
    if (!raw || this.faulted || this.chainPtr === 0) return passthrough();

    const src = inputs[0];
    if (!src || src.length === 0) {
      for (const ch of out) ch.fill(0);
      return true;
    }

    const n = Math.min(out[0]!.length, RENDER_QUANTUM);
    if (this.memBuffer !== raw.memory.buffer || this.io.length === 0) this.refreshView();
    if (this.io.length < this.stride * 2) return passthrough();

    const l = src[0]!;
    // Input mono disalin ke dua kanal: chain-nya stereo, dan memprosesnya
    // sebagai mono akan menghilangkan efek yang memang stereo (ping-pong,
    // flanger beda fase).
    const r = src[1] ?? l;
    this.io.set(l.subarray(0, n), 0);
    this.io.set(r.subarray(0, n), this.stride);

    raw.fxchain_process(this.chainPtr, n);

    out[0]!.set(this.io.subarray(0, n));
    if (out.length > 1) out[1]!.set(this.io.subarray(this.stride, this.stride + n));
    for (let c = 2; c < out.length; c += 1) out[c]!.fill(0);
    return true;
  }
}

registerProcessor('daw-fx', FxProcessor);
