import type { InferenceSession } from 'onnxruntime-common';

let session: InferenceSession | null = null;
let runtime: typeof import('onnxruntime-web/wasm') | null = null;

export type ScnetModelId = 'base' | 'large';

export interface ScnetModelDefinition {
  readonly id: ScnetModelId;
  readonly label: string;
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
}

export const SCNET_MODELS: Record<ScnetModelId, ScnetModelDefinition> = {
  base: {
    id: 'base', label: 'BASE · REALTIME',
    url: '/models/scnet/scnet-base.onnx', bytes: 44_516_685,
    sha256: '29137273515c3f10dc69e22a84a63bfc09b71abdf27cf801da463e0644870ade',
  },
  large: {
    id: 'large', label: 'LARGE · QUALITY',
    url: '/models/scnet/scnet-large.onnx', bytes: 170_914_085,
    sha256: 'b604b88207a8b3830b7969c7aef708c56710a39bd1c8b196f105ee7b68c0f939',
  },
};

export interface ScnetModelDownloadProgress {
  readonly loaded: number;
  readonly total: number;
  readonly cacheHit: boolean;
}

export interface ScnetModelInfo {
  readonly loadMs: number;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly threads: number;
  readonly modelId: ScnetModelId;
  readonly modelBytes: number;
  readonly cacheHit: boolean;
}

export async function loadScnetModel(
  modelId: ScnetModelId = 'base',
  onProgress: (progress: ScnetModelDownloadProgress) => void = () => {},
): Promise<ScnetModelInfo> {
  const ort = await import('onnxruntime-web/wasm');
  runtime = ort;
  const model = SCNET_MODELS[modelId];
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
  const cached = await loadModelBytes(model, onProgress);
  const started = performance.now();
  session ??= await ort.InferenceSession.create(cached.bytes, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
    executionMode: 'sequential',
  });
  return {
    loadMs: performance.now() - started,
    inputs: session.inputNames,
    outputs: session.outputNames,
    threads,
    modelId,
    modelBytes: model.bytes,
    cacheHit: cached.cacheHit,
  };
}

async function loadModelBytes(
  model: ScnetModelDefinition,
  onProgress: (progress: ScnetModelDownloadProgress) => void,
): Promise<{ readonly bytes: Uint8Array; readonly cacheHit: boolean }> {
  if (typeof navigator.storage?.getDirectory !== 'function') {
    const response = await fetchModel(model);
    const bytes = new Uint8Array(await response.arrayBuffer());
    assertModelSize(model, bytes.byteLength);
    onProgress({ loaded: bytes.byteLength, total: model.bytes, cacheHit: false });
    return { bytes, cacheHit: false };
  }

  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle('scnet-models', { create: true });
  const fileName = `scnet-${model.id}-${model.sha256.slice(0, 12)}.onnx`;
  try {
    const existing = await directory.getFileHandle(fileName);
    const file = await existing.getFile();
    if (file.size === model.bytes) {
      onProgress({ loaded: file.size, total: model.bytes, cacheHit: true });
      return { bytes: new Uint8Array(await file.arrayBuffer()), cacheHit: true };
    }
    await directory.removeEntry(fileName);
  } catch {
    // Cache miss normal.
  }

  void navigator.storage.persist?.();
  const response = await fetchModel(model);
  const handle = await directory.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  const reader = response.body?.getReader();
  let loaded = 0;
  try {
    if (reader === undefined) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      await writable.write(bytes);
      loaded = bytes.byteLength;
      onProgress({ loaded, total: model.bytes, cacheHit: false });
    } else {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writable.write(value);
        loaded += value.byteLength;
        onProgress({ loaded, total: model.bytes, cacheHit: false });
      }
    }
    await writable.close();
  } catch (reason) {
    await writable.abort(reason).catch(() => {});
    await directory.removeEntry(fileName).catch(() => {});
    throw reason;
  }

  assertModelSize(model, loaded);
  const file = await handle.getFile();
  return { bytes: new Uint8Array(await file.arrayBuffer()), cacheHit: false };
}

async function fetchModel(model: ScnetModelDefinition): Promise<Response> {
  const response = await fetch(model.url);
  if (!response.ok) throw new Error(`Download ${model.label} gagal: HTTP ${response.status}`);
  return response;
}

function assertModelSize(model: ScnetModelDefinition, actual: number): void {
  if (actual !== model.bytes) {
    throw new Error(`Model ${model.label} tidak lengkap: ${actual} / ${model.bytes} byte`);
  }
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
