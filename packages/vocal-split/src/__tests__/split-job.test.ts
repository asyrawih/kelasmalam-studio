/**
 * `runVocalSplit` di atas store studio NYATA; worker/klien dipalsukan lewat
 * `vi.mock('../split-client')` (tidak ada ORT/WASM di jsdom). Yang dijaga:
 * dua lane muncul tepat di bawah sumber dengan `start`/`len` sama, lane
 * sumber di-mute, tahap import berurutan model → separating → assembling →
 * selesai, PCM sumber diambil dari `sourceStart..sourceLen` (mono digandakan,
 * rate lain di-resample), dan tiap kondisi tepi docs/26 §3c: batal, clip
 * hilang saat job jalan, job kedua ditolak, galat tidak meninggalkan bar.
 *
 * Dua runtime (docs/26 P3b): host bawaan tes (web, tanpa `vocalSplit`) →
 * jalur worker; host palsu dengan `vocalSplit` (`setPlatformHostForTests`) →
 * jalur native, di mana worker TIDAK pernah dibuat dan `run` host menerima
 * PCM yang sama.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  setPlatformHostForTests,
  type PlatformHost,
  type ScnetModelDownloadProgress,
  type VocalSplitAccel,
  type VocalSplitHost,
  type VocalSplitInput,
  type VocalSplitOutput,
} from '@kelasmalam/platform';

import type { ImportStage } from '@kelasmalam/studio-core/assets/model';
import { assetActions, assetStore } from '@kelasmalam/studio-core/assets/store';
import { buildEnvelope } from '@kelasmalam/studio-core/timeline/envelope';
import { DEFAULT_FADE_CURVE, type StudioClip } from '@kelasmalam/studio/studio/model';
import { registerBuffer } from '@kelasmalam/studio/studio/preview/audio-preview';
import { studioActions, studioStore } from '@kelasmalam/studio/studio/store';

import type { VocalModelInfo } from '../mdx-model';
import type { SplitClient, SplitProgress, SplitResult, SplitSeparateOptions } from '../split-client';
import { cancelVocalSplit, runVocalSplit } from '../split-job';
import { __resetVocalSplitSessionForTest, vocalSplitSnapshot } from '../split-session';

const holder = vi.hoisted(() => ({ client: null as unknown }));

vi.mock('../split-client', () => ({
  createSplitClient: () => holder.client,
}));

const READY: VocalModelInfo = {
  loadMs: 1, inputs: ['input'], outputs: ['output'], threads: 2,
  modelId: 'kim-vocal-2', modelBytes: 66_759_214, cacheHit: true, executionProvider: 'wasm',
};

interface PendingSeparate {
  readonly left: Float32Array;
  readonly right: Float32Array;
  readonly options: SplitSeparateOptions;
  readonly onProgress: ((p: SplitProgress) => void) | undefined;
  readonly resolve: (r: SplitResult) => void;
  readonly reject: (reason: unknown) => void;
}

/** Klien palsu: `init` selesai seketika (dengan dua kabar progres), `separate` menunggu perintah tes. */
class FakeClient implements SplitClient {
  initCalls = 0;
  pending: PendingSeparate | null = null;
  disposed = false;

  init(_modelId: 'kim-vocal-2', onProgress?: (p: { loaded: number; total: number; cacheHit: boolean }) => void) {
    this.initCalls += 1;
    onProgress?.({ loaded: 5, total: 10, cacheHit: false });
    onProgress?.({ loaded: 10, total: 10, cacheHit: false });
    return Promise.resolve(READY);
  }

  separate(left: Float32Array, right: Float32Array, options: SplitSeparateOptions, onProgress?: (p: SplitProgress) => void, signal?: AbortSignal) {
    return new Promise<SplitResult>((resolve, reject) => {
      this.pending = { left, right, options, onProgress, resolve, reject };
      signal?.addEventListener('abort', () => reject(new DOMException('dibatalkan', 'AbortError')), { once: true });
    });
  }

  dispose(): void {
    this.disposed = true;
  }

  /** Tunggu sampai `separate` dipanggil. */
  async separateCalled(): Promise<PendingSeparate> {
    await vi.waitFor(() => expect(this.pending).not.toBeNull());
    return this.pending!;
  }

