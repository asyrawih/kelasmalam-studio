/**
 * Worker export — ADAPTER TIPIS di atas `runExport`.
 *
 * Dulu worker ini memelihara loop render/encode-nya SENDIRI, terpisah dari
 * jalur yang dipakai UI. Akibatnya nyata: ia membuat `OfflineRender` tapi tidak
 * pernah memanggil `registerAsset`, jadi setiap clip menunjuk slot asset kosong
 * dan hasilnya file senyap sempurna — tanpa error, tanpa peringatan. Bug itu
 * tidak mungkin ada kalau sejak awal hanya ada satu implementasi.
 *
 * Jadi isi file ini sekarang hanya penerjemahan bentuk:
 *   pesan worker → argumen `runExport` → pesan balik.
 * Semua yang bisa salah (urutan daftar asset, batching, re-acquire view setelah
 * memory.grow, pembatalan, peringatan) hidup di `run-export.ts` dan dites di
 * sana dengan engine palsu.
 *
 * KENAPA WORKER SAMA SEKALI: render offline memakai 100% satu core selama
 * beberapa detik. Di main thread itu membekukan UI — termasuk tombol batalnya.
 * Jalur UI saat ini memanggil `runExport` langsung; worker ini adalah jalur
 * yang dipakai begitu render dipindah keluar dari main thread.
 */

import type { ExportPayload } from '../studio/export/payload';
import { ExportCancelled, runExport, type ExportEncoder } from '../studio/export/run-export';
import { PostMessageSink, type ExportChunkMessage } from '../studio/export/sinks';
import { createWasmExportEngine } from '../studio/export/wasm-engine';
import { createEncoder } from '../encoders';
import { EXPORT_CANCEL } from './sab-layout';
import { adoptThreadStack, type StackCapableExports, type ThreadStack } from './thread-stack';
import { WASM_URLS } from './wasm-urls';
import type { LoadedWasm, WasmBindgenExports } from './wasm-loader';

export interface ExportWorkerStart {
  type: 'start';
  /** Modul yang SUDAH dikompilasi di main thread — structured-cloneable. */
  module: WebAssembly.Module;
  /** Hanya ada di varian mt (shared). Di st, worker punya memory sendiri. */
  memory: WebAssembly.Memory | null;
  /** Stack privat thread ini — lihat audio/thread-stack.ts. */
  stack: ThreadStack | null;
  variant: 'mt' | 'st';
  /** Offset blok kontrol; dipakai membaca flag batal tanpa postMessage. */
  controlPtr: number;
  payload: ExportPayload;
  sampleRate: number;
  format: 'wav' | 'mp3';
  bitDepth: 16 | 24 | 32;
  quality?: number;
}

type Incoming = ExportWorkerStart | { type: 'cancel' };

/** Jalur degraded (tanpa SAB): batal lewat pesan, terbaca saat yield. */
let cancelledByMessage = false;

self.onmessage = (ev: MessageEvent): void => {
  const m = ev.data as Incoming;
  if (m.type === 'cancel') {
    cancelledByMessage = true;
    return;
  }
  if (m.type === 'start') {
    void run(m).catch((e: unknown) => {
      if (e instanceof ExportCancelled) {
        post({ type: 'cancelled' });
        return;
      }
      post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
    });
  }
};

async function run(m: ExportWorkerStart): Promise<void> {
  // Lihat wasm-urls.ts: template literal di sini akan diarahkan Vite ke
  // direktori yang salah tanpa error apa pun.
  const glueUrl = WASM_URLS[m.variant].glue;
  const glue = (await import(/* @vite-ignore */ glueUrl)) as WasmBindgenExports;
  const inst = glue.initSync(
    m.memory ? { module: m.module, memory: m.memory } : { module: m.module },
  ) as StackCapableExports | undefined;
  // Sesegera mungkin sesudah instantiate: di jalur mt thread ini berbagi linear
  // memory dengan main thread dan worklet, dan tanpa langkah ini ketiganya
  // menumbuhkan stack di rentang alamat yang sama (audio/thread-stack.ts).
  // Yang tersisa terpapar hanyalah start function wasm-bindgen di dalam
  // `initSync` — tidak bisa disisipi dari luar, dan bingkainya dangkal.
  adoptThreadStack(inst ?? {}, m.stack);
  glue.initNonRealtime();

  // `createWasmExportEngine` hanya memakai `exports` dan `memory`; sisanya
  // diisi untuk memenuhi bentuk `LoadedWasm` tanpa memalsukan kemampuan.
  const memory = m.memory ?? (glue as unknown as { memory: WebAssembly.Memory }).memory;
  const wasm = {
    module: m.module,
    memory,
    variant: m.variant,
    caps: { variant: m.variant } as LoadedWasm['caps'],
    exports: glue,
    controlPtr: m.controlPtr,
  } as LoadedWasm;

  // Flag batal di SAB dibaca langsung — tanpa menunggu message queue. Di jalur
  // st (tanpa shared memory) hanya pesan yang tersedia.
  const flags = m.memory ? new Int32Array(m.memory.buffer, m.controlPtr, SAB_I32_LEN) : null;
  const cancelIdx = EXPORT_CANCEL >> 2;
  const isCancelled = (): boolean =>
    cancelledByMessage || (flags !== null && Atomics.load(flags, cancelIdx) !== 0);

  const encoder = createEncoder(m.format, glue) as unknown as ExportEncoder;
  await encoder.init?.({
    sampleRate: m.sampleRate,
    channels: 2,
    bitDepth: m.bitDepth,
    quality: m.quality,
  });

  // Tiap chunk diteruskan dan dilupakan. Sebelumnya di sini ada
  //
  //     const buffer = await result.blob.arrayBuffer();
  //
  // — satu ArrayBuffer sebesar SELURUH export, di worker, sesudah `Blob` yang
  // juga sebesar seluruh export. Dua salinan penuh dari file yang byte-nya
  // sudah dipotong rapi 4 MiB oleh writer di Rust, dan batas keras ArrayBuffer
  // membuat export panjang gagal di sini — bukan di engine.
  const sink = new PostMessageSink((msg: ExportChunkMessage, transfer: Transferable[]) =>
    (self as unknown as Worker).postMessage(msg, transfer),
  );

  const result = await runExport({
    payload: m.payload,
    sampleRate: m.sampleRate,
    engine: createWasmExportEngine(wasm),
    encoder,
    sink,
    isCancelled,
    onWarnings: (warnings) => post({ type: 'warnings', warnings: [...warnings] }),
    onProgress: (fraction01) => post({ type: 'progress', fraction01 }),
  });

  // Byte-nya sudah di sisi main thread; yang tersisa hanya kabar bahwa aliran
  // itu lengkap.
  post({
    type: 'done',
    mime: encoder.mime,
    frames: result.frames,
    warnings: [...result.warnings],
  });
}

/** Panjang blok kontrol dalam i32 (64 KiB). */
const SAB_I32_LEN = 65536 / 4;

function post(msg: unknown): void {
  (self as unknown as Worker).postMessage(msg);
}
