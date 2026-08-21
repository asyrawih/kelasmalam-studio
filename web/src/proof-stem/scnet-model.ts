import type { InferenceSession } from 'onnxruntime-common';

let session: InferenceSession | null = null;
let runtime: typeof import('onnxruntime-web/wasm') | null = null;

export interface ScnetModelInfo {
  readonly loadMs: number;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly threads: number;
}

export async function loadScnetModel(): Promise<ScnetModelInfo> {
  const ort = await import('onnxruntime-web/wasm');
  runtime = ort;
  const threads = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 2));
  // Wrapper `.mjs` di-dynamic-import oleh ORT, jadi ia tidak boleh berada di
  // Vite `public/`. `new URL(..., import.meta.url)` membuat Vite menerbitkan
  // keduanya sebagai asset ber-hash dan memberi URL dev/build yang valid.
  const mjs = new URL(
    '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs',
    import.meta.url,
  ).href;
  const wasm = new URL(
    '../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',
    import.meta.url,
  ).href;
  ort.env.wasm.wasmPaths = {
    mjs,
    wasm,
  };
  ort.env.wasm.numThreads = threads;
  ort.env.wasm.simd = true;
  const started = performance.now();
  session ??= await ort.InferenceSession.create('/models/scnet/scnet-base.onnx', {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
    executionMode: 'sequential',
  });
  return {
    loadMs: performance.now() - started,
    inputs: session.inputNames,
    outputs: session.outputNames,
    threads,
  };
}

export async function runScnet(input: Float32Array, dims: readonly number[]): Promise<Float32Array> {
  if (session === null || runtime === null) await loadScnetModel();
  if (session === null || runtime === null) throw new Error('SCNet session gagal diinisialisasi');
  const tensor = new runtime.Tensor('float32', input, [...dims]);
  try {
    const output = await session.run({ spectrogram: tensor });
    const separated = output.separated;
    if (separated === undefined || !(separated.data instanceof Float32Array)) {
      throw new Error('Output ONNX `separated` tidak ditemukan atau bukan Float32Array');
    }
    return separated.data;
  } finally {
    tensor.dispose();
  }
}

export function hasScnetSession(): boolean {
  return session !== null;
}