  /** Dua kabar progres lalu hasil: vokal = input × 0,5, instrumen = input × 0,25. */
  finish(): void {
    const p = this.pending!;
    p.onProgress?.({ done: 1, total: 2, segmentMs: 5 });
    p.onProgress?.({ done: 2, total: 2, segmentMs: 5 });
    const scale = (a: Float32Array, k: number): Float32Array => a.map((v) => v * k);
    p.resolve({
      vocals: { left: scale(p.left, 0.5), right: scale(p.right, 0.5) },
      instrumental: { left: scale(p.left, 0.25), right: scale(p.right, 0.25) },
      totalMs: 10,
      inferenceMs: 8,
    });
  }
}

interface PendingRun {
  readonly input: VocalSplitInput;
  readonly onProgress: (done: number, total: number) => void;
  readonly resolve: (r: VocalSplitOutput) => void;
  readonly reject: (reason: unknown) => void;
}

/** Host native palsu: `ensureModel` selesai seketika (cache hit), `run` menunggu perintah tes. */
class FakeNative implements VocalSplitHost {
  accelList: readonly VocalSplitAccel[] = ['cpu', 'coreml'];
  ensureCalls = 0;
  cancelled = 0;
  pending: PendingRun | null = null;

  accels(): Promise<readonly VocalSplitAccel[]> {
    return Promise.resolve(this.accelList);
  }

  ensureModel(_id: 'kim-vocal-2', onProgress: (p: ScnetModelDownloadProgress) => void): Promise<void> {
    this.ensureCalls += 1;
    onProgress({ loaded: 66_759_214, total: 66_759_214, cacheHit: true });
    return Promise.resolve();
  }

  run(input: VocalSplitInput, onProgress: (done: number, total: number) => void, signal?: AbortSignal): Promise<VocalSplitOutput> {
    return new Promise<VocalSplitOutput>((resolve, reject) => {
      this.pending = { input, onProgress, resolve, reject };
      signal?.addEventListener(
        'abort',
        () => {
          this.cancelled += 1;
          reject(new DOMException('dibatalkan', 'AbortError'));
        },
        { once: true },
      );
    });
  }

  async runCalled(): Promise<PendingRun> {
    await vi.waitFor(() => expect(this.pending).not.toBeNull());
    return this.pending!;
  }

  /** Dua kabar progres lalu hasil: vokal = input × 0,5, instrumen = input × 0,25. */
  finish(): void {
    const p = this.pending!;
    p.onProgress(1, 2);
    p.onProgress(2, 2);
    const scale = (a: Float32Array, k: number): Float32Array => a.map((v) => v * k);
    p.resolve({
      vocals: { left: scale(p.input.left, 0.5), right: scale(p.input.right, 0.5) },
      instrumental: { left: scale(p.input.left, 0.25), right: scale(p.input.right, 0.25) },
    });
  }
}

const webHost: PlatformHost = {
  kind: 'web',
  pickSaveTarget: async () => ({ kind: 'cancelled' }),
  openExternal: async () => {},
  authHeaders: async () => ({}),
};

/** `AudioBuffer` palsu — jsdom tidak punya; cukup untuk `buildEnvelope`, `set`, dan pembacaan kanal. */
class FakeAudioBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  private readonly channels: Float32Array[];

  constructor(opts: { numberOfChannels: number; length: number; sampleRate: number }) {
    this.numberOfChannels = opts.numberOfChannels;
    this.length = opts.length;
    this.sampleRate = opts.sampleRate;
    this.channels = Array.from({ length: opts.numberOfChannels }, () => new Float32Array(opts.length));
  }

  get duration(): number {
    return this.length / this.sampleRate;
  }

  getChannelData(i: number): Float32Array {
    return this.channels[i]!;
  }
}

const ASSET_ID = 501;
const FRAMES = 6000;

function sourceBuffer(channels: number, sampleRate: number): FakeAudioBuffer {
  const b = new FakeAudioBuffer({ numberOfChannels: channels, length: FRAMES, sampleRate });
  for (let c = 0; c < channels; c += 1) {
    const data = b.getChannelData(c);
    for (let i = 0; i < FRAMES; i += 1) data[i] = Math.sin(i / 30 + c) * 0.5;
  }
  return b;
}

