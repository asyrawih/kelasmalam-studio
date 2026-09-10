/**
 * `createSplitClient` menerjemahkan protokol `split-protocol.ts` ke Promise
 * dengan benar — diuji lewat `Worker` palsu, tanpa ORT (tidak ada WASM di
 * jsdom). Yang dijaga: bentuk pesan `init`/`separate`/`cancel` yang dikirim,
 * transfer buffer, pemilihan jalur byte lewat KONTRAK host, dan penyelesaian
 * Promise untuk `ready`/`done`/`cancelled`/`error`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPlatformHostForTests, type PlatformHost, type ScnetModelDownloadProgress } from '@kelasmalam/platform';
import { createSplitClient, type SplitProgress } from '../split-client';
import type { SplitRequest, SplitResponse } from '../split-protocol';
import type { VocalModelInfo } from '../mdx-model';

const baseHost: PlatformHost = {
  kind: 'web',
  pickSaveTarget: async () => ({ kind: 'cancelled' }),
  openExternal: async () => {},
  authHeaders: async () => ({}),
};

interface Sent { readonly message: SplitRequest; readonly transfer: readonly Transferable[] }

/** Worker palsu: mencatat `postMessage`, dan tes menyuntik balasan lewat `emit`. */
class FakeWorker {
  static instances: FakeWorker[] = [];
  readonly url: URL;
  readonly options: WorkerOptions | undefined;
  readonly sent: Sent[] = [];
  terminated = false;
  onmessage: ((event: MessageEvent<SplitResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  constructor(url: URL, options?: WorkerOptions) {
    this.url = url;
    this.options = options;
    FakeWorker.instances.push(this);
  }

  postMessage(message: SplitRequest, transfer: Transferable[] = []): void {
    this.sent.push({ message, transfer });
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(message: SplitResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<SplitResponse>);
  }

  get last(): Sent {
    return this.sent[this.sent.length - 1]!;
  }
}

const READY: VocalModelInfo = {
  loadMs: 12, inputs: ['input'], outputs: ['output'], threads: 4,
  modelId: 'kim-vocal-2', modelBytes: 66_759_214, cacheHit: true, executionProvider: 'wasm',
};

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
  setPlatformHostForTests(baseHost);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setPlatformHostForTests(null);
});

function worker(): FakeWorker {
  return FakeWorker.instances[0]!;
}

async function readyClient() {
  const client = createSplitClient();
  const init = client.init('kim-vocal-2');
  await flush();
  worker().emit({ type: 'ready', ...READY });
  await init;
  return client;
}

