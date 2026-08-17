/**
 * Jembatan rail → pipeline export (docs/03 §3a, §3d).
 *
 * Jalur nyatanya, dan inilah bayaran dari seluruh arsitektur: model studio →
 * `snapshotFromStudioJson` (Rust) → `OfflineRender` yang memanggil
 * `Engine::render_block` YANG SAMA dengan playback → `encoders/` →
 * `downloadBlob()`. Tidak ada `OfflineAudioContext`, tidak ada jalur DSP kedua.
 *
 * Yang tersisa sebagai prasyarat cuma satu: artefak WASM harus sudah dibangun.
 * Kalau belum, `loadWasm()` gagal dan tombol COMPILE di-*disable* dengan alasan
 * jujur — tidak ada animasi progress palsu.
 */

import { useEffect, useState } from 'react';
import { createEncoder, downloadBlob, pickSaveLocation } from '../../encoders';
import type { EncoderFormat } from '../../encoders';
import { loadWasm, type LoadedWasm } from '../../audio/wasm-loader';
import { buildExportPayload, type BufferLookup } from '../export/payload';
import { ExportCancelled, runExport, type ExportEncoder } from '../export/run-export';
import { createWasmExportEngine } from '../export/wasm-engine';
import type { StudioState } from '../model';

/**
 * Yang harus disediakan shell begitu engine hidup: state project saat ini dan
 * cara mendapatkan PCM-nya. PCM diambil dari cache yang SAMA dengan preview
 * (`audio-preview.bufferLookup()`) — kalau export punya cache sendiri, apa yang
 * didengar dan apa yang ditulis bisa berasal dari audio yang berbeda.
 */
export interface ExportHost {
  state(): StudioState;
  getBuffer: BufferLookup;
}

let host: ExportHost | null = null;
const hostListeners = new Set<() => void>();

export function registerExportHost(h: ExportHost | null): void {
  host = h;
  for (const l of hostListeners) l();
}

export interface ExportAvailability {
  readonly ready: boolean;
  /** Alasan untuk tooltip kalau `ready === false`. */
  readonly reason: string;
}

const NO_WASM =
  'Engine belum dibangun (artefak WASM tidak ada). Export akan aktif setelah engine di-build.';
const NO_HOST = 'Engine belum terhubung ke rail — tidak ada project untuk di-render.';

let wasmCache: LoadedWasm | null = null;

