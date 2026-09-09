/// <reference lib="webworker" />

import { loadScnetModel } from '../proof-stem/scnet-model';
import { separateScnetPcm, type ScnetResult } from '../proof-stem/scnet-separate';

const TARGET_SAMPLE_RATE = 44_100;

type Request =
  /** `bytes` hanya dari desktop (lihat `prefetchModelBytes`); web membiarkannya kosong. */
  | { readonly type: 'init'; readonly bytes?: Uint8Array }
  | {
      readonly type: 'separate';
      readonly assetId: number;
      readonly sampleRate: number;
      readonly left: Float32Array;
      readonly right: Float32Array;
    };

type Response =
  | { readonly type: 'model-progress'; readonly loaded: number; readonly total: number; readonly cacheHit: boolean }
  | { readonly type: 'ready'; readonly loadMs: number; readonly threads: number; readonly cacheHit: boolean }
  | { readonly type: 'job-start'; readonly assetId: number; readonly frames: number; readonly sampleRate: number }
  | {
      readonly type: 'chunk';
      readonly assetId: number;
      readonly start: number;
      readonly frames: number;
      readonly done: number;
      readonly total: number;
      readonly stems: ScnetResult;
    }
  | {
      readonly type: 'phase';
      readonly assetId: number;
      readonly phase: 'stft' | 'model' | 'istft';
      readonly chunk: number;
      readonly total: number;
    }
  | { readonly type: 'done'; readonly assetId: number }
  | { readonly type: 'error'; readonly assetId: number | null; readonly message: string };

const scope = self as DedicatedWorkerGlobalScope;
let modelReady: Promise<void> | null = null;

function ensureModel(bytes?: Uint8Array): Promise<void> {
  modelReady ??= loadScnetModel(
    'base',
    (progress) => scope.postMessage({ type: 'model-progress', ...progress } satisfies Response),
    // Background separation harus menyisakan CPU untuk Web Audio dan UI.
    { maxThreads: 2, bytes },
  ).then((info) => {
    scope.postMessage({
      type: 'ready',
      loadMs: info.loadMs,
      threads: info.threads,
      cacheHit: info.cacheHit,
    } satisfies Response);
  });
  return modelReady;
}

scope.onmessage = (event: MessageEvent<Request>): void => {
  if (event.data.type === 'init') {
    void ensureModel(event.data.bytes).catch((reason) => reportError(null, reason));
    return;
  }

  const request = event.data;
  void separate(request).catch((reason) => reportError(request.assetId, reason));
};

async function separate(request: Extract<Request, { readonly type: 'separate' }>): Promise<void> {
  await ensureModel();
  const resampled = resampleStereo(request.left, request.right, request.sampleRate, TARGET_SAMPLE_RATE);
  scope.postMessage({
    type: 'job-start',
    assetId: request.assetId,
    frames: resampled.left.length,
    sampleRate: TARGET_SAMPLE_RATE,
  } satisfies Response);

  await separateScnetPcm(
    resampled.left,
    resampled.right,
    (chunk, done, total) => {
      const transfer: Transferable[] = [];
      for (const stem of Object.values(chunk.stems)) {
        transfer.push(stem.left.buffer, stem.right.buffer);
      }
      scope.postMessage({
        type: 'chunk',
        assetId: request.assetId,
        start: chunk.start,
        frames: chunk.frames,
        done,
        total,
        stems: chunk.stems,
      } satisfies Response, transfer);
    },
    (phase, chunk, total) => {
      scope.postMessage({
        type: 'phase', assetId: request.assetId, phase, chunk, total,
      } satisfies Response);
    },
  );
  scope.postMessage({ type: 'done', assetId: request.assetId } satisfies Response);
}

/** Linear resampling cukup di sini: model menerima waveform, bukan hasil final playback. */
function resampleStereo(
  left: Float32Array,
  right: Float32Array,
  fromRate: number,
  toRate: number,
): { readonly left: Float32Array; readonly right: Float32Array } {
  if (fromRate === toRate) return { left, right };
  if (!Number.isFinite(fromRate) || fromRate <= 0) throw new Error(`Sample rate tidak valid: ${fromRate}`);
  const frames = Math.max(1, Math.round(left.length * toRate / fromRate));
  const outLeft = new Float32Array(frames);
  const outRight = new Float32Array(frames);
  const ratio = fromRate / toRate;
  for (let i = 0; i < frames; i += 1) {
    const at = Math.min(left.length - 1, i * ratio);
    const lo = Math.floor(at);
    const hi = Math.min(left.length - 1, lo + 1);
    const mix = at - lo;
    outLeft[i] = left[lo]! + (left[hi]! - left[lo]!) * mix;
    outRight[i] = right[lo]! + (right[hi]! - right[lo]!) * mix;
  }
  return { left: outLeft, right: outRight };
}

function reportError(assetId: number | null, reason: unknown): void {
  scope.postMessage({
    type: 'error',
    assetId,
    message: reason instanceof Error ? reason.message : String(reason),
  } satisfies Response);
}
