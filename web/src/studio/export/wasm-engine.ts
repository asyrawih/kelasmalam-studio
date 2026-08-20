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

    memoryHeadroomBytes(): number {
      // Dulu rumusnya `plafon − byteLength`, dan itu SALAH dengan cara yang
      // hanya muncul di export KEDUA.
      //
      // Linear memory wasm tidak pernah menyusut. Sesudah satu export besar,
      // `byteLength` tetap 2,4 GiB walaupun seluruh PCM-nya sudah dibebaskan
      // dan ruangnya siap dipakai ulang oleh alokator. Rumus lama membaca itu
      // sebagai "terpakai" dan menolak export berikutnya selamanya, sampai tab
      // di-reload. Laporannya pun terdengar masuk akal — "sisa 1.640 MiB" —
      // jadi tidak ada yang curiga angkanya yang salah, bukan project-nya.
      //
      // Yang benar: pisahkan memory yang tumbuh KARENA asset (bisa dipakai
      // ulang) dari yang tumbuh karena hal lain (tidak).
      //
      //   bukan-asset = byteLength − puncak asset yang pernah hidup
      //   sisa        = plafon − bukan-asset − asset yang hidup sekarang
      //
      // Angkanya datang dari Rust, satu-satunya pihak yang tahu — lihat
      // `LIVE_ASSET_BYTES` di `wasm-bridge/src/bindgen.rs`.
      const live = wasm.exports.assetBytesLive();
      const peak = wasm.exports.assetBytesPeak();
      const nonAsset = Math.max(0, wasm.memory.buffer.byteLength - peak);
      return Math.max(0, wasm.memoryMaximumBytes - nonAsset - live);
    },
  };
}
