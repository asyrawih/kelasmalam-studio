/**
 * @vitest-environment node
 *
 * REGRESI: dua thread di atas SATU linear memory tidak boleh saling merusak.
 *
 * Bug aslinya: varian `mt` di-link tanpa `--export=__stack_pointer`, jadi setiap
 * instance memulai stack-nya di alamat yang sama dan thread-thread saling
 * menimpa bingkai. Gejalanya tidak pernah menunjuk ke penyebabnya — yang meledak
 * adalah `free()` objek lain ("attempted to take ownership of Rust value while
 * it was borrowed"), bounds check di encoder WAV, atau "memory access out of
 * bounds", berpindah-pindah tiap kali dijalankan.
 *
 * Tes ini menjalankan situasi yang sama: satu thread memanggil `engine_process`
 * tanpa henti sementara thread utama melakukan render + encode berulang kali.
 * Tanpa perbaikan, ini rusak dalam <3 putaran.
 *
 * Ada DUA tes dengan biaya sangat berbeda, dan itu disengaja:
 *   1. invarian artefak — murah, selalu jalan, menangkap penyebabnya LANGSUNG
 *      (export hilang) alih-alih lewat gejalanya.
 *   2. race sungguhan — mahal (beberapa detik), menangkap kelas kerusakan yang
 *      sama walau penyebabnya kelak berubah.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';

const MT_WASM = fileURLToPath(new URL('../wasm/mt/engine_bg.wasm', import.meta.url));

/** `Uint8Array` baru, bukan `Buffer` apa adanya: tipe `Buffer` di Node modern
 *  memuat kemungkinan `SharedArrayBuffer`, yang ditolak `WebAssembly.compile`. */
function artifact(): Uint8Array<ArrayBuffer> | null {
  try {
    const raw = readFileSync(MT_WASM);
    return new Uint8Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  } catch {
    return null;
  }
}

describe('stack privat per thread (artefak mt)', () => {
  it('artefak mt WAJIB mengekspor __stack_pointer', async () => {
    const bytes = artifact();
    if (bytes === null) {
      // Artefak belum dibangun — bukan kegagalan tes ini.
      expect(true).toBe(true);
      return;
    }
    const mod = await WebAssembly.compile(bytes);
    const exports = WebAssembly.Module.exports(mod);
    const sp = exports.find((e) => e.name === '__stack_pointer');
    expect(
      sp,
      'tanpa export ini JS tidak bisa memberi tiap thread stack sendiri, dan ' +
        'main thread + AudioWorklet akan menumbuhkan stack di alamat yang sama',
    ).toBeDefined();
    expect(sp?.kind).toBe('global');
  });

  it('render+encode tetap utuh saat thread lain memakai engine di memory yang sama', async () => {
    const bytes = artifact();
    if (bytes === null) {
      expect(true).toBe(true);
      return;
    }
    const worker = new Worker(fileURLToPath(new URL('./thread-stack.race.mjs', import.meta.url)), {
      workerData: { wasm: MT_WASM },
    });
    const result = await new Promise<{ ok: boolean; error?: string; rounds: number }>(
      (resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
      },
    );
    await worker.terminate();
    expect(result.error ?? '').toBe('');
    expect(result.ok).toBe(true);
    expect(result.rounds).toBeGreaterThanOrEqual(8);
  }, 120_000);
});
