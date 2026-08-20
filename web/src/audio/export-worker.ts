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
 * # KENAPA WORKER, DAN KENAPA DENGAN MEMORY SENDIRI
 *
 * Alasan pertama yang biasa: render offline memakai 100% satu core selama
 * beberapa detik, dan di main thread itu membekukan UI — termasuk tombol
 * batalnya.
 *
 * Alasan kedua yang justru lebih menentukan: **linear memory wasm tidak pernah
 * menyusut.** Render menaruh SELURUH PCM project di linear memory, dan
 * `OfflineRender::drop` memang membebaskannya — tapi hanya ke alokator di dalam
 * wasm. Halaman yang sudah ditumbuhkan tetap milik instance itu sampai
 * instance-nya sendiri hilang. Selama export berjalan di instance main thread,
 * satu export 400 MiB berarti tab menahan 400 MiB itu sampai di-reload,
 * walaupun export-nya sudah lama selesai dan tidak ada lagi yang memakainya.
 *
 * Karena itu worker ini meng-instantiate artefak **`st`** — varian yang
 * meng-EKSPOR memory-nya sendiri, bukan `mt` yang meng-IMPORT memory bersama
 * milik main thread dan worklet. Dengan memory sendiri, `worker.terminate()`
 * mengembalikan semuanya ke sistem operasi: PCM, arena FX, encoder, glue.
 * Memakai `mt` di sini akan menumbuhkan memory yang SAMA dengan yang dipakai
 * playback — dan `terminate()` tidak akan membebaskan apa pun.
 *
 * Render offline memang satu thread (lihat `OfflineRenderer`), jadi tidak ada
 * yang hilang dengan memilih `st`.
 */

import { PCM_CHUNK_FRAMES, type ExportPayload } from '../studio/export/payload';
import { ExportCancelled, runExport, type ExportEncoder } from '../studio/export/run-export';
import { PostMessageSink, type ExportChunkMessage } from '../studio/export/sinks';
import { createWasmExportEngine } from '../studio/export/wasm-engine';
import { createEncoder } from '../encoders';
import { WASM_URLS } from './wasm-urls';
import {
  MEMORY_MAXIMUM_PAGES,
  WASM_PAGE_BYTES,
  declaredMemoryMaximumPages,
  type LoadedWasm,
  type WasmBindgenExports,
} from './wasm-loader';

export interface ExportWorkerStart {
  type: 'start';
  payload: ExportPayload;
  sampleRate: number;
  format: 'wav' | 'flac' | 'mp3' | 'ogg';
  bitDepth: 16 | 24 | 32;
  quality?: number;
}

/** Jawaban main thread atas satu `pcm-request`. */
interface PcmChunkMessage {
  type: 'pcm-chunk';
  id: number;
  /** Byte f32 potongan itu. Kosong = sumbernya habis. */
  buffer: ArrayBuffer;
}

interface PcmErrorMessage {
  type: 'pcm-error';
  id: number;
  message: string;
}

type Incoming = ExportWorkerStart | { type: 'cancel' } | PcmChunkMessage | PcmErrorMessage;

/** Batal dibaca saat yield — worker ini tidak berbagi SAB dengan siapa pun. */
let cancelled = false;

/** `pcm-request` yang masih menunggu jawaban. Selalu paling banyak satu. */
const pending = new Map<
  number,
  { resolve: (v: Float32Array) => void; reject: (e: unknown) => void }
>();
let nextPcmId = 1;

self.onmessage = (ev: MessageEvent): void => {
  const m = ev.data as Incoming;
  switch (m.type) {
    case 'cancel':
      cancelled = true;
      return;
    case 'pcm-chunk': {
      const p = pending.get(m.id);
      pending.delete(m.id);
      p?.resolve(new Float32Array(m.buffer));
      return;
    }
    case 'pcm-error': {
      const p = pending.get(m.id);
      pending.delete(m.id);
      p?.reject(new Error(m.message));
      return;
    }
    case 'start':
      void run(m).catch((e: unknown) => {
        if (e instanceof ExportCancelled) {
          post({ type: 'cancelled' });
          return;
        }
        post({ type: 'error', message: e instanceof Error ? e.message : String(e) });
      });
      return;
  }
};

