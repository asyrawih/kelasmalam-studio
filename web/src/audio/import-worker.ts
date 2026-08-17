import { WASM_URLS } from './wasm-urls';
/**
 * Import worker — decode file audio → PCM → resample → peak pyramid.
 *
 * docs/06 (ditulis paralel oleh agent lain) yang memutuskan decoder mana yang
 * jadi default. Karena itu file ini menaruh keduanya di balik SATU antarmuka
 * (`DecodeStrategy`) dan memilihnya lewat switch — mengganti rekomendasi nanti
 * berarti mengubah satu baris, bukan mengubah pipeline.
 *
 *   'web-audio' : `OfflineAudioContext.decodeAudioData`. Nol byte tambahan,
 *                 memakai decoder native browser (cepat, hardware-accelerated
 *                 di sebagian platform). Kekurangan: format terbatas pada yang
 *                 didukung browser, tidak ada progress per-paket, dan hasilnya
 *                 selalu di-resample ke sampleRate context.
 *   'wasm'      : Symphonia di dalam WASM (surface bindgen). Format konsisten
 *                 lintas browser (FLAC/OGG/MP3/WAV/AIFF), progress granular,
 *                 dan PCM langsung mendarat di shared linear memory sehingga
 *                 tidak perlu disalin ke engine.
 *
 * Peak pyramid & resample-on-import dilakukan di sisi Rust (`importFromPcm`)
 * untuk kedua strategi, jadi hasilnya identik apa pun jalur decode-nya.
 */

import type { ImportedAssetHandle, WasmBindgenExports } from './wasm-loader';

/** Sample per bucket di level terendah pyramid (≈ 5 ms @48k). */
const PEAK_BUCKET = 256;

export type DecodeStrategy = 'web-audio' | 'wasm';

interface ImportMessage {
  type: 'import';
  /** Id yang dikembalikan di setiap pesan supaya main thread bisa memetakan. */
  id: number;
  bytes: ArrayBuffer;
  fileName: string;
  /** Sample rate engine (`ctx.sampleRate`) — target resample. */
  targetRate: number;
  strategy: DecodeStrategy;
  module: WebAssembly.Module;
  memory: WebAssembly.Memory | null;
  variant: 'mt' | 'st';
  /** true kalau linear memory dibagi dengan main thread (tanpa transfer). */
  shared: boolean;
}

export interface ImportResultMessage {
  type: 'imported';
  id: number;
  fileName: string;
  sampleRate: number;
  frames: number;
  channels: number;
  /** Jalur shared: pointer ke PCM di linear memory (per channel). */
  channelPtrs: number[];
  peaksPtr: number;
  peaksLen: number;
  peakBucket: number;
  /** Jalur degraded: PCM & peak ikut ditransfer sebagai ArrayBuffer. */
  transferred?: { channels: ArrayBuffer[]; peaks: ArrayBuffer };
}

let glue: WasmBindgenExports | null = null;

self.onmessage = (ev: MessageEvent) => {
  const m = ev.data as ImportMessage;
  if (m.type !== 'import') return;
  void handle(m).catch((e: unknown) => {
    post({ type: 'error', id: m.id, message: e instanceof Error ? e.message : String(e) });
  });
};