describe('createSplitClient · init', () => {
  it('membuat worker modul dari split.worker.ts', () => {
    createSplitClient();
    expect(FakeWorker.instances).toHaveLength(1);
    expect(worker().url.pathname.endsWith('/split.worker.ts')).toBe(true);
    expect(worker().options).toEqual({ type: 'module' });
  });

  it('host tanpa modelBytes → init tanpa bytes; model-progress diteruskan; ready → info', async () => {
    const client = createSplitClient();
    const progress: ScnetModelDownloadProgress[] = [];
    const init = client.init('kim-vocal-2', (p) => progress.push(p), { maxThreads: 6, executionProvider: 'webgpu' });
    await flush();
    expect(worker().sent).toHaveLength(1);
    expect(worker().last.message).toEqual({ type: 'init', modelId: 'kim-vocal-2', maxThreads: 6, executionProvider: 'webgpu' });
    expect(worker().last.transfer).toEqual([]);

    worker().emit({ type: 'model-progress', loaded: 10, total: 20, cacheHit: false });
    worker().emit({ type: 'ready', ...READY });
    await expect(init).resolves.toEqual(READY);
    expect(progress).toEqual([{ loaded: 10, total: 20, cacheHit: false }]);
  });

  it('host dengan modelBytes → byte diambil di main thread dan DIPINDAHKAN ke worker', async () => {
    const bytes = new Uint8Array([7, 8, 9]);
    const modelBytes = vi.fn(async (_id: string, onProgress: (p: ScnetModelDownloadProgress) => void) => {
      onProgress({ loaded: 3, total: 3, cacheHit: false });
      return { bytes, cacheHit: false };
    });
    setPlatformHostForTests({ ...baseHost, modelBytes });
    const client = createSplitClient();
    const progress: ScnetModelDownloadProgress[] = [];
    const init = client.init('kim-vocal-2', (p) => progress.push(p));
    await flush();
    expect(modelBytes).toHaveBeenCalledWith('kim-vocal-2', expect.any(Function));
    expect(progress).toEqual([{ loaded: 3, total: 3, cacheHit: false }]);
    expect(worker().last.message).toMatchObject({ type: 'init', modelId: 'kim-vocal-2', bytes });
    expect(worker().last.transfer).toEqual([bytes.buffer]);
    worker().emit({ type: 'ready', ...READY });
    await expect(init).resolves.toEqual(READY);
  });

  it('host modelBytes gagal → init reject, tidak ada pesan ke worker', async () => {
    setPlatformHostForTests({ ...baseHost, modelBytes: async () => { throw new Error('unduhan gagal'); } });
    const client = createSplitClient();
    await expect(client.init('kim-vocal-2')).rejects.toThrow('unduhan gagal');
    expect(worker().sent).toHaveLength(0);
  });

  it('error dari worker saat init → reject dengan pesannya', async () => {
    const client = createSplitClient();
    const init = client.init('kim-vocal-2');
    await flush();
    worker().emit({ type: 'error', message: 'Model KIM VOCAL 2 tidak lengkap' });
    await expect(init).rejects.toThrow('Model KIM VOCAL 2 tidak lengkap');
  });

  it('separate sebelum init → reject tanpa menyentuh worker', async () => {
    const client = createSplitClient();
    await expect(client.separate(new Float32Array(4), new Float32Array(4), { overlap: 0.25, denoise: false }))
      .rejects.toThrow(/init dulu/);
    expect(worker().sent).toHaveLength(0);
  });
});

