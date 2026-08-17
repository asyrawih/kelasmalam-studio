/**
 * Deteksi kapabilitas runtime + matriks degraded mode (docs/01 §1d).
 *
 * Semua deteksi dilakukan SEKALI dan di-cache: `wasmFeatureDetect.simd()`
 * meng-compile modul WASM kecil, jadi tidak gratis, dan hasilnya tidak akan
 * berubah selama halaman hidup.
 */

import { simd, threads } from 'wasm-feature-detect';

/** Varian artefak WASM yang dibangun `scripts/build-wasm.sh`. */
export type WasmVariant = 'mt' | 'st';

export interface Caps {
  /** `crossOriginIsolated` — prasyarat SharedArrayBuffer. */
  readonly isolated: boolean;
  /** Konstruktor `SharedArrayBuffer` ada DAN bisa dipakai. */
  readonly sab: boolean;
  /** Opcode `i32.atomic.*` + shared memory didukung engine WASM browser. */
  readonly wasmThreads: boolean;
  /** SIMD128 — tidak butuh isolasi. */
  readonly simd: boolean;
  /** `showSaveFilePicker` (Chromium). Streaming ke disk saat export. */
  readonly fileSystemAccess: boolean;
  /** `AudioEncoder` WebCodecs — kandidat jalur Opus/AAC cepat. */
  readonly webCodecs: boolean;
  /** `AudioWorklet` tersedia sama sekali. */
  readonly audioWorklet: boolean;
  /** `OfflineAudioContext.decodeAudioData` tersedia di worker (Firefox: tidak). */
  readonly decodeInWorker: boolean;
  /** Varian artefak yang harus di-load. */
  readonly variant: WasmVariant;
}

/**
 * Matriks penurunan fitur. Nilainya deskriptif — UI memakainya untuk
 * menampilkan banner "mode terbatas" dan menonaktifkan kontrol yang tidak
 * berlaku, engine-client memakainya untuk memilih jalur transport command.
 */
export interface DegradedMatrix {
  /** Command UI→audio: ring SAB (~2.7 ms) vs postMessage batched per rAF. */
  readonly commandTransport: 'sab-ring' | 'post-message';
  /** Meter: SeqLock zero-copy vs postMessage 30 Hz. */
  readonly meterTransport: 'sab-seqlock' | 'post-message';
  /** Asset PCM: satu salinan shared vs transfer/copy (memori 2× saat import). */
  readonly assetSharing: 'shared-memory' | 'transfer';
  /** Render export: multi-thread vs single-thread. */
  readonly exportThreads: 'multi' | 'single';
  /** Peak pyramid: tulis langsung ke shared memory vs transfer ArrayBuffer. */
  readonly peakDelivery: 'shared-memory' | 'transfer';
  /** SIMD tidak pernah mati karena isolasi — hanya karena browser tua. */
  readonly simd: boolean;
  /** Playback realtime selalu jalan; ada demi kelengkapan tabel docs/01 §1d. */
  readonly realtimePlayback: true;
}

let cached: Caps | null = null;

/** Deteksi kapabilitas (idempoten, hasil di-cache). */
export async function detectCaps(): Promise<Caps> {
  if (cached) return cached;

  const isolated = globalThis.crossOriginIsolated === true;
  const hasSabCtor = typeof SharedArrayBuffer !== 'undefined';

  // Konstruktor bisa ada tapi melempar kalau tidak isolated (beberapa engine).
  let sab = false;
  if (hasSabCtor) {
    try {
      new SharedArrayBuffer(8);
      sab = true;
    } catch {
      sab = false;
    }
  }

  const [simdOk, threadsOk] = await Promise.all([safe(simd), safe(threads)]);

  cached = {
    isolated,
    sab,
    wasmThreads: threadsOk,
    simd: simdOk,
    fileSystemAccess: typeof globalThis !== 'undefined' && 'showSaveFilePicker' in globalThis,
    webCodecs: typeof globalThis !== 'undefined' && 'AudioEncoder' in globalThis,
    audioWorklet: typeof AudioWorkletNode !== 'undefined',
    decodeInWorker: typeof OfflineAudioContext !== 'undefined',
    // Build +atomics TIDAK akan jalan tanpa shared memory — jadi ini bukan
    // sekadar feature flag runtime, melainkan pemilihan artefak.
    variant: isolated && sab && threadsOk ? 'mt' : 'st',
  };
  return cached;
}

/** Nilai caps yang sudah dideteksi; `null` kalau `detectCaps()` belum jalan. */
export function peekCaps(): Caps | null {
  return cached;
}

/** Turunkan matriks degraded dari caps. Murni fungsi, mudah dites. */
export function degradedMatrix(c: Caps): DegradedMatrix {
  const shared = c.isolated && c.sab;
  return {
    commandTransport: shared ? 'sab-ring' : 'post-message',
    meterTransport: shared ? 'sab-seqlock' : 'post-message',
    assetSharing: shared ? 'shared-memory' : 'transfer',
    exportThreads: shared ? 'multi' : 'single',
    peakDelivery: shared ? 'shared-memory' : 'transfer',
    simd: c.simd,
    realtimePlayback: true,
  };
}

/**
 * Pesan yang bisa ditampilkan UI kalau berjalan degraded. Kosong = normal.
 * Sengaja di sini (bukan di UI) supaya alasan teknisnya hidup berdampingan
 * dengan deteksinya.
 */
export function degradedReasons(c: Caps): string[] {
  const out: string[] = [];
  if (!c.isolated) {
    out.push(
      'Halaman tidak cross-origin isolated (COOP/COEP hilang, atau di-embed di iframe). ' +
        'Command UI memakai postMessage (~16–30 ms), bukan SAB ring.',
    );
  } else if (!c.sab) {
    out.push('SharedArrayBuffer tidak tersedia meski isolated — browser terlalu tua.');
  }
  if (!c.wasmThreads) out.push('WASM threads/atomics tidak didukung: memakai artefak single-thread.');
  if (!c.simd) out.push('SIMD128 tidak didukung: jalur DSP scalar, CPU lebih tinggi.');
  if (!c.audioWorklet) out.push('AudioWorklet tidak tersedia: playback tidak mungkin.');
  return out;
}

async function safe(fn: () => Promise<boolean>): Promise<boolean> {
  try {
    return await fn();
  } catch {
    return false;
  }
}
