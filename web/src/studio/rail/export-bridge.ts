/**
 * Jembatan rail → pipeline export (docs/03 §3a, §3d).
 *
 * Jalur nyatanya: snapshot project (postcard, dihasilkan Rust) →
 * `EngineClient.startExport()` → `audio/export-worker.ts` (engine KEDUA) →
 * `encoders/` → `downloadBlob()`.
 *
 * Dua prasyarat BELUM ada di repo:
 *   1. artefak WASM belum dibangun → `loadWasm()` gagal;
 *   2. tanpa engine tidak ada snapshot project untuk dikirim ke worker.
 *
 * Karena itu rail mendeteksinya dan me-*disable* tombol COMPILE dengan alasan
 * jujur. Tidak ada animasi progress palsu.
 *
 * Untuk mengaktifkannya nanti, shell cukup memanggil `registerExportHost({...})`
 * satu kali; tidak ada komponen rail yang perlu berubah.
 */

import { useEffect, useState } from 'react';
import type { ExportProgress, ExportRequest } from '../../audio/engine-client';
import { downloadBlob, pickSaveLocation } from '../../encoders';

/** Yang harus disediakan shell begitu engine hidup. */
export interface ExportHost {
  /** Snapshot postcard project saat ini. */
  snapshot(): Uint8Array;
  sampleRate: number;
  startExport(
    req: ExportRequest,
    onProgress?: (p: ExportProgress) => void,
  ): { cancel(): void; readonly done: Promise<Blob | null> };
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
const NO_HOST = 'Engine belum terhubung ke rail — tidak ada snapshot project untuk di-render.';

export function useExportAvailability(): ExportAvailability {
  const [wasmOk, setWasmOk] = useState(false);
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
        const mod = await import('../../audio/wasm-loader');
        await mod.loadWasm();
        if (alive) setWasmOk(true);
      } catch {
        // Gagal memuat = engine memang belum ada.
        if (alive) setWasmOk(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (!wasmOk) return { ready: false, reason: NO_WASM };
  if (!hasHost) return { ready: false, reason: NO_HOST };
  return { ready: true, reason: '' };
}

export interface CompileParams {
  format: 'wav' | 'mp3';
  fileName: string;
  endSample: number;
  /** MP3 kbps; diabaikan untuk WAV. */
  quality?: number;
  onProgress?: (fraction01: number | null) => void;
}

/**
 * Jalankan export. HARUS dipanggil dari handler klik: `pickSaveLocation()`
 * membutuhkan user gesture (docs/03 §3d).
 */
export async function runCompile(p: CompileParams): Promise<void> {
  if (!host) throw new Error(NO_HOST);
  const ext = p.format;
  const mime = p.format === 'wav' ? 'audio/wav' : 'audio/mpeg';
  const fileName = `${p.fileName}.${ext}`;
  const fileHandle = await pickSaveLocation(fileName, mime, ext);

  const req: ExportRequest = {
    snapshot: host.snapshot(),
    startSample: 0,
    endSample: p.endSample,
    format: p.format,
    fileName,
    ...(p.format === 'wav' ? { bitDepth: 16 as const } : { quality: p.quality ?? 192 }),
    ...(fileHandle ? { fileHandle } : {}),
  };

  const session = host.startExport(req, (prog: ExportProgress) => {
    if (prog.stage === 'done' || prog.stage === 'cancelled' || prog.stage === 'error') {
      p.onProgress?.(null);
      return;
    }
    p.onProgress?.(prog.total > 0 ? Math.min(1, prog.rendered / prog.total) : 0);
  });

  try {
    const blob = await session.done;
    // `null` = sudah ditulis langsung ke disk lewat File System Access API.
    if (blob) downloadBlob(blob, fileName);
  } finally {
    p.onProgress?.(null);
  }
}