/** Satu lane kosong + satu clip yang di-trim (`sourceStart` 500, 4000 frame). */
function setup(channels = 2, sampleRate = 44_100): { laneId: string; clip: StudioClip } {
  studioActions.__resetForTest('empty');
  // Rate proyek = rate buffer sumber, seperti hasil import (decode di rate
  // proyek). Seed tes memakai rate lain, dan tanpa ini jalur resample-balik
  // ikut terpanggil di tes yang tidak memasang `OfflineAudioContext`.
  studioActions.hydrate({ sampleRate });
  const buffer = sourceBuffer(channels, sampleRate) as unknown as AudioBuffer;
  assetActions.registerAsset({
    id: ASSET_ID,
    name: 'lagu',
    contentHash: 'abc',
    envelope: buildEnvelope(buffer),
    frames: FRAMES,
    sampleRate,
    tempo: null,
    tempoPending: false,
    tempoOctave: 0,
    bpmOverride: null,
    beatOffsetOverride: null,
    analysisLock: false,
  });
  registerBuffer(ASSET_ID, buffer);
  const laneId = studioStore.getState().lanes[0]!.id;
  const clip: StudioClip = {
    id: studioActions.newClipId(),
    assetId: ASSET_ID,
    chain: [],
    start: 1000,
    len: 4000,
    sourceStart: 500,
    sourceLen: 4000,
    label: 'LAGU',
    gainDb: 0,
    fadeInMs: 0,
    fadeOutMs: 0,
    fadeCurve: DEFAULT_FADE_CURVE,
    seed: 1,
  };
  studioActions.addClip(laneId, clip);
  return { laneId, clip };
}

/** Rekam urutan tahap job di lane sumber; `'end'` saat barnya hilang. */
function recordStages(laneId: string): (ImportStage | 'end')[] {
  const stages: (ImportStage | 'end')[] = [];
  let seen = false;
  studioStore.subscribe(() => {
    const job = studioStore.getState().importJobs.find((j) => j.laneId === laneId);
    if (job !== undefined) {
      seen = true;
      if (stages[stages.length - 1] !== job.stage) stages.push(job.stage);
    } else if (seen && stages[stages.length - 1] !== 'end') {
      stages.push('end');
    }
  });
  return stages;
}

let client: FakeClient;

beforeEach(() => {
  client = new FakeClient();
  holder.client = client;
  vi.stubGlobal('AudioBuffer', FakeAudioBuffer);
  __resetVocalSplitSessionForTest();
});

afterEach(() => {
  vi.unstubAllGlobals();
  setPlatformHostForTests(null);
  __resetVocalSplitSessionForTest();
});