describe('createSplitClient · separate', () => {
  it('menyalin PCM secara default (sumber tetap utuh), meneruskan opsi, progres, dan hasil done', async () => {
    const client = await readyClient();
    const left = new Float32Array([1, 2, 3]);
    const right = new Float32Array([4, 5, 6]);
    const progress: SplitProgress[] = [];
    const job = client.separate(left, right, { overlap: 0.5, denoise: true, compensate: false }, (p) => progress.push(p));

    const { message, transfer } = worker().last;
    expect(message).toMatchObject({ type: 'separate', overlap: 0.5, denoise: true, compensate: false });
    if (message.type !== 'separate') throw new Error('bukan separate');
    expect([...message.left]).toEqual([1, 2, 3]);
    expect([...message.right]).toEqual([4, 5, 6]);
    expect(transfer).toEqual([message.left.buffer, message.right.buffer]);
    // Salinan: buffer sumber bukan yang dipindahkan.
    expect(message.left.buffer).not.toBe(left.buffer);
    expect(left.byteLength).toBe(12);

    worker().emit({ type: 'progress', done: 1, total: 2, segmentMs: 40 });
    worker().emit({ type: 'progress', done: 2, total: 2, segmentMs: 41 });
    const vocals = { left: new Float32Array([0.1, 0.2, 0.3]), right: new Float32Array([0.4, 0.5, 0.6]) };
    const instrumental = { left: new Float32Array([0.9, 1.8, 2.7]), right: new Float32Array([3.6, 4.5, 5.4]) };
    worker().emit({ type: 'done', vocals, instrumental, totalMs: 100, inferenceMs: 80 });

    const result = await job;
    expect(result).toEqual({ vocals, instrumental, totalMs: 100, inferenceMs: 80 });
    expect(progress).toEqual([
      { done: 1, total: 2, segmentMs: 40 },
      { done: 2, total: 2, segmentMs: 41 },
    ]);
  });

  it('transfer: true → buffer sumber yang dipindahkan', async () => {
    const client = await readyClient();
    const left = new Float32Array([1, 2]);
    const right = new Float32Array([3, 4]);
    void client.separate(left, right, { overlap: 0, denoise: false, transfer: true }).catch(() => {});
    const { message, transfer } = worker().last;
    if (message.type !== 'separate') throw new Error('bukan separate');
    expect(message.left).toBe(left);
    expect(transfer).toEqual([left.buffer, right.buffer]);
  });

  it('abort signal → kirim cancel, reject AbortError setelah worker menjawab cancelled', async () => {
    const client = await readyClient();
    const controller = new AbortController();
    const job = client.separate(new Float32Array(4), new Float32Array(4), { overlap: 0.25, denoise: false }, undefined, controller.signal);
    expect(worker().sent).toHaveLength(2);
    controller.abort();
    expect(worker().last.message).toEqual({ type: 'cancel' });
    worker().emit({ type: 'cancelled' });
    await expect(job).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('signal sudah aborted sebelum separate → reject langsung tanpa pesan', async () => {
    const client = await readyClient();
    const controller = new AbortController();
    controller.abort();
    await expect(client.separate(new Float32Array(4), new Float32Array(4), { overlap: 0.25, denoise: false }, undefined, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(worker().sent).toHaveLength(1);
  });

  it('done tiba setelah abort → tetap AbortError, hasil dibuang', async () => {
    const client = await readyClient();
    const controller = new AbortController();
    const job = client.separate(new Float32Array(2), new Float32Array(2), { overlap: 0, denoise: false }, undefined, controller.signal);
    controller.abort();
    const pcm = { left: new Float32Array(2), right: new Float32Array(2) };
    worker().emit({ type: 'done', vocals: pcm, instrumental: pcm, totalMs: 1, inferenceMs: 1 });
    await expect(job).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('error dari worker saat separate → reject; job berikutnya boleh mulai', async () => {
    const client = await readyClient();
    const first = client.separate(new Float32Array(2), new Float32Array(2), { overlap: 0, denoise: false });
    worker().emit({ type: 'error', message: 'shape mismatch' });
    await expect(first).rejects.toThrow('shape mismatch');
    const second = client.separate(new Float32Array(2), new Float32Array(2), { overlap: 0, denoise: false });
    expect(worker().last.message.type).toBe('separate');
    worker().emit({ type: 'cancelled' });
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('dua separate bersamaan → yang kedua ditolak, yang pertama tetap jalan', async () => {
    const client = await readyClient();
    const first = client.separate(new Float32Array(2), new Float32Array(2), { overlap: 0, denoise: false });
    await expect(client.separate(new Float32Array(2), new Float32Array(2), { overlap: 0, denoise: false }))
      .rejects.toThrow(/masih berjalan/);
    const pcm = { left: new Float32Array(2), right: new Float32Array(2) };
    worker().emit({ type: 'done', vocals: pcm, instrumental: pcm, totalMs: 1, inferenceMs: 1 });
    await expect(first).resolves.toMatchObject({ totalMs: 1 });
  });
});

describe('createSplitClient · dispose', () => {
  it('terminate worker, reject job yang menunggu, dan menolak pemakaian selanjutnya', async () => {
    const client = await readyClient();
    const job = client.separate(new Float32Array(2), new Float32Array(2), { overlap: 0, denoise: false });
    client.dispose();
    expect(worker().terminated).toBe(true);
    await expect(job).rejects.toThrow(/dibuang/);
    await expect(client.init('kim-vocal-2')).rejects.toThrow(/dibuang/);
    await expect(client.separate(new Float32Array(2), new Float32Array(2), { overlap: 0, denoise: false })).rejects.toThrow(/dibuang/);
  });

  it('worker.onerror → init yang menunggu reject', async () => {
    const client = createSplitClient();
    const init = client.init('kim-vocal-2');
    await flush();
    worker().onerror?.({ message: 'gagal memuat modul worker', error: undefined } as unknown as ErrorEvent);
    await expect(init).rejects.toThrow('gagal memuat modul worker');
  });
});
