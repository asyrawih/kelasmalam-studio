/**
 * Protokol pesan `split.worker.ts` ⇄ `split-client.ts` (docs/26 §5).
 *
 * Hidup di modul sendiri (hanya tipe) supaya client tidak perlu mengimpor
 * modul worker — modul itu memasang `self.onmessage` begitu dimuat — dan
 * supaya kedua sisi tidak bisa diam-diam berbeda bentuk pesannya.
 */

import type { MdxOverlap, StereoPcm } from './mdx-separate';
import type { VocalExecutionProvider, VocalModelInfo } from './mdx-model';
import type { VocalModelId } from './catalog';

export type SplitRequest =
  /** `bytes` hanya dari host yang punya `modelBytes` (lihat `prefetchVocalModelBytes`); web membiarkannya kosong. */
  | {
      readonly type: 'init';
      readonly modelId: VocalModelId;
      readonly bytes?: Uint8Array;
      readonly maxThreads?: number;
      readonly executionProvider?: VocalExecutionProvider;
    }
  | {
      readonly type: 'separate';
      readonly left: Float32Array;
      readonly right: Float32Array;
      readonly overlap: MdxOverlap;
      readonly denoise: boolean;
      readonly compensate?: boolean;
    }
  | { readonly type: 'cancel' };

export interface SplitProgress {
  readonly done: number;
  readonly total: number;
  /** Waktu satu segmen terakhir (STFT + model + iSTFT + jahit), ms. */
  readonly segmentMs: number;
}

export interface SplitResult {
  readonly vocals: StereoPcm;
  readonly instrumental: StereoPcm;
  /** Seluruh `separate`, ms. */
  readonly totalMs: number;
  /** Hanya waktu di dalam `session.run`, ms — angka yang dibandingkan antar-EP di benchmark P1. */
  readonly inferenceMs: number;
}

export type SplitResponse =
  | ({ readonly type: 'ready' } & VocalModelInfo)
  | { readonly type: 'model-progress'; readonly loaded: number; readonly total: number; readonly cacheHit: boolean }
  | ({ readonly type: 'progress' } & SplitProgress)
  | ({ readonly type: 'done' } & SplitResult)
  | { readonly type: 'cancelled' }
  | { readonly type: 'error'; readonly message: string };
