/// <reference lib="webworker" />

import { loadScnetModel, type ScnetModelId } from './scnet-model';
import { separateScnetPcm, type ScnetResult } from './scnet-separate';

type Request =
  | { readonly type: 'init'; readonly modelId: ScnetModelId }
  | { readonly type: 'separate'; readonly left: Float32Array; readonly right: Float32Array };

type Response =
  | { readonly type: 'ready'; readonly loadMs: number; readonly threads: number; readonly inputs: readonly string[]; readonly outputs: readonly string[]; readonly modelId: ScnetModelId; readonly modelBytes: number; readonly cacheHit: boolean }
  | { readonly type: 'model-progress'; readonly loaded: number; readonly total: number; readonly cacheHit: boolean }
  | { readonly type: 'chunk'; readonly start: number; readonly frames: number; readonly done: number; readonly total: number; readonly inferenceMs: number; readonly stems: ScnetResult }
  | { readonly type: 'phase'; readonly phase: 'stft' | 'model' | 'istft'; readonly chunk: number; readonly total: number }
  | { readonly type: 'done' }
  | { readonly type: 'error'; readonly message: string };

const scope = self as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<Request>): void => {
  if (event.data.type === 'init') {
    void loadScnetModel(event.data.modelId, (progress) => {
      scope.postMessage({ type: 'model-progress', ...progress } satisfies Response);
    })
      .then((info) => scope.postMessage({ type: 'ready', ...info } satisfies Response))
      .catch(reportError);
    return;
  }
  const { left, right } = event.data;
  void separateScnetPcm(left, right, (chunk, done, total, inferenceMs) => {
    const transfer: Transferable[] = [];
    for (const stem of Object.values(chunk.stems)) {
      transfer.push(stem.left.buffer, stem.right.buffer);
    }
    scope.postMessage({
      type: 'chunk', start: chunk.start, frames: chunk.frames,
      done, total, inferenceMs, stems: chunk.stems,
    } satisfies Response, transfer);
  }, (phase, chunk, total) => {
    scope.postMessage({ type: 'phase', phase, chunk, total } satisfies Response);
  }).then(() => scope.postMessage({ type: 'done' } satisfies Response)).catch(reportError);
};

function reportError(reason: unknown): void {
  scope.postMessage({
    type: 'error',
    message: reason instanceof Error ? reason.message : String(reason),
  } satisfies Response);
}