describe('runVocalSplit · jalur sukses', () => {
  it('dua lane di bawah sumber, start/len sama, sumber di-mute, tahap berurutan, asset baru terdaftar', async () => {
    const { laneId, clip } = setup();
    const stages = recordStages(laneId);
    const job = runVocalSplit({ clipId: clip.id, modelId: 'kim-vocal-2', overlap: 0.25, denoise: false, muteSource: true, maxThreads: 2 });

    const pending = await client.separateCalled();
    // Region yang diproses: `sourceStart..sourceLen`, bukan asset utuh.
    expect(pending.left.length).toBe(4000);
    expect(pending.right.length).toBe(4000);
    const src = sourceBuffer(2, 44_100);
    expect(pending.left[0]).toBeCloseTo(src.getChannelData(0)[500]!);
    expect(pending.right[0]).toBeCloseTo(src.getChannelData(1)[500]!);
    expect(pending.options).toMatchObject({ overlap: 0.25, denoise: false });
    expect(vocalSplitSnapshot().job?.clipId).toBe(clip.id);
    expect(studioStore.getState().importJobs.find((j) => j.laneId === laneId)).toMatchObject({ name: 'LAGU', stage: 'separating' });

    client.finish();
    const outcome = await job;
    expect('laneIds' in outcome).toBe(true);
    if (!('laneIds' in outcome)) throw new Error('bukan sukses');
    expect(outcome.laneIds).toHaveLength(2);

    const lanes = studioStore.getState().lanes;
    expect(lanes.map((l) => l.name)).toEqual(['FIRST', 'LAGU · VOCALS', 'LAGU · INST']);
    expect(lanes[0]!.mute).toBe(true);
    expect(lanes[1]!.id).toBe(outcome.laneIds[0]);
    expect(lanes[2]!.id).toBe(outcome.laneIds[1]);
    for (const lane of lanes.slice(1)) {
      expect(lane.clips).toHaveLength(1);
      const c = lane.clips[0]!;
      expect(c.start).toBe(1000);
      expect(c.len).toBe(4000);
      expect(c.sourceStart).toBe(0);
      expect(c.sourceLen).toBe(4000);
      expect(c.chain).toEqual([]);
      expect(c.gainDb).toBe(0);
      expect(c.fadeInMs).toBe(0);
      expect(c.assetId).not.toBe(ASSET_ID);
    }
    const assets = assetStore.getState().assets;
    expect(assets[lanes[1]!.clips[0]!.assetId]).toMatchObject({ name: 'LAGU · VOCALS', contentHash: '', frames: 4000 });
    expect(assets[lanes[2]!.clips[0]!.assetId]).toMatchObject({ name: 'LAGU · INST', contentHash: '', frames: 4000 });

    expect(stages).toEqual(['reading', 'model', 'separating', 'assembling', 'end']);
    expect(studioStore.getState().importJobs).toEqual([]);
    expect(vocalSplitSnapshot().job).toBeNull();
    expect(client.initCalls).toBe(1);
  });

  it('muteSource: false → lane sumber tetap berbunyi; satu langkah undo mengembalikan kedua lane', async () => {
    const { clip } = setup();
    const job = runVocalSplit({ clipId: clip.id, modelId: 'kim-vocal-2', overlap: 0.5, denoise: true, muteSource: false });
    await client.separateCalled();
    client.finish();
    await job;
    expect(studioStore.getState().lanes).toHaveLength(3);
    expect(studioStore.getState().lanes[0]!.mute).toBe(false);
    studioActions.undo();
    expect(studioStore.getState().lanes).toHaveLength(1);
  });

  it('sumber mono → kanan = kiri sebelum masuk model', async () => {
    const { clip } = setup(1);
    const job = runVocalSplit({ clipId: clip.id, modelId: 'kim-vocal-2', overlap: 0.25, denoise: false, muteSource: true });
    const pending = await client.separateCalled();
    expect(Array.from(pending.right)).toEqual(Array.from(pending.left));
    client.finish();
    await job;
  });

  it('job kedua memakai sesi yang sama (init tidak diulang)', async () => {
    const { clip } = setup();
    const first = runVocalSplit({ clipId: clip.id, modelId: 'kim-vocal-2', overlap: 0.25, denoise: false, muteSource: false });
    await client.separateCalled();
    client.finish();
    await first;
    client.pending = null;
    const second = runVocalSplit({ clipId: clip.id, modelId: 'kim-vocal-2', overlap: 0.25, denoise: false, muteSource: false });
    await client.separateCalled();
    client.finish();
    await second;
    expect(client.initCalls).toBe(1);
    expect(studioStore.getState().lanes).toHaveLength(5);
  });
});

