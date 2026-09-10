/**
 * Sesi vocal split di jalur worker (web): probe WebGPU, bawaan `wasmAccel`,
 * EP yang diteruskan ke `SplitClient.init`, ganti EP → sesi lama dibuang dan
 * dimuat ulang, fallback `init` WebGPU → WASM (sekali, dengan `runtimeNote`),
 * dan angka thread bawaan/batas. Klien worker dipalsukan lewat
 * `vi.mock('../split-client')` — tidak ada ORT di jsdom. Fallback saat
 * `separate` diuji di `split-job.test.ts` (ia milik job).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VocalModelInfo, VocalExecutionProvider } from '../mdx-model';
import type { SplitClient, SplitInitOptions, SplitResult, SplitSeparateOptions } from '../split-client';
import {
  __resetVocalSplitSessionForTest,
  defaultVocalSplitThreads,
  ensureVocalModel,
  maxVocalSplitThreads,
  probeVocalSplitRuntime,
  probeWebGpu,
  readyVocalSplitClient,
  setVocalSplitWasmAccel,
  vocalSplitSessionExecutionProvider,
  vocalSplitSnapshot,
} from '../split-session';

const holder = vi.hoisted(() => ({ create: (): unknown => null }));

vi.mock('../split-client', () => ({
  createSplitClient: () => holder.create(),
}));

const info = (executionProvider: VocalExecutionProvider): VocalModelInfo => ({
  loadMs: 1, inputs: ['input'], outputs: ['output'], threads: 4,
  modelId: 'kim-vocal-2', modelBytes: 66_759_214, cacheHit: true, executionProvider,
});

/** Klien palsu: `init` mencatat opsinya dan menunggu perintah tes (`ready`/`fail`). */
class FakeClient implements SplitClient {
  static all: FakeClient[] = [];
  initOptions: SplitInitOptions | undefined;
  initCalls = 0;
  disposed = false;
  private resolve: ((i: VocalModelInfo) => void) | null = null;
  private reject: ((reason: unknown) => void) | null = null;

  constructor() {
    FakeClient.all.push(this);
  }

  init(_modelId: 'kim-vocal-2', _onProgress?: unknown, options?: SplitInitOptions): Promise<VocalModelInfo> {
    this.initCalls += 1;
    this.initOptions = options;
    return new Promise<VocalModelInfo>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }

  separate(_l: Float32Array, _r: Float32Array, _o: SplitSeparateOptions): Promise<SplitResult> {
    return Promise.reject(new Error('tidak dipakai di tes sesi'));
  }

  dispose(): void {
    this.disposed = true;
  }

  ready(): void {
    this.resolve?.(info(this.initOptions?.executionProvider ?? 'wasm'));
  }

