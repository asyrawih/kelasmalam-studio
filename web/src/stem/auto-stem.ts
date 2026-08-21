import { useSyncExternalStore } from 'react';

import type { ScnetResult, ScnetStem } from '../proof-stem/scnet-separate';

const STORAGE_KEY = 'dawonweb.auto-stem.enabled.v1';
const STEMS: readonly ScnetStem[] = ['vocals', 'drums', 'bass', 'other'];

export type AutoStemModelState = 'off' | 'loading' | 'ready' | 'error';
export type AutoStemTrackState = 'queued' | 'processing' | 'ready' | 'error';
export type AutoStemMask = Readonly<Record<ScnetStem, boolean>>;
export const ALL_STEMS: AutoStemMask = { vocals: true, drums: true, bass: true, other: true };

export interface AutoStemTrackStatus {
  readonly assetId: number;
  readonly name: string;
  readonly state: AutoStemTrackState;
  readonly progress: number;
  readonly phase: 'waiting' | 'stft' | 'model' | 'istft' | 'complete';
  readonly error: string | null;
}

export interface AutoStemSnapshot {
  readonly enabled: boolean;
  readonly modelState: AutoStemModelState;
  readonly modelProgress: number;
  readonly activeAssetId: number | null;
  readonly queueLength: number;
  readonly readyCount: number;
  readonly error: string | null;
  readonly tracks: Readonly<Record<number, AutoStemTrackStatus>>;
  /** Mask playback per pemakai (`studio:<clipId>` / `dj:<deckId>`). */
  readonly masks: Readonly<Record<string, AutoStemMask>>;
}

export interface AutoStemAudio {
  readonly sampleRate: number;
  readonly frames: number;
  /** Ujung PCM kontinu yang sudah tersedia dari awal track. */
  readonly bufferedFrames: number;
  /** Naik sekali per chunk; pemutar memakai ini untuk mengambil isi terbaru. */
  readonly revision: number;
  readonly stems: Readonly<Record<ScnetStem, AudioBuffer>>;
}

interface PendingJob {
  readonly assetId: number;
  readonly name: string;
  readonly sampleRate: number;
  readonly left: Float32Array;
  readonly right: Float32Array;
}

type WorkerResponse =
  | { readonly type: 'model-progress'; readonly loaded: number; readonly total: number; readonly cacheHit: boolean }
  | { readonly type: 'ready'; readonly loadMs: number; readonly threads: number; readonly cacheHit: boolean }
  | { readonly type: 'job-start'; readonly assetId: number; readonly frames: number; readonly sampleRate: number }
  | {
      readonly type: 'chunk'; readonly assetId: number; readonly start: number; readonly frames: number;
      readonly done: number; readonly total: number; readonly stems: ScnetResult;
    }
  | {
      readonly type: 'phase'; readonly assetId: number; readonly phase: 'stft' | 'model' | 'istft';
      readonly chunk: number; readonly total: number;
    }
  | { readonly type: 'done'; readonly assetId: number }
  | { readonly type: 'error'; readonly assetId: number | null; readonly message: string };

const listeners = new Set<() => void>();
const queue: PendingJob[] = [];
const outputs = new Map<number, AutoStemAudio>();
let worker: Worker | null = null;
let modelReady = false;
let current: PendingJob | null = null;
let building: { readonly assetId: number; readonly audio: AutoStemAudio } | null = null;

let snapshot: AutoStemSnapshot = {
  enabled: readEnabled(),
  modelState: 'off',
  modelProgress: 0,
  activeAssetId: null,
  queueLength: 0,
  readyCount: 0,
  error: null,
  tracks: {},
  masks: {},
};

function readEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function publish(patch: Partial<AutoStemSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

function patchTrack(assetId: number, patch: Partial<AutoStemTrackStatus>): void {
  const existing = snapshot.tracks[assetId];
  if (existing === undefined) return;
  publish({ tracks: { ...snapshot.tracks, [assetId]: { ...existing, ...patch } } });
}

function ensureWorker(): void {
  if (worker !== null || !snapshot.enabled) return;
  if (typeof Worker === 'undefined') {
    publish({ modelState: 'error', error: 'Web Worker tidak tersedia di browser ini' });
    return;
  }
  publish({ modelState: 'loading', modelProgress: 0, error: null });
  worker = new Worker(new URL('./auto-stem.worker.ts', import.meta.url), { type: 'module' });
  worker.addEventListener('message', onWorkerMessage);
  worker.addEventListener('error', (event) => {
    failCurrent(event.message || 'Worker SCNet berhenti');
  });
  worker.postMessage({ type: 'init' });
}

function onWorkerMessage(event: MessageEvent<WorkerResponse>): void {
  const message = event.data;
  if (message.type === 'model-progress') {
    publish({
      modelState: 'loading',
      modelProgress: message.total > 0 ? Math.min(1, message.loaded / message.total) : 0,
    });
    return;
  }
  if (message.type === 'ready') {
    modelReady = true;
    publish({ modelState: 'ready', modelProgress: 1, error: null });
    pump();
    return;
  }
  if (message.type === 'job-start') {
    const stems = Object.fromEntries(STEMS.map((stem) => [
      stem,
      new AudioBuffer({ length: message.frames, numberOfChannels: 2, sampleRate: message.sampleRate }),
    ])) as Record<ScnetStem, AudioBuffer>;
    building = {
      assetId: message.assetId,
      audio: {
        sampleRate: message.sampleRate, frames: message.frames,
        bufferedFrames: 0, revision: 0, stems,
      },
    };
    patchTrack(message.assetId, { state: 'processing', phase: 'stft', progress: 0 });
    return;
  }
  if (message.type === 'phase') {
    patchTrack(message.assetId, {
      state: 'processing', phase: message.phase,
      progress: message.total > 0 ? Math.max(0, (message.chunk - 1) / message.total) : 0,
    });
    return;
  }
  if (message.type === 'chunk') {
    if (building?.assetId !== message.assetId) return;
    for (const stem of STEMS) {
      // ORT bertipe `ArrayBufferLike`; Web Audio menuntut view yang dipastikan
      // memakai `ArrayBuffer`, jadi salin view transfer ini secara eksplisit.
      building.audio.stems[stem].copyToChannel(new Float32Array(message.stems[stem].left), 0, message.start);
      building.audio.stems[stem].copyToChannel(new Float32Array(message.stems[stem].right), 1, message.start);
    }
    // Wrapper baru memaksa pemutar mengakuisisi ulang isi AudioBuffer. Web
    // Audio boleh menahan snapshot buffer yang sudah dijadwalkan; tanpa revisi
    // ini chunk ke-2 dst bisa sudah ada di memori tapi source tetap membaca nol.
    const progressive: AutoStemAudio = {
      ...building.audio,
      bufferedFrames: Math.max(building.audio.bufferedFrames, message.start + message.frames),
      revision: message.done,
    };
    building = { assetId: message.assetId, audio: progressive };
    // Chunk PERTAMA langsung membuat output playable. `ready` tetap berarti
    // SELURUH track selesai; availability dan completion sengaja dibedakan.
    outputs.set(message.assetId, progressive);
    patchTrack(message.assetId, {
      state: 'processing', progress: message.total > 0 ? message.done / message.total : 0,
    });
    return;
  }
  if (message.type === 'done') {
    if (building?.assetId === message.assetId) outputs.set(message.assetId, building.audio);
    building = null;
    current = null;
    patchTrack(message.assetId, { state: 'ready', phase: 'complete', progress: 1, error: null });
    publish({
      activeAssetId: null,
      queueLength: queue.length,
      readyCount: outputs.size,
    });
    pump();
    return;
  }
  failCurrent(message.message, message.assetId);
}

function failCurrent(message: string, assetId: number | null = current?.assetId ?? null): void {
  if (assetId !== null) patchTrack(assetId, { state: 'error', error: message });
  current = null;
  building = null;
  if (assetId === null) {
    publish({ modelState: 'error', error: message, activeAssetId: null });
  } else {
    publish({ error: message, activeAssetId: null, queueLength: queue.length });
    pump();
  }
}

function pump(): void {
  if (!snapshot.enabled || !modelReady || worker === null || current !== null) return;
  const next = queue.shift();
  if (next === undefined) {
    publish({ activeAssetId: null, queueLength: 0 });
    return;
  }
  current = next;
  patchTrack(next.assetId, { state: 'processing', progress: 0, phase: 'waiting', error: null });
  publish({ activeAssetId: next.assetId, queueLength: queue.length });
  worker.postMessage({
    type: 'separate', assetId: next.assetId, sampleRate: next.sampleRate,
    left: next.left, right: next.right,
  }, [next.left.buffer, next.right.buffer]);
}

export function setAutoStemEnabled(enabled: boolean): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // Toggle tetap bekerja untuk sesi ini walau storage ditolak.
  }
  if (enabled === snapshot.enabled) {
    if (enabled) ensureWorker();
    return;
  }
  publish({ enabled, error: null });
  if (enabled) {
    ensureWorker();
    return;
  }
  worker?.terminate();
  worker = null;
  modelReady = false;
  if (current !== null && snapshot.tracks[current.assetId]?.state !== 'ready') {
    outputs.delete(current.assetId);
  }
  current = null;
  building = null;
  queue.length = 0;
  const tracks = Object.fromEntries(
    Object.entries(snapshot.tracks).filter(([, status]) => status.state === 'ready'),
  );
  publish({
    modelState: 'off', modelProgress: 0, activeAssetId: null, queueLength: 0, tracks,
  });
}

