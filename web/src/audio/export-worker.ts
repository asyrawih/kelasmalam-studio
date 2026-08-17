/**
 * Export worker — offline render loop (docs/03 §3a).
 *
 * Meng-instantiate engine **KEDUA** dari snapshot project. Bukan demi kecepatan
 * saja: engine punya state DSP yang berevolusi (biquad s1/s2, envelope
 * compressor, delay line, cursor voice). Dua thread yang merender dari state
 * yang sama menghasilkan output rusak & non-deterministik, dan playhead
 * realtime tidak bisa berada di dua tempat sekaligus.
 *
 * Yang di-*share* hanyalah data immutable selama export: asset PCM di WASM
 * shared linear memory (read-only).
 */

import { createEncoder, type Encoder } from '../encoders';
import { OggVorbisEncoder } from '../encoders/ogg-vorbis';
import { WavEncoder } from '../encoders/wav';
import { EXPORT_CANCEL } from './sab-layout';
import type { WasmBindgenExports, OfflineRenderHandle } from './wasm-loader';

/** 100 blok × 128 frame ≈ 267 ms audio @48k (docs/03 §3a). */
const BLOCKS_PER_BATCH = 100;
/** Chunk 4 MiB ke main thread sebagai ArrayBuffer transferable. */
const CHUNK_BYTES = 4 * 1024 * 1024;
/** Progress maksimal ~20 Hz wall-clock. */
const PROGRESS_INTERVAL_MS = 50;
/** EMA throughput untuk ETA — throughput awal selalu pesimis (JIT belum panas). */
const ETA_ALPHA = 0.2;

interface StartMessage {
  type: 'start';
  module: WebAssembly.Module;
  memory: WebAssembly.Memory | null;
  controlPtr: number;
  variant: 'mt' | 'st';
  snapshot: Uint8Array;
  sampleRate: number;
  startSample: number;
  endSample: number;
  format: 'wav' | 'mp3' | 'ogg';
  bitDepth: 16 | 24 | 32;
  quality?: number;
  streaming: boolean;
}

let cancelledByMessage = false;

self.onmessage = (ev: MessageEvent) => {
  const m = ev.data as StartMessage | { type: 'cancel' };
  if (m.type === 'cancel') {
    // Jalur degraded (tanpa SAB): cancel lewat postMessage yang terbaca saat
    // yield. Efeknya sama karena kita memang yield tiap batch.
    cancelledByMessage = true;
    return;
  }
  if (m.type === 'start') {
    void run(m).catch((e: unknown) => {
      post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    });
  }
};

/**
 * Yield ke event loop lewat MessageChannel, BUKAN `setTimeout`.
 *
 * Dua alasan (docs/03 §3a + docs/05 §tab throttling):
 *  1. `setTimeout(0)` kena clamp 4 ms di nesting dalam — 375 kali/detik audio
 *     itu jadi rem nyata.
 *  2. Di tab background `setTimeout` di-clamp ke **≥1000 ms**, yang membuat
 *     export 1000× lebih lambat. MessageChannel tidak di-throttle.
 * `await Promise.resolve()` (microtask) tidak cukup: ia tidak menjalankan
 * message queue, jadi `onmessage` cancel tidak akan pernah jalan.
 */
const yieldChannel = new MessageChannel();
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    yieldChannel.port1.onmessage = () => resolve();
    yieldChannel.port2.postMessage(0);
  });
}