async function handle(m: ImportMessage): Promise<void> {
  const g = await ensureGlue(m);
  post({ type: 'progress', id: m.id, stage: 'decode', ratio: 0 });

  const decoded =
    m.strategy === 'wasm' ? await decodeViaWasm(g, m) : await decodeViaWebAudio(m);

  post({ type: 'progress', id: m.id, stage: 'resample', ratio: 0.6 });

  // Gabungkan planar ke satu buffer berurutan-per-channel: batas WASM lebih
  // murah dilewati sekali dengan satu slice besar daripada N kali.
  const frames = decoded.channels[0]?.length ?? 0;
  const flat = new Float32Array(frames * decoded.channels.length);
  decoded.channels.forEach((c, i) => flat.set(c, i * frames));

  const asset: ImportedAssetHandle = g.importFromPcm(
    flat,
    decoded.channels.length,
    frames,
    decoded.sampleRate,
    m.targetRate,
    PEAK_BUCKET,
  );

  post({ type: 'progress', id: m.id, stage: 'peaks', ratio: 0.9 });

  const outFrames = asset.frames();
  const nch = asset.channels();
  const channelPtrs: number[] = [];
  for (let c = 0; c < nch; c++) channelPtrs.push(asset.channelPtr(c));

  const memory = m.memory ?? (g as unknown as { memory: WebAssembly.Memory }).memory;

  if (m.shared) {
    // Zero-copy: main thread membaca langsung dari shared linear memory.
    // Pointer WASM TIDAK boleh dikirim tanpa cara memverifikasi memori masih
    // sama; di sini aman karena main thread memegang objek Memory yang sama dan
    // selalu membuat view baru dari `memory.buffer` (docs/05).
    const msg: ImportResultMessage = {
      type: 'imported',
      id: m.id,
      fileName: m.fileName,
      sampleRate: asset.sampleRate(),
      frames: outFrames,
      channels: nch,
      channelPtrs,
      peaksPtr: asset.peaksPtr(),
      peaksLen: asset.peaksLen(),
      peakBucket: asset.peakBucket(),
    };
    post(msg);
    // Asset sengaja TIDAK di-`free()`: kepemilikan berpindah ke tabel asset
    // engine yang hidup di linear memory yang sama.
    return;
  }

  // Jalur degraded: salin keluar dan transfer (memori 2× sesaat, docs/01 §1d).
  const chBufs: ArrayBuffer[] = [];
  for (let c = 0; c < nch; c++) {
    const view = new Float32Array(memory.buffer, channelPtrs[c]!, outFrames);
    chBufs.push(view.slice().buffer as ArrayBuffer);
  }
  const peaks = new Float32Array(memory.buffer, asset.peaksPtr(), asset.peaksLen())
    .slice()
    .buffer as ArrayBuffer;
  asset.free();

  const msg: ImportResultMessage = {
    type: 'imported',
    id: m.id,
    fileName: m.fileName,
    sampleRate: m.targetRate,
    frames: outFrames,
    channels: nch,
    channelPtrs: [],
    peaksPtr: 0,
    peaksLen: 0,
    peakBucket: PEAK_BUCKET,
    transferred: { channels: chBufs, peaks },
  };
  (self as unknown as Worker).postMessage(msg, [...chBufs, peaks]);
}

interface DecodedPcm {
  channels: Float32Array[];
  sampleRate: number;
}

/**
 * Jalur browser. `decodeAudioData` di worker butuh `OfflineAudioContext`, yang
 * tersedia di Chrome/Safari; Firefox baru menyusul — kalau tidak ada, main
 * thread yang harus men-decode dan mengirim PCM ke sini (caps.decodeInWorker).
 */
async function decodeViaWebAudio(m: ImportMessage): Promise<DecodedPcm> {
  if (typeof OfflineAudioContext === 'undefined') {
    throw new Error('OfflineAudioContext tidak tersedia di worker ini; pakai strategy "wasm".');
  }
  // Panjang 1 frame: context ini hanya dipakai sebagai decoder, tidak merender.
  const ctx = new OfflineAudioContext(2, 1, m.targetRate);
  const buf = await ctx.decodeAudioData(m.bytes);
  const channels: Float32Array[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c).slice());
  return { channels, sampleRate: buf.sampleRate };
}

/**
 * Jalur Rust/Symphonia. Menunggu fungsi `decodeFile` di surface bindgen; kalau
 * artefak yang di-load belum punya (build lama), lempar pesan yang jelas
 * alih-alih gagal diam-diam.
 */
async function decodeViaWasm(g: WasmBindgenExports, m: ImportMessage): Promise<DecodedPcm> {
  const fn = (g as unknown as { decodeFile?: (b: Uint8Array) => ImportedAssetHandle }).decodeFile;
  if (!fn) {
    throw new Error(
      'Jalur decode WASM (Symphonia) belum tersedia di artefak ini. ' +
        'Pakai strategy "web-audio" atau bangun ulang dengan fitur decode.',
    );
  }
  const handle = fn(new Uint8Array(m.bytes));
  const memory = m.memory ?? (g as unknown as { memory: WebAssembly.Memory }).memory;
  const frames = handle.frames();
  const channels: Float32Array[] = [];
  for (let c = 0; c < handle.channels(); c++) {
    channels.push(new Float32Array(memory.buffer, handle.channelPtr(c), frames).slice());
  }
  const sampleRate = handle.sampleRate();
  handle.free();
  return { channels, sampleRate };
}

async function ensureGlue(m: ImportMessage): Promise<WasmBindgenExports> {
  if (glue) return glue;
  const url = WASM_URLS[m.variant].glue;
  const g = (await import(/* @vite-ignore */ url)) as WasmBindgenExports;
  g.initSync(m.memory ? { module: m.module, memory: m.memory } : { module: m.module });
  g.initNonRealtime();
  glue = g;
  return g;
}

function post(msg: unknown): void {
  (self as unknown as Worker).postMessage(msg);
}