describe('runVocalSplit · sample rate ≠ 44,1 kHz', () => {
  it('resample ke 44,1 kHz untuk model, hasil kembali ke rate proyek', async () => {
    const created: { channels: number; length: number; sampleRate: number }[] = [];
    class FakeOffline {
      destination = {};
      constructor(readonly channels: number, readonly length: number, readonly sampleRate: number) {
        created.push({ channels, length, sampleRate });
      }
      createBufferSource() {
        return { buffer: null as unknown, connect: (n: unknown) => n, start: vi.fn() };
      }
      startRendering() {
        const out = new FakeAudioBuffer({ numberOfChannels: 2, length: this.length, sampleRate: this.sampleRate });
        out.getChannelData(0).fill(0.3);
        out.getChannelData(1).fill(0.3);
        return Promise.resolve(out);
      }
    }
    vi.stubGlobal('OfflineAudioContext', FakeOffline);

    const { clip } = setup(2, 48_000);
    studioStore.getState();
    const job = runVocalSplit({ clipId: clip.id, modelId: 'kim-vocal-2', overlap: 0.25, denoise: false, muteSource: true });
    const pending = await client.separateCalled();
    // 4000 frame @48k → 3675 frame @44,1k.
    expect(created[0]).toEqual({ channels: 2, length: 3675, sampleRate: 44_100 });
    expect(pending.left.length).toBe(3675);
    client.finish();
    const outcome = await job;
    if (!('laneIds' in outcome)) throw new Error('bukan sukses');
    // Dua render balik (vokal, instrumen) ke rate proyek.
    const projectRate = studioStore.getState().sampleRate;
    expect(created.slice(1)).toEqual([
      { channels: 2, length: Math.round((3675 * projectRate) / 44_100), sampleRate: projectRate },
      { channels: 2, length: Math.round((3675 * projectRate) / 44_100), sampleRate: projectRate },
    ]);
    const lanes = studioStore.getState().lanes;
    expect(lanes[1]!.clips[0]!.sourceLen).toBe(Math.round((3675 * projectRate) / 44_100));
    expect(lanes[1]!.clips[0]!.len).toBe(4000);
  });
});

describe('runVocalSplit · kondisi tepi (docs/26 §3c)', () => {
  it('batal saat inferensi → {cancelled}, tidak ada lane, bar hilang, sumber tidak di-mute', async () => {
    const { laneId, clip } = setup();
    const stages = recordStages(laneId);
    const job = runVocalSplit({ clipId: clip.id, modelId: 'kim-vocal-2', overlap: 0.25, denoise: false, muteSource: true });
    await client.separateCalled();
    expect(cancelVocalSplit()).toBe(true);
    await expect(job).resolves.toEqual({ cancelled: true });
    expect(studioStore.getState().lanes).toHaveLength(1);
    expect(studioStore.getState().lanes[0]!.mute).toBe(false);
    expect(studioStore.getState().importJobs).toEqual([]);
    expect(stages[stages.length - 1]).toBe('end');
    expect(vocalSplitSnapshot().job).toBeNull();
    // Tidak ada job → tidak ada yang dibatalkan.
    expect(cancelVocalSplit()).toBe(false);
  });

  it('cancelVocalSplit dengan id lain → tidak membatalkan job yang jalan', async () => {
    const { clip } = setup();
    const job = runVocalSplit({ clipId: clip.id, modelId: 'kim-vocal-2', overlap: 0.25, denoise: false, muteSource: true });
    await client.separateCalled();
    expect(cancelVocalSplit('bukan-id')).toBe(false);
    client.finish();
    const outcome = await job;
    expect('laneIds' in outcome).toBe(true);
  });

  it('clip dihapus saat job jalan → hasil dibuang, {cancelled}', async () => {
    const { clip } = setup();
    const job = runVocalSplit({ clipId: clip.id, modelId: 'kim-vocal-2', overlap: 0.25, denoise: false, muteSource: true });
    await client.separateCalled();
    studioActions.removeClip(clip.id);
    client.finish();
    await expect(job).resolves.toEqual({ cancelled: true });
    expect(studioStore.getState().lanes).toHaveLength(1);
    expect(studioStore.getState().lanes[0]!.clips).toHaveLength(0);
    expect(studioStore.getState().importJobs).toEqual([]);
  });

  it('proyek diganti (hydrate) saat job jalan → {cancelled}, proyek baru tidak disentuh', async () => {
    const { clip } = setup();
    const job = runVocalSplit({ clipId: clip.id, modelId: 'kim-vocal-2', overlap: 0.25, denoise: false, muteSource: true });
    await client.separateCalled();
    // Proyek "lain" yang kebetulan masih memuat clip dengan id yang sama —
    // yang membedakannya adalah `importJobs` yang dikosongkan `hydrate`.
    studioActions.hydrate({ ...studioStore.getState(), projectName: 'LAIN' });
    client.finish();
    await expect(job).resolves.toEqual({ cancelled: true });
    expect(studioStore.getState().lanes).toHaveLength(1);
  });

  it('job kedua saat pertama masih jalan → ditolak dengan pesan jelas', async () => {
    const { clip } = setup();
    const first = runVocalSplit({ clipId: clip.id, modelId: 'kim-vocal-2', overlap: 0.25, denoise: false, muteSource: true });
    await client.separateCalled();
    await expect(runVocalSplit({ clipId: clip.id, modelId: 'kim-vocal-2', overlap: 0.25, denoise: false, muteSource: true }))
      .rejects.toThrow(/masih berjalan/);
    client.finish();
    await first;
    expect(studioStore.getState().lanes).toHaveLength(3);
  });

  it('galat dari worker → dilempar, bar hilang, tidak ada lane', async () => {
    const { clip } = setup();
    const job = runVocalSplit({ clipId: clip.id, modelId: 'kim-vocal-2', overlap: 0.25, denoise: false, muteSource: true });
    const pending = await client.separateCalled();
    pending.reject(new Error('shape mismatch'));
    await expect(job).rejects.toThrow('shape mismatch');
    expect(studioStore.getState().lanes).toHaveLength(1);
    expect(studioStore.getState().importJobs).toEqual([]);
    expect(vocalSplitSnapshot().job).toBeNull();
  });

  it('clip tanpa audio / clip tidak ada → ditolak sebelum job dimulai', async () => {
    const { laneId, clip } = setup();
    await expect(runVocalSplit({ clipId: 'tidak-ada', modelId: 'kim-vocal-2', overlap: 0.25, denoise: false, muteSource: true }))
      .rejects.toThrow('clip tidak ditemukan');
    studioActions.updateClip(clip.id, { assetId: 777 });
    await expect(runVocalSplit({ clipId: clip.id, modelId: 'kim-vocal-2', overlap: 0.25, denoise: false, muteSource: true }))
      .rejects.toThrow(/belum punya audio/);
    expect(studioStore.getState().importJobs.filter((j) => j.laneId === laneId)).toEqual([]);
    expect(client.initCalls).toBe(0);
  });
});

