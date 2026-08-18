/** @vitest-environment node */
/**
 * ABI mentah `fxchain_*` — jalur yang dipakai worklet `daw-fx`.
 *
 * Worklet-nya sendiri tidak bisa dites di sini: `AudioWorklet` tidak ada di
 * jsdom maupun Node. Tapi yang paling mungkin salah bukan kerangka
 * AudioWorklet-nya, melainkan kontrak antara JS dan WASM — tata letak buffer
 * in-place, urutan argumen, dan apakah chain-nya benar-benar memproses.
 *
 * Karena itu tes ini meng-instansiasi artefak `st` PERSIS seperti worklet:
 * lewat `new WebAssembly.Instance` dengan stub imports, bukan lewat glue
 * bindgen. Kalau ada yang menggeser ABI-nya, tes ini gagal — bukan tombol PLAY
 * di browser yang diam-diam tidak berefek.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

interface FxRaw {
  memory: WebAssembly.Memory;
  scratch_alloc(len: number): number;
  scratch_free(ptr: number, len: number): void;
  fxchain_new(sr: number, kinds: number, bypass: number, len: number): number;
  fxchain_free(ptr: number): void;
  fxchain_io_ptr(ptr: number): number;
  fxchain_stride(): number;
  fxchain_process(ptr: number, frames: number): void;
  fxchain_set_param(ptr: number, slot: number, index: number, value: number): void;
  fxchain_set_bypass(ptr: number, slot: number, on: number): void;
}

let raw: FxRaw;
const SR = 48_000;
const N = 128;

/** Sama dengan `buildStubImports` di fx-worklet.ts. */
function stubs(module: WebAssembly.Module): WebAssembly.Imports {
  const imports: WebAssembly.Imports = {};
  for (const d of WebAssembly.Module.imports(module)) {
    const ns = (imports[d.module] ??= {} as WebAssembly.ModuleImports);
    if (d.kind === 'function') {
      ns[d.name] = () => {
        throw new Error(`import non-RT: ${d.module}.${d.name}`);
      };
    } else if (d.kind === 'global') {
      ns[d.name] = 0 as unknown as WebAssembly.Global;
    } else if (d.kind === 'table') {
      ns[d.name] = new WebAssembly.Table({ initial: 0, element: 'anyfunc' });
    }
  }
  return imports;
}

beforeAll(async () => {
  const wasmPath = fileURLToPath(new URL('../wasm/st/engine_bg.wasm', import.meta.url));
  const module = await WebAssembly.compile(readFileSync(wasmPath));
  raw = new WebAssembly.Instance(module, stubs(module)).exports as unknown as FxRaw;
});

/** Bangun chain seperti yang dilakukan konstruktor worklet. */
function makeChain(kinds: number[], bypass: number[]): number {
  const n = kinds.length;
  if (n === 0) return raw.fxchain_new(SR, 0, 0, 0);
  const kp = raw.scratch_alloc(n * 2);
  const bp = raw.scratch_alloc(n);
  new Uint16Array(raw.memory.buffer, kp, n).set(kinds);
  new Uint8Array(raw.memory.buffer, bp, n).set(bypass);
  const ptr = raw.fxchain_new(SR, kp, bp, n);
  raw.scratch_free(kp, n * 2);
  raw.scratch_free(bp, n);
  return ptr;
}

/** Jalankan `blocks` blok DC 0.5 dan kembalikan puncak blok terakhir. */
function runDc(ptr: number, blocks: number): number {
  const stride = raw.fxchain_stride();
  const io = raw.fxchain_io_ptr(ptr);
  let peak = 0;
  for (let b = 0; b < blocks; b += 1) {
    const view = new Float32Array(raw.memory.buffer, io, stride * 2);
    view.fill(0.5, 0, N);
    view.fill(0.5, stride, stride + N);
    raw.fxchain_process(ptr, N);
    if (b === blocks - 1) {
      const out = new Float32Array(raw.memory.buffer, io, stride * 2);
      for (let i = 0; i < N; i += 1) peak = Math.max(peak, Math.abs(out[i]!));
    }
  }
  return peak;
}

describe('ABI fxchain', () => {
  it('mengekspor seluruh fungsi yang dipakai worklet', () => {
    for (const fn of [
      'fxchain_new',
      'fxchain_free',
      'fxchain_io_ptr',
      'fxchain_stride',
      'fxchain_process',
      'fxchain_set_param',
      'fxchain_set_bypass',
      'scratch_alloc',
      'scratch_free',
    ] as const) {
      expect(typeof raw[fn], `${fn} hilang dari artefak`).toBe('function');
    }
    expect(raw.fxchain_stride()).toBeGreaterThanOrEqual(N);
  });

  /// Inilah yang membedakan "kompilasi" dari "jalan".
  it('EQ highpass benar-benar membuang DC', () => {
    const ptr = makeChain([0], [0]); // kind 0 = eq4
    expect(ptr).not.toBe(0);
    // b1_kind = HighPass(1), b1_freq = 1000, b1_q = 0.707, b1_on = 1.
    raw.fxchain_set_param(ptr, 0, 0, 1);
    raw.fxchain_set_param(ptr, 0, 1, 1000);
    raw.fxchain_set_param(ptr, 0, 2, 0.707);
    raw.fxchain_set_param(ptr, 0, 4, 1);

    const peak = runDc(ptr, 60);
    raw.fxchain_free(ptr);
    expect(peak, `DC masih tersisa ${peak}`).toBeLessThan(0.05);
  });

  it('chain kosong melewatkan sinyal apa adanya', () => {
    const ptr = makeChain([], []);
    expect(ptr).not.toBe(0);
    const peak = runDc(ptr, 10);
    raw.fxchain_free(ptr);
    expect(Math.abs(peak - 0.5)).toBeLessThan(1e-5);
  });

  it('efek yang dibangun ter-bypass tidak menyentuh sinyal', () => {
    const ptr = makeChain([0], [1]);
    raw.fxchain_set_param(ptr, 0, 0, 1);
    raw.fxchain_set_param(ptr, 0, 1, 1000);
    raw.fxchain_set_param(ptr, 0, 4, 1);
    const peak = runDc(ptr, 10);
    raw.fxchain_free(ptr);
    expect(Math.abs(peak - 0.5), `bypass tidak transparan: ${peak}`).toBeLessThan(1e-3);
  });

  it('jenis efek yang tidak dikenal dilewati, bukan bikin gagal', () => {
    const ptr = makeChain([9999], [0]);
    expect(ptr).not.toBe(0);
    const peak = runDc(ptr, 5);
    raw.fxchain_free(ptr);
    expect(Math.abs(peak - 0.5)).toBeLessThan(1e-5);
  });

  it('pointer null dan frame nol tidak bikin crash', () => {
    expect(() => raw.fxchain_process(0, 128)).not.toThrow();
    expect(() => raw.fxchain_set_param(0, 0, 0, 1)).not.toThrow();
    expect(() => raw.fxchain_free(0)).not.toThrow();
    const ptr = makeChain([0], [0]);
    expect(() => raw.fxchain_process(ptr, 0)).not.toThrow();
    raw.fxchain_free(ptr);
  });
});