/** Minta satu potong PCM ke main thread. */
function requestPcm(assetId: number, channel: number, offset: number, maxFrames: number): Promise<Float32Array> {
  const id = nextPcmId++;
  return new Promise<Float32Array>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    post({ type: 'pcm-request', id, assetId, channel, offset, maxFrames });
  });
}

async function run(m: ExportWorkerStart): Promise<void> {
  // Lihat wasm-urls.ts: template literal di sini akan diarahkan Vite ke
  // direktori yang salah tanpa error apa pun.
  const urls = WASM_URLS.st;
  // Byte-nya dibutuhkan dua kali: untuk `compile` dan untuk membaca plafon yang
  // BENAR-BENAR dideklarasikan artefak ini. Menebak plafonnya dari konstanta
  // akan salah persis di checkout yang artefaknya lebih lama daripada kodenya —
  // dan penjaga memori yang memakai angka salah lebih buruk daripada tidak ada
  // penjaga.
  const res = await fetch(urls.wasm, { cache: 'no-store' });
  if (!res.ok) throw new Error(`artefak export (st) → HTTP ${res.status}`);
  const bytes = await res.arrayBuffer();
  const module = await WebAssembly.compile(bytes);
  const glue = (await import(/* @vite-ignore */ urls.glue)) as WasmBindgenExports;

  // Varian st meng-EKSPOR memory-nya sendiri: `initSync` tidak diberi memory,
  // dan yang dipakai membaca hasil render HARUS `inst.memory`. Memakai objek
  // `WebAssembly.Memory` buatan JS di sini berarti membaca memori yang tidak
  // pernah disentuh engine — semua nol, tanpa satu pun error, dan gejalanya
  // file export yang senyap sempurna.
  const inst = glue.initSync({ module }) as { memory?: WebAssembly.Memory } | undefined;
  const memory = inst?.memory;
  if (memory === undefined) {
    throw new Error('artefak st tidak mengekspor memory — worker export tidak bisa membaca hasil render.');
  }
  glue.initNonRealtime();

  const pages = declaredMemoryMaximumPages(bytes) ?? MEMORY_MAXIMUM_PAGES;

  // `createWasmExportEngine` hanya memakai `exports` dan `memory`; sisanya
  // diisi untuk memenuhi bentuk `LoadedWasm` tanpa memalsukan kemampuan.
  const wasm = {
    module,
    memory,
    memoryMaximumBytes: pages * WASM_PAGE_BYTES,
    variant: 'st',
    caps: { variant: 'st' } as LoadedWasm['caps'],
    exports: glue,
    controlPtr: 0,
  } as LoadedWasm;

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
    // PCM ditarik sepotong demi sepotong dari main thread, bukan dikirim
    // sekaligus di pesan `start`. Bedanya bukan gaya: `postMessage` MENYALIN
    // apa yang dikirim, jadi mengirim seluruh PCM di muka berarti satu salinan
    // penuh project di heap JS worker — di samping salinan yang sama yang
    // sedang ditulis ke linear memory. Dengan tarikan, yang berwujud sekaligus
    // hanya satu potong sebesar PCM_CHUNK_FRAMES.
    pcm: (req) =>
      requestPcm(req.asset.assetId, req.channel, req.offset, Math.min(req.maxFrames, PCM_CHUNK_FRAMES)),
    sampleRate: m.sampleRate,
    engine: createWasmExportEngine(wasm),
    encoder,
    sink,
    isCancelled: () => cancelled,
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

function post(msg: unknown): void {
  (self as unknown as Worker).postMessage(msg);
}
