/**
 * Implementasi [`ExportEngine`] di atas modul WASM sungguhan.
 *
 * Semua yang ada di sini TIDAK bisa dites di jsdom (modul WASM tidak bisa
 * di-instantiate di sana), jadi isinya sengaja hanya penerjemahan bentuk —
 * tanpa keputusan, tanpa cabang. Logika yang bisa salah hidup di
 * `run-export.ts`, yang dites dengan engine palsu.
 */

import type { LoadedWasm } from '../../audio/wasm-loader';
import { f32View } from '../../audio/wasm-loader';
import type { ExportEngine, RenderHandle, SnapshotResult } from './run-export';

export function createWasmExportEngine(wasm: LoadedWasm): ExportEngine {
  return {
    snapshot(json: string): SnapshotResult {
      const handle = wasm.exports.snapshotFromStudioJson(json);
      try {
        // `bytes()` menyalin keluar dari linear memory; itu yang kita mau —
        // snapshot dipegang selama render dan alokasi berikutnya bisa grow.
        return {
          bytes: handle.bytes(),
          warnings: handle.warnings(),
          clipCount: handle.clipCount(),
        };
      } finally {
        handle.free();
      }
    },

    createRender(snapshot, sampleRate, startSample, endSample, blocksPerBatch): RenderHandle {
      return new wasm.exports.OfflineRender(
        snapshot,
        sampleRate,
        startSample,
        endSample,
        blocksPerBatch,
      ) as unknown as RenderHandle;
    },

    view(ptr: number, len: number): Float32Array {
      // Selalu dari `memory.buffer` yang sekarang — lihat catatan di f32View.
      return f32View(wasm.memory, ptr, len);
    },
  };
}