async function run(m: StartMessage): Promise<void> {
  // Glue bindgen di-import dinamis dari varian yang sama dengan main thread,
  // lalu di-`initSync` dengan modul & memory yang SUDAH dikompilasi di sana
  // (kompilasi ulang di worker akan memakan 10–50 ms lagi tanpa guna).
  const glueUrl = new URL(`../wasm/${m.variant}/engine.js`, import.meta.url).href;
  const glue = (await import(/* @vite-ignore */ glueUrl)) as WasmBindgenExports;
  glue.initSync(m.memory ? { module: m.module, memory: m.memory } : { module: m.module });
  glue.initNonRealtime();

  const flags = m.memory ? new Int32Array(m.memory.buffer, m.controlPtr, 65536 / 4) : null;
  const cancelIdx = EXPORT_CANCEL >> 2;

  const render: OfflineRenderHandle = new glue.OfflineRender(
    m.snapshot,
    m.sampleRate,
    m.startSample,
    m.endSample,
    BLOCKS_PER_BATCH,
  );

  const encoder: Encoder = createEncoder(m.format, glue);
  await encoder.init({
    sampleRate: m.sampleRate,
    channels: 2,
    bitDepth: m.bitDepth,
    quality: m.quality,
  });

  // WAV: header placeholder ditulis lebih dulu, di-patch di akhir.
  if (encoder instanceof WavEncoder) {
    const h = encoder.header();
    postChunk('header', h);
  }

  const total = render.totalFrames();
  let rendered = 0;
  let lastProgress = 0;
  let framesPerMs = 0;

  // Akumulator chunk: dikirim setiap ≥4 MiB supaya main thread tidak menerima
  // ribuan pesan kecil, dan memori worker tidak menumpuk.
  let acc: Uint8Array[] = [];
  let accBytes = 0;

  for (;;) {
    // Cancel dicek SEKALI per batch (bukan per blok): flag ini berubah sekali
    // seumur hidup export, Relaxed sudah cukup, dan telat ≤267 ms tidak masalah.
    if (cancelledByMessage || (flags && Atomics.load(flags, cancelIdx) !== 0)) {
      render.free();
      post({ type: 'cancelled' });
      return;
    }

    const t0 = performance.now();
    const n = render.render(BLOCKS_PER_BATCH);
    if (n === 0) break;

    // Pointer diambil ULANG tiap batch: render bisa memicu memory.grow, dan
    // view lama akan diam-diam berukuran 0 (docs/05).
    const memory = memoryOf(glue, m.memory);
    const l = new Float32Array(memory.buffer, render.outLPtr(), n);
    const r = new Float32Array(memory.buffer, render.outRPtr(), n);

    const bytes = encoder.encode([l, r]);
    if (bytes.length > 0) {
      // `slice()` menyalin keluar dari linear memory: buffer WASM tidak boleh
      // ditransfer (dan tidak akan valid setelah grow berikutnya).
      acc.push(bytes.slice());
      accBytes += bytes.length;
      if (accBytes >= CHUNK_BYTES) {
        postChunk('chunk', concat(acc, accBytes));
        acc = [];
        accBytes = 0;
      }
    }

    rendered += n;
    const dt = performance.now() - t0;
    if (dt > 0) {
      const inst = n / dt;
      framesPerMs = framesPerMs === 0 ? inst : framesPerMs + ETA_ALPHA * (inst - framesPerMs);
    }

    const now = performance.now();
    if (now - lastProgress >= PROGRESS_INTERVAL_MS) {
      lastProgress = now;
      post({
        type: 'progress',
        stage: 'render',
        rendered,
        total,
        etaMs: framesPerMs > 0 ? Math.max(0, (total - rendered) / framesPerMs) : 0,
      });
    }

    await yieldToEventLoop();
  }

  // ── flush encoder ─────────────────────────────────────────────────────────
  post({ type: 'progress', stage: 'encode', rendered: total, total, etaMs: 0 });

  const tail =
    encoder instanceof OggVorbisEncoder ? await encoder.finishBlob() : encoder.finish();
  if (tail.length > 0) {
    acc.push(tail);
    accBytes += tail.length;
  }
  if (accBytes > 0) postChunk('chunk', concat(acc, accBytes));

  // WAV: header final (ukuran RIFF & data sudah diketahui) menggantikan
  // placeholder di part pertama.
  const finalHeader = encoder.finalHeader?.();
  if (finalHeader) postChunk('header', finalHeader);

  render.free();
  post({ type: 'done', mime: encoder.mime });
}

function memoryOf(glue: WasmBindgenExports, shared: WebAssembly.Memory | null): WebAssembly.Memory {
  if (shared) return shared;
  // Varian st: memory didefinisikan modul dan diekspos glue sebagai `memory`.
  const m = (glue as unknown as { memory?: WebAssembly.Memory }).memory;
  if (!m) throw new Error('WebAssembly.Memory tidak tersedia di worker');
  return m;
}

function postChunk(type: 'chunk' | 'header', data: Uint8Array): void {
  // Kirim ArrayBuffer sebagai transferable: kepemilikan berpindah, nol salinan.
  const buf =
    data.byteOffset === 0 && data.byteLength === data.buffer.byteLength
      ? (data.buffer as ArrayBuffer)
      : (data.slice().buffer as ArrayBuffer);
  (self as unknown as Worker).postMessage({ type, buffer: buf }, [buf]);
}

function post(msg: unknown): void {
  (self as unknown as Worker).postMessage(msg);
}

function concat(parts: Uint8Array[], total: number): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