describe('runVocalSplit · host dengan vocalSplit (native, docs/26 P3b)', () => {
  let native: FakeNative;

  beforeEach(() => {
    native = new FakeNative();
    setPlatformHostForTests({ ...webHost, vocalSplit: native });
  });

  it('run host dipanggil dengan PCM region 44,1 kHz + opsi; worker tidak dibuat; dua lane seperti jalur worker', async () => {
    const { laneId, clip } = setup();
    const stages = recordStages(laneId);
    const job = runVocalSplit({ clipId: clip.id, modelId: 'kim-vocal-2', overlap: 0.5, denoise: true, muteSource: true, maxThreads: 3 });

    const pending = await native.runCalled();
    expect(pending.input.left.length).toBe(4000);
    expect(pending.input.right.length).toBe(4000);
    const src = sourceBuffer(2, 44_100);
    expect(pending.input.left[0]).toBeCloseTo(src.getChannelData(0)[500]!);
    expect(pending.input.right[0]).toBeCloseTo(src.getChannelData(1)[500]!);
    // Default akselerasi = coreml kalau host menawarkannya; thread tidak ikut.
    expect(pending.input).toMatchObject({ sampleRate: 44_100, modelId: 'kim-vocal-2', overlap: 0.5, denoise: true, accel: 'coreml' });
    expect(pending.input.threads).toBeUndefined();
    expect(native.ensureCalls).toBe(1);
    expect(client.initCalls).toBe(0);
    expect(vocalSplitSnapshot()).toMatchObject({ runtime: 'native', accels: ['cpu', 'coreml'], accel: 'coreml' });
    expect(vocalSplitSnapshot().model).toMatchObject({ kind: 'ready', info: { runtime: 'native', cacheHit: true } });
    expect(studioStore.getState().importJobs.find((j) => j.laneId === laneId)).toMatchObject({ stage: 'separating' });

    native.finish();
    const outcome = await job;
    if (!('laneIds' in outcome)) throw new Error('bukan sukses');
    const lanes = studioStore.getState().lanes;
    expect(lanes.map((l) => l.name)).toEqual(['FIRST', 'LAGU · VOCALS', 'LAGU · INST']);
    expect(lanes[0]!.mute).toBe(true);
    for (const lane of lanes.slice(1)) {
      const c = lane.clips[0]!;
      expect(c.start).toBe(1000);
      expect(c.len).toBe(4000);
      expect(c.sourceLen).toBe(4000);
    }
    expect(stages).toEqual(['reading', 'model', 'separating', 'assembling', 'end']);
    expect(studioStore.getState().importJobs).toEqual([]);
    expect(vocalSplitSnapshot().job).toBeNull();
  });

  it('accel cpu (dari params) membawa maxThreads; host tanpa coreml → default cpu', async () => {
    const { clip } = setup();
    const first = runVocalSplit({ clipId: clip.id, modelId: 'kim-vocal-2', overlap: 0.25, denoise: false, muteSource: false, maxThreads: 3, accel: 'cpu' });
    const a = await native.runCalled();
    expect(a.input).toMatchObject({ accel: 'cpu', threads: 3 });
    native.finish();
    await first;

    __resetVocalSplitSessionForTest();
    native = new FakeNative();
    native.accelList = ['cpu'];
    setPlatformHostForTests({ ...webHost, vocalSplit: native });
    const second = runVocalSplit({ clipId: clip.id, modelId: 'kim-vocal-2', overlap: 0.25, denoise: false, muteSource: false, maxThreads: 2 });
    const b = await native.runCalled();
    expect(b.input).toMatchObject({ accel: 'cpu', threads: 2 });
    expect(vocalSplitSnapshot()).toMatchObject({ accels: ['cpu'], accel: 'cpu' });
    native.finish();
    await second;
  });

  it('job kedua tidak mengunduh ulang: ensureModel host sekali', async () => {
    const { clip } = setup();
    const first = runVocalSplit({ clipId: clip.id, modelId: 'kim-vocal-2', overlap: 0.25, denoise: false, muteSource: false });
    await native.runCalled();
    native.finish();
    await first;
    native.pending = null;
    const second = runVocalSplit({ clipId: clip.id, modelId: 'kim-vocal-2', overlap: 0.25, denoise: false, muteSource: false });
    await native.runCalled();
    native.finish();
    await second;
    expect(native.ensureCalls).toBe(1);
    expect(studioStore.getState().lanes).toHaveLength(5);
  });

  it('batal → signal host di-abort, {cancelled}, tidak ada lane, bar hilang', async () => {
    const { laneId, clip } = setup();
    const stages = recordStages(laneId);
    const job = runVocalSplit({ clipId: clip.id, modelId: 'kim-vocal-2', overlap: 0.25, denoise: false, muteSource: true });
    await native.runCalled();
    expect(cancelVocalSplit()).toBe(true);
    await expect(job).resolves.toEqual({ cancelled: true });
    expect(native.cancelled).toBe(1);
    expect(studioStore.getState().lanes).toHaveLength(1);
    expect(studioStore.getState().lanes[0]!.mute).toBe(false);
    expect(studioStore.getState().importJobs).toEqual([]);
    expect(stages[stages.length - 1]).toBe('end');
    expect(vocalSplitSnapshot().job).toBeNull();
  });

  it('galat host (mis. MODEL_MISSING) → dilempar, bar hilang, tidak ada lane', async () => {
    const { clip } = setup();
    const job = runVocalSplit({ clipId: clip.id, modelId: 'kim-vocal-2', overlap: 0.25, denoise: false, muteSource: true });
    const pending = await native.runCalled();
    pending.reject(Object.assign(new Error('Kim_Vocal_2.onnx belum diunduh'), { code: 'MODEL_MISSING' }));
    await expect(job).rejects.toThrow('belum diunduh');
    expect(studioStore.getState().lanes).toHaveLength(1);
    expect(studioStore.getState().importJobs).toEqual([]);
    expect(vocalSplitSnapshot().job).toBeNull();
  });

  it('ensureModel host gagal → job gagal di tahap model, status model = error', async () => {
    native.ensureModel = () => Promise.reject(new Error('HTTP 500'));
    const { clip } = setup();
    await expect(runVocalSplit({ clipId: clip.id, modelId: 'kim-vocal-2', overlap: 0.25, denoise: false, muteSource: true }))
      .rejects.toThrow('HTTP 500');
    expect(native.pending).toBeNull();
    expect(vocalSplitSnapshot().model).toEqual({ kind: 'error', message: 'HTTP 500' });
    expect(studioStore.getState().importJobs).toEqual([]);
  });
});
