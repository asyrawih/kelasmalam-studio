/// <reference lib="webworker" />

/**
 * Worker vocal split (docs/26 §5): `init` memuat ONNX Kim_Vocal_2, `separate`
 * menjalankan pipa segmen `separateMdx`, `cancel` menghentikannya lewat
 * `AbortController`. Pola `proof-stem/separate.worker.ts`; protokolnya di
 * `split-protocol.ts`, pembungkus main thread-nya di `split-client.ts`.
 *
 * Satu job pada satu waktu: `separate` kedua saat job masih berjalan dijawab
 * `error`, bukan diantrekan — dialog SPLIT (P3) tidak pernah mengirim dua.
 */

import { loadVocalModel, runVocalModel } from './mdx-model';
import { VOCAL_MODELS, type VocalModelId } from './catalog';
import { separateMdx, type MdxModel } from './mdx-separate';
import type { SplitRequest, SplitResponse } from './split-protocol';

const scope = self as DedicatedWorkerGlobalScope;

let modelId: VocalModelId | null = null;
let running: AbortController | null = null;

function post(message: SplitResponse, transfer: Transferable[] = []): void {
  scope.postMessage(message, transfer);
}

scope.onmessage = (event: MessageEvent<SplitRequest>): void => {
  const request = event.data;
  if (request.type === 'init') {
    void loadVocalModel(request.modelId, (progress) => {
      post({ type: 'model-progress', ...progress });
    }, {
      bytes: request.bytes,
      maxThreads: request.maxThreads,
      executionProvider: request.executionProvider,
    })
      .then((info) => {
        modelId = request.modelId;
        post({ type: 'ready', ...info });
      })
      .catch(reportError);
    return;
  }

  if (request.type === 'cancel') {
    running?.abort();
    return;
  }

  if (modelId === null) {
    reportError(new Error('Model belum dimuat: kirim `init` sebelum `separate`'));
    return;
  }
  if (running !== null) {
    reportError(new Error('Vocal split masih berjalan; batalkan dulu sebelum memulai yang baru'));
    return;
  }

  const controller = new AbortController();
  running = controller;
  const started = performance.now();
  let lastSegmentAt = started;
  let inferenceMs = 0;
  // Hanya waktu di dalam ORT yang dihitung `inferenceMs`; STFT/iSTFT dan
  // penjahitan masuk `totalMs` saja — itu yang membedakan "modelnya lambat"
  // dari "transform-nya lambat" di benchmark P1.
  const model: MdxModel = async (input, dims) => {
    const before = performance.now();
    try {
      return await runVocalModel(input, dims);
    } finally {
      inferenceMs += performance.now() - before;
    }
  };

  void separateMdx(request.left, request.right, VOCAL_MODELS[modelId].mdx, model, {
    overlap: request.overlap,
    denoise: request.denoise,
    compensate: request.compensate,
    signal: controller.signal,
    onProgress: (done, total) => {
      const now = performance.now();
      post({ type: 'progress', done, total, segmentMs: now - lastSegmentAt });
      lastSegmentAt = now;
    },
  })
    .then(({ vocals, instrumental }) => {
      post({
        type: 'done',
        vocals,
        instrumental,
        totalMs: performance.now() - started,
        inferenceMs,
      }, [vocals.left.buffer, vocals.right.buffer, instrumental.left.buffer, instrumental.right.buffer]);
    })
    .catch((reason: unknown) => {
      if (reason instanceof DOMException && reason.name === 'AbortError') {
        post({ type: 'cancelled' });
        return;
      }
      reportError(reason);
    })
    .finally(() => {
      if (running === controller) running = null;
    });
};

function reportError(reason: unknown): void {
  post({
    type: 'error',
    message: reason instanceof Error ? reason.message : String(reason),
  });
}