/** Dipanggil oleh pipeline import bersama; kalau fitur OFF, biayanya nol. */
export function enqueueAutoStem(assetId: number, name: string, buffer: AudioBuffer): void {
  const previous = snapshot.tracks[assetId];
  if (!snapshot.enabled || previous?.state === 'queued' || previous?.state === 'processing' || previous?.state === 'ready') return;
  // Retry sesudah error tidak boleh memakai PCM parsial dari job sebelumnya.
  outputs.delete(assetId);
  const left = buffer.getChannelData(0).slice();
  const sourceRight = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : buffer.getChannelData(0);
  const right = sourceRight.slice();
  queue.push({ assetId, name, sampleRate: buffer.sampleRate, left, right });
  publish({
    queueLength: queue.length,
    tracks: {
      ...snapshot.tracks,
      [assetId]: { assetId, name, state: 'queued', progress: 0, phase: 'waiting', error: null },
    },
  });
  ensureWorker();
  pump();
}

export function removeAutoStem(assetId: number): void {
  outputs.delete(assetId);
  const index = queue.findIndex((job) => job.assetId === assetId);
  if (index >= 0) queue.splice(index, 1);
  if (current?.assetId === assetId) {
    // Worker tidak punya cancel per inference. Memutus worker adalah satu-
    // satunya cara memastikan asset yang sudah dihapus tidak muncul lagi.
    worker?.terminate();
    worker = null;
    modelReady = false;
    current = null;
    building = null;
  }
  const { [assetId]: _removed, ...tracks } = snapshot.tracks;
  publish({
    tracks, queueLength: queue.length, readyCount: outputs.size,
    activeAssetId: current?.assetId ?? null,
    ...(snapshot.enabled && worker === null ? { modelState: 'loading' as const, modelProgress: 0 } : null),
  });
  if (snapshot.enabled && worker === null) ensureWorker();
}

export function getAutoStemAudio(assetId: number): AutoStemAudio | undefined {
  return outputs.get(assetId);
}

export function hasPlayableAutoStem(assetId: number): boolean {
  return (outputs.get(assetId)?.bufferedFrames ?? 0) > 0;
}

export function getAutoStemMask(consumerId: string): AutoStemMask {
  return snapshot.masks[consumerId] ?? ALL_STEMS;
}

export function setAutoStemPart(consumerId: string, stem: ScnetStem, enabled: boolean): void {
  const before = getAutoStemMask(consumerId);
  if (before[stem] === enabled) return;
  const next = { ...before, [stem]: enabled };
  publish({ masks: { ...snapshot.masks, [consumerId]: next } });
}

export function resetAutoStemMask(consumerId: string): void {
  if (snapshot.masks[consumerId] === undefined) return;
  const { [consumerId]: _removed, ...masks } = snapshot.masks;
  publish({ masks });
}

export function isFullStemMask(mask: AutoStemMask): boolean {
  return STEMS.every((stem) => mask[stem]);
}

export function autoStemMaskKey(mask: AutoStemMask): string {
  return STEMS.map((stem) => mask[stem] ? '1' : '0').join('');
}

export function getAutoStemSnapshot(): AutoStemSnapshot {
  return snapshot;
}

export function subscribeAutoStem(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAutoStem(): AutoStemSnapshot {
  return useSyncExternalStore(subscribeAutoStem, getAutoStemSnapshot, getAutoStemSnapshot);
}

// Fitur yang tersimpan ON baru benar-benar memuat model ketika modul dipakai di browser.
if (snapshot.enabled) queueMicrotask(ensureWorker);