export function useExportAvailability(): ExportAvailability {
  const [wasmOk, setWasmOk] = useState(wasmCache !== null);
  const [wasmError, setWasmError] = useState<string | null>(null);
  const [hasHost, setHasHost] = useState(host !== null);

  useEffect(() => {
    const fn = (): void => setHasHost(host !== null);
    hostListeners.add(fn);
    return () => {
      hostListeners.delete(fn);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const w = await loadWasm();
        wasmCache = w;
        if (alive) setWasmOk(true);
      } catch (e: unknown) {
        // JANGAN menelan errornya. Sebelumnya semua kegagalan dilaporkan sebagai
        // "artefak tidak ada", padahal artefaknya bisa saja ADA dan sehat —
        // yang gagal instantiasi, cek ABI, atau layout blok kontrol. Pesan yang
        // salah membuat orang membangun ulang artefak berkali-kali untuk
        // masalah yang sama sekali berbeda.
        // Detailnya (URL, status HTTP, content-type) ikut ditampilkan JUGA
        // untuk error "belum dibangun". Menggantinya dengan kalimat generik
        // membuang satu-satunya informasi yang membedakan "file tidak ada" dari
        // "file ada tapi server menjawab HTML" — dua penyebab dengan perbaikan
        // yang sama sekali berbeda.
        // Selalu ke console juga: tooltip terpotong, stack trace tidak.
        console.error('[export] gagal memuat engine WASM:', e);
        if (alive) {
          setWasmOk(false);
          setWasmError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (!wasmOk) return { ready: false, reason: wasmError ?? NO_WASM };
  if (!hasHost) return { ready: false, reason: NO_HOST };
  return { ready: true, reason: '' };
}

/** MIME per format — dipakai picker "save as" DAN tipe Blob-nya. */
const MIME: Record<EncoderFormat, string> = {
  wav: 'audio/wav',
  flac: 'audio/flac',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
};

/**
 * Paket encoder lossy diunduh saat `init()`. Kalau unduhannya gagal (offline,
 * CDN diblokir, bundle rusak), pesannya harus menyebut FORMAT-nya — "Failed to
 * fetch dynamically imported module" tidak memberi tahu user bahwa ia cukup
 * memilih WAV dan semuanya jalan lagi. Format lain tidak ikut rusak: masing-
 * masing `import()` berdiri sendiri.
 */
const LAZY_ENCODER_LABEL: Partial<Record<EncoderFormat, string>> = {
  mp3: 'Encoder MP3 (lamejs)',
  ogg: 'Encoder OGG Vorbis (vorbis-encoder-js)',
};

export interface CompileParams {
  format: EncoderFormat;
  fileName: string;
  /** WAV: 16/24/32. FLAC: 16/24. Diabaikan untuk MP3/OGG. */
  bitDepth?: 16 | 24 | 32;
  /** MP3 kbps, atau quality Vorbis. Diabaikan untuk WAV/FLAC. */
  quality?: number;
  onProgress?: (fraction01: number | null) => void;
  /** Selisih preview vs file — UI WAJIB menampilkannya. */
  onWarnings?: (warnings: readonly string[]) => void;
  /** Dicek sekali per batch. */
  isCancelled?: () => boolean;
}

/**
 * Tulis ke lokasi yang dipilih user. Kalau gagal di tengah jalan (disk penuh,
 * izin dicabut), error-nya dibiarkan naik: file separuh jadi di disk yang
 * dilaporkan sebagai sukses jauh lebih buruk daripada pesan error.
 */
async function writeToDisk(handle: FileSystemFileHandle, blob: Blob): Promise<void> {
  const writable = await (
    handle as unknown as { createWritable(): Promise<{ write(b: Blob): Promise<void>; close(): Promise<void> }> }
  ).createWritable();
  await writable.write(blob);
  await writable.close();
}

/**
 * Jalankan export. HARUS dipanggil dari handler klik: `pickSaveLocation()`
 * membutuhkan user gesture (docs/03 §3d).
 */
export async function runCompile(p: CompileParams): Promise<void> {
  if (!host) throw new Error(NO_HOST);
  const wasm = wasmCache ?? (await loadWasm());
  wasmCache = wasm;

  const state = host.state();
  const payload = buildExportPayload(state, host.getBuffer);
  if (payload.endSample <= 0 || payload.assets.length === 0) {
    throw new Error('Tidak ada clip dengan audio untuk di-render.');
  }

  const ext = p.format;
  const mime = MIME[p.format];
  const fileName = `${p.fileName}.${ext}`;
  // Picker DULU, sebelum render: ia butuh user gesture, dan gesture-nya hilang
  // begitu kita menunggu batch pertama. `null` = browser tanpa File System
  // Access API (atau user batal) → jalur anchor+Blob.
  const fileHandle = await pickSaveLocation(fileName, mime, ext);

  const encoder = createEncoder(p.format, wasm.exports) as unknown as ExportEncoder;
  try {
    await encoder.init({
      sampleRate: state.sampleRate,
      channels: 2,
      bitDepth: p.bitDepth ?? 16,
      quality: p.quality,
    });
  } catch (e) {
    const label = LAZY_ENCODER_LABEL[p.format];
    if (label) {
      throw new Error(
        `${label} gagal dimuat: ${e instanceof Error ? e.message : String(e)}. ` +
          'Format lain (WAV/FLAC) tetap bisa dipakai.',
      );
    }
    throw e;
  }

  try {
    const result = await runExport({
      payload,
      sampleRate: state.sampleRate,
      engine: createWasmExportEngine(wasm),
      encoder,
      onProgress: p.onProgress,
      onWarnings: p.onWarnings,
      isCancelled: p.isCancelled,
    });
    if (fileHandle) await writeToDisk(fileHandle, result.blob);
    else downloadBlob(result.blob, fileName);
  } catch (e) {
    // Batal bukan kegagalan — jangan tampilkan sebagai error merah.
    if (!(e instanceof ExportCancelled)) throw e;
  } finally {
    p.onProgress?.(null);
  }
}