  fail(message: string): void {
    this.reject?.(new Error(message));
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Pasang `navigator.gpu` palsu; `adapter` = jawaban `requestAdapter` (null = ada API tanpa GPU). */
function installGpu(adapter: unknown | (() => Promise<unknown>)): ReturnType<typeof vi.fn> {
  const requestAdapter = vi.fn(typeof adapter === 'function' ? (adapter as () => Promise<unknown>) : async () => adapter);
  Object.defineProperty(navigator, 'gpu', { value: { requestAdapter }, configurable: true });
  return requestAdapter;
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  FakeClient.all = [];
  holder.create = () => new FakeClient();
  Object.defineProperty(navigator, 'hardwareConcurrency', { value: 8, configurable: true });
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  __resetVocalSplitSessionForTest();
});

afterEach(() => {
  warn.mockRestore();
  delete (navigator as unknown as { gpu?: unknown }).gpu;
  __resetVocalSplitSessionForTest();
});

describe('probeWebGpu', () => {
  it('tanpa navigator.gpu → false', async () => {
    await expect(probeWebGpu()).resolves.toBe(false);
  });

  it('requestAdapter() null → false (API ada, GPU tidak)', async () => {
    installGpu(null);
    await expect(probeWebGpu()).resolves.toBe(false);
  });

  it('requestAdapter() melempar → false, tanpa exception ke pemanggil', async () => {
    installGpu(() => Promise.reject(new Error('gpu mati')));
    await expect(probeWebGpu()).resolves.toBe(false);
    expect(String(warn.mock.calls[0]![0])).toMatch(/requestAdapter\(\) gagal/);
  });

  it('adapter ada → true; probe hanya sekali (di-cache)', async () => {
    const requestAdapter = installGpu({ name: 'gpu' });
    await expect(probeWebGpu()).resolves.toBe(true);
    await expect(probeWebGpu()).resolves.toBe(true);
    expect(requestAdapter).toHaveBeenCalledTimes(1);
  });
});

describe('probeVocalSplitRuntime · jalur web', () => {
  it('tanpa WebGPU → wasmAccels [wasm], wasmAccel wasm', async () => {
    await expect(probeVocalSplitRuntime()).resolves.toBe('wasm');
    expect(vocalSplitSnapshot()).toMatchObject({ runtime: 'wasm', wasmAccels: ['wasm'], wasmAccel: 'wasm' });
  });

  it('WebGPU tersedia → ditawarkan DAN jadi bawaan', async () => {
    installGpu({});
    await probeVocalSplitRuntime();
    expect(vocalSplitSnapshot()).toMatchObject({ runtime: 'wasm', wasmAccels: ['wasm', 'webgpu'], wasmAccel: 'webgpu' });
  });

  it('sesi sudah mulai sebelum probe selesai → bawaan tetap wasm (sesi tidak diganggu), webgpu tetap ditawarkan', async () => {
    installGpu({});
    const probe = probeVocalSplitRuntime();
    void ensureVocalModel('kim-vocal-2').catch(() => {});
    await probe;
    expect(vocalSplitSnapshot()).toMatchObject({ wasmAccels: ['wasm', 'webgpu'], wasmAccel: 'wasm' });
    expect(FakeClient.all[0]!.initOptions?.executionProvider).toBe('wasm');
  });
});

describe('ensureVocalModel · EP jalur worker', () => {
  it('EP bawaan = wasmAccel sesi, diteruskan ke SplitClient.init bersama maxThreads', async () => {
    installGpu({});
    await probeVocalSplitRuntime();
    const ready = ensureVocalModel('kim-vocal-2', { maxThreads: 6 });
    const client = FakeClient.all[0]!;
    expect(client.initOptions).toEqual({ maxThreads: 6, executionProvider: 'webgpu' });
    client.ready();
    await expect(ready).resolves.toMatchObject({ runtime: 'wasm', model: { executionProvider: 'webgpu' } });
    expect(vocalSplitSessionExecutionProvider()).toBe('webgpu');
    expect(readyVocalSplitClient('kim-vocal-2')).toBe(client);
  });

  it('executionProvider eksplisit (benchmark) mengalahkan wasmAccel', async () => {
    void ensureVocalModel('kim-vocal-2', { executionProvider: 'webgpu' }).catch(() => {});
    expect(FakeClient.all[0]!.initOptions?.executionProvider).toBe('webgpu');
  });

  it('ganti EP lewat setVocalSplitWasmAccel → klien lama dibuang, klien baru init dengan EP baru dan thread yang sama', async () => {
    installGpu({});
    await probeVocalSplitRuntime();
    const first = ensureVocalModel('kim-vocal-2', { maxThreads: 3 });
    FakeClient.all[0]!.ready();
    await first;

    setVocalSplitWasmAccel('wasm');
    expect(vocalSplitSnapshot().wasmAccel).toBe('wasm');
    expect(FakeClient.all[0]!.disposed).toBe(true);
    expect(FakeClient.all).toHaveLength(2);
    expect(FakeClient.all[1]!.initOptions).toEqual({ maxThreads: 3, executionProvider: 'wasm' });
    expect(vocalSplitSnapshot().model.kind).toBe('loading');
    FakeClient.all[1]!.ready();
    await flush();
    expect(vocalSplitSnapshot().model).toMatchObject({ kind: 'ready', info: { model: { executionProvider: 'wasm' } } });
    expect(readyVocalSplitClient('kim-vocal-2')).toBe(FakeClient.all[1]);

    // Sesi wasm yang sudah siap dipakai ulang, bukan dimuat lagi.
    await ensureVocalModel('kim-vocal-2', { maxThreads: 3 });
    expect(FakeClient.all).toHaveLength(2);
  });

  it('setVocalSplitWasmAccel dengan nilai yang tidak ditawarkan → diabaikan', async () => {
    await probeVocalSplitRuntime();
    setVocalSplitWasmAccel('webgpu');
    expect(vocalSplitSnapshot().wasmAccel).toBe('wasm');
    expect(FakeClient.all).toHaveLength(0);
  });
});

describe('ensureVocalModel · fallback init WebGPU → WASM', () => {
  it('init webgpu gagal → klien baru init wasm, wasmAccel wasm, runtimeNote, console.warn; sesi siap', async () => {
    installGpu({});
    await probeVocalSplitRuntime();
    const ready = ensureVocalModel('kim-vocal-2', { maxThreads: 5 });
    const gpu = FakeClient.all[0]!;
    expect(gpu.initOptions?.executionProvider).toBe('webgpu');
    gpu.fail('WebGPU: shader gagal dikompilasi');
    await flush();

    expect(gpu.disposed).toBe(true);
    expect(FakeClient.all).toHaveLength(2);
    const cpu = FakeClient.all[1]!;
    expect(cpu.initOptions).toEqual({ maxThreads: 5, executionProvider: 'wasm' });
    expect(vocalSplitSnapshot()).toMatchObject({
      wasmAccel: 'wasm',
      wasmAccels: ['wasm', 'webgpu'],
      runtimeNote: 'WebGPU gagal (init: WebGPU: shader gagal dikompilasi), memakai WASM',
      model: { kind: 'loading' },
    });
    expect(String(warn.mock.calls[0]![0])).toMatch(/webgpu gagal, jatuh ke wasm: init: WebGPU: shader gagal dikompilasi/);

    cpu.ready();
    await expect(ready).resolves.toMatchObject({ runtime: 'wasm', model: { executionProvider: 'wasm' } });
    expect(vocalSplitSessionExecutionProvider()).toBe('wasm');
    expect(readyVocalSplitClient('kim-vocal-2')).toBe(cpu);
    expect(vocalSplitSnapshot().runtimeNote).toMatch(/memakai WASM/);
  });

  it('init wasm setelah fallback ikut gagal → galat dilempar, tidak ada klien ketiga', async () => {
    installGpu({});
    await probeVocalSplitRuntime();
    const ready = ensureVocalModel('kim-vocal-2');
    FakeClient.all[0]!.fail('gpu');
    await flush();
    FakeClient.all[1]!.fail('wasm juga gagal');
    await expect(ready).rejects.toThrow('wasm juga gagal');
    expect(FakeClient.all).toHaveLength(2);
    expect(vocalSplitSnapshot().model).toEqual({ kind: 'error', message: 'wasm juga gagal' });
  });

  it('init wasm gagal → tidak ada fallback (tidak ada tempat jatuh), tanpa runtimeNote', async () => {
    const ready = ensureVocalModel('kim-vocal-2');
    FakeClient.all[0]!.fail('HTTP 500');
    await expect(ready).rejects.toThrow('HTTP 500');
    expect(FakeClient.all).toHaveLength(1);
    expect(vocalSplitSnapshot().runtimeNote).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('AbortError dari init webgpu → tidak fallback', async () => {
    installGpu({});
    await probeVocalSplitRuntime();
    const ready = ensureVocalModel('kim-vocal-2');
    const gpu = FakeClient.all[0]!;
    (gpu as unknown as { reject: (r: unknown) => void }).reject(new DOMException('batal', 'AbortError'));
    await expect(ready).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeClient.all).toHaveLength(1);
    expect(vocalSplitSnapshot().runtimeNote).toBeNull();
  });

  it('sesi baru (UNDUH lagi / ganti EP) menghapus runtimeNote', async () => {
    installGpu({});
    await probeVocalSplitRuntime();
    const ready = ensureVocalModel('kim-vocal-2');
    FakeClient.all[0]!.fail('gpu');
    await flush();
    FakeClient.all[1]!.ready();
    await ready;
    expect(vocalSplitSnapshot().runtimeNote).not.toBeNull();
    setVocalSplitWasmAccel('webgpu');
    expect(vocalSplitSnapshot().runtimeNote).toBeNull();
    expect(FakeClient.all[2]!.initOptions?.executionProvider).toBe('webgpu');
  });
});

describe('thread', () => {
  const withCores = (n: number): void => {
    Object.defineProperty(navigator, 'hardwareConcurrency', { value: n, configurable: true });
  };

  it('bawaan min(8, cores − 2), minimal 1', () => {
    withCores(10);
    expect(defaultVocalSplitThreads()).toBe(8);
    withCores(16);
    expect(defaultVocalSplitThreads()).toBe(8);
    withCores(8);
    expect(defaultVocalSplitThreads()).toBe(6);
    withCores(4);
    expect(defaultVocalSplitThreads()).toBe(2);
    withCores(2);
    expect(defaultVocalSplitThreads()).toBe(1);
    withCores(1);
    expect(defaultVocalSplitThreads()).toBe(1);
  });

  it('batas atas dialog cores − 1, minimal 1', () => {
    withCores(10);
    expect(maxVocalSplitThreads()).toBe(9);
    withCores(2);
    expect(maxVocalSplitThreads()).toBe(1);
    withCores(1);
    expect(maxVocalSplitThreads()).toBe(1);
  });

  it('hardwareConcurrency 0/undefined → dianggap 2 core', () => {
    withCores(0);
    expect(defaultVocalSplitThreads()).toBe(1);
    expect(maxVocalSplitThreads()).toBe(1);
  });
});
