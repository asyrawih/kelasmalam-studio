/**
 * Orkestrasi job vocal split di main thread (docs/26 §3, §5):
 * clip → PCM sumber → worker MDX → dua asset baru → dua lane baru di bawah
 * lane sumber, satu langkah undo (`insertLanesBelow`).
 *
 * Polanya meniru `studio/timeline/stem-bake.ts` untuk bagian yang sama
 * (buffer dari `getBuffer`, asset lewat `assetFromBuffer` + `registerAsset` +
 * `registerBuffer`, `contentHash` kosong karena tidak punya berkas asal) —
 * tidak ada jalur asset kedua. Yang berbeda hanya dari mana PCM hasilnya
 * datang: worker ORT atau host native, bukan `OfflineAudioContext` + rantai
 * stem.
 *
 * Dua runtime (docs/26 P3b), dipilih oleh KONTRAK host lewat `split-session`:
 * host dengan `vocalSplit` → PCM 44,1 kHz dikirim ke `vocalSplit.run` (Rust),
 * hasilnya kembali sebagai PCM; tanpa itu → `SplitClient.separate` di worker.
 * Segala sesuatu sebelum (PCM sumber, resample) dan sesudah (asset, lane,
 * verifikasi, undo) SAMA untuk keduanya — hanya langkah 3 yang bercabang.
 *
 * Kondisi tepi §3c yang ditangani di sini:
 *   - clip di-trim/loop: yang diproses `sourceStart..sourceLen`, bukan asset utuh;
 *   - mono → digandakan ke stereo (model menuntut 2 kanal);
 *   - sample rate ≠ 44,1 kHz → resample ke 44,1 kHz untuk model lewat
 *     `OfflineAudioContext`, hasil dikembalikan ke rate proyek;
 *   - clip/lane hilang atau proyek diganti saat job jalan → hasil DIBUANG,
 *     dikembalikan `{cancelled: true}` — bukan lane baru di proyek yang salah;
 *   - batal (`cancelVocalSplit`) → tidak ada lane setengah jadi;
 *   - dua job sekaligus → yang kedua DITOLAK dengan pesan jelas (thread WASM
 *     satu pool; antrean diam-diam lebih membingungkan daripada penolakan).
 *
 * Progres tampil di lane sumber lewat `ImportJob` (`LaneImportOverlay`):
 * tahap `model` selama `init`, `separating` per segmen, `assembling` saat
 * asset dan lane dibuat. `endImport` SELALU dipanggil di `finally` — bar yang
 * tidak pernah hilang tidak bisa dibedakan dari aplikasi yang menggantung.
 *
 * Jejak di konsol (`[vocal-split]`, `console.info`) di tiap tahap: runtime
 * yang dipilih, jumlah frame, lama tiap tahap, lane hasil, atau ALASAN batal.
 * Ada tujuh jalur `{cancelled: true}` dan tanpa jejak semuanya tampak sama
 * dari luar — "hasil split tidak masuk" tanpa pesan. Galat job juga dicatat
 * ke sesi (`lastError`) supaya dialog/tombol bisa menampilkannya setelah
 * dialognya sendiri sudah tertutup; hasil sukses/batal ke `lastOutcome`.
 */

import { assetActions } from '@kelasmalam/studio-core/assets/store';
import { assetFromBuffer } from '@kelasmalam/studio-core/timeline/audio-import';
import { DEFAULT_FADE_CURVE, STEM_BYPASS, findClip, type StudioClip } from '@kelasmalam/studio/studio/model';
import { getBuffer, registerBuffer } from '@kelasmalam/studio/studio/preview/audio-preview';
import { studioActions, studioStore } from '@kelasmalam/studio/studio/store';

import type { VocalModelId } from './catalog';
import type { VocalExecutionProvider } from './mdx-model';
import type { StereoPcm } from './mdx-separate';
import {
  ensureVocalModel,
  fallbackVocalSplitToWasm,
  markVocalSplitJob,
  nativeVocalSplitHost,
  probeVocalSplitRuntime,
  readyVocalSplitClient,
  setVocalSplitError,
  setVocalSplitOutcome,
  vocalSplitErrorMessage,
  vocalSplitSessionExecutionProvider,
  vocalSplitSnapshot,
  type VocalSplitAccel,
  type VocalSplitCancelReason,
} from './split-session';

/** Kim_Vocal_2 dilatih di 44,1 kHz; segmen dan STFT-nya dihitung di rate ini. */
export const MODEL_SAMPLE_RATE = 44_100;

export interface VocalSplitParams {
  readonly clipId: string;
  readonly modelId: VocalModelId;
  /** 0 dibuang di v1 (docs/26 §1 temuan P0). */
  readonly overlap: 0.25 | 0.5;
  readonly denoise: boolean;
  readonly muteSource: boolean;
  /** Batas thread: worker WASM, atau `cpu` native. Diabaikan `coreml`. */
  readonly maxThreads?: number;
  /** Hanya runtime native. Default = pilihan sesi (`vocalSplitSnapshot().accel`). */
  readonly accel?: VocalSplitAccel;
}

/**
 * Hasil job; `reason` menyebut jalur batal yang mana (docs/26 §3c) — juga
 * masuk `lastOutcome` sesi. Sukses membawa waktu pemisahan (`totalMs` seluruh
 * langkah 3, `inferenceMs` hanya di dalam ORT — null di native, `segments`)
 * supaya dialog bisa menampilkan ms/segmen untuk membandingkan WASM vs WebGPU.
 */
export type VocalSplitOutcome =
  | {
      readonly laneIds: readonly string[];
      readonly totalMs: number;
      readonly inferenceMs: number | null;
      readonly segments: number;
    }
  | { readonly cancelled: true; readonly reason: VocalSplitCancelReason };

export interface VocalSplitDeps {
  /** Paksa EP jalur worker (benchmark P1); tanpa ini dipakai `wasmAccel` sesi. */
  readonly executionProvider?: VocalExecutionProvider;
}

interface ActiveJob {
  readonly id: string;
  readonly controller: AbortController;
}

let active: ActiveJob | null = null;

/** Id job yang sedang berjalan, atau null. */
export function activeVocalSplitJobId(): string | null {
  return active?.id ?? null;
}

/**
 * Batalkan job yang sedang berjalan. Tanpa `jobId` = job apa pun yang aktif.
 * @returns true kalau ada job yang dibatalkan.
 */
export function cancelVocalSplit(jobId?: string): boolean {
  if (active === null) return false;
  if (jobId !== undefined && active.id !== jobId) return false;
  active.controller.abort();
  return true;
}

function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}

const TAG = '[vocal-split]';

const ms = (since: number): string => `${Math.round(performance.now() - since)} ms`;

export async function runVocalSplit(params: VocalSplitParams, deps: VocalSplitDeps = {}): Promise<VocalSplitOutcome> {
  if (active !== null) {
    // Penolakan panggilan, bukan kegagalan job: `lastError` milik job yang
    // sedang berjalan tidak boleh tertimpa.
    throw new Error('Vocal split masih berjalan — tunggu sampai selesai atau hentikan dulu; inferensinya satu pool');
  }
  // Job baru mulai bersih; galat job sebelumnya sudah bukan galat job ini.
  setVocalSplitError(null);
  setVocalSplitOutcome(null);
  const started = performance.now();
  let stage = 'persiapan';
  try {
    const outcome = await runJob(params, deps, started, (s) => {
      stage = s;
    });
    setVocalSplitOutcome(outcome);
    return outcome;
  } catch (err: unknown) {
    const message = vocalSplitErrorMessage(err);
    setVocalSplitError(message);
    console.warn(`${TAG} job gagal di tahap ${stage} setelah ${ms(started)}: ${message}`);
    throw err;
  }
}

/** Alasan batal: `signal` selalu disertai tahap saat sinyalnya terbaca. */
function cancelled(reason: VocalSplitCancelReason, started: number, at?: string): VocalSplitOutcome {
  console.info(`${TAG} dibatalkan (${reason}${at === undefined ? '' : `, ${at}`}) setelah ${ms(started)}`);
  return { cancelled: true, reason };
}

async function runJob(
  params: VocalSplitParams,
  deps: VocalSplitDeps,
  started: number,
  setStage: (stage: string) => void,
): Promise<VocalSplitOutcome> {
  const state = studioStore.getState();
  const hit = findClip(state.lanes, params.clipId);
  if (hit === null) throw new Error('clip tidak ditemukan');
  const { clip, lane } = hit;
  const buffer = getBuffer(clip.assetId);
  if (buffer === undefined) throw new Error('clip ini belum punya audio');
  const projectRate = state.sampleRate;

  const controller = new AbortController();
  const { signal } = controller;
  const jobId = studioActions.newImportId();
  active = { id: jobId, controller };
  markVocalSplitJob({ id: jobId, clipId: clip.id, laneId: lane.id });
  studioActions.beginImport({ id: jobId, laneId: lane.id, name: clip.label });
  studioActions.setImportStage(jobId, 'model', null);
  const frames = Math.max(1, Math.min(clip.sourceLen, buffer.length - clip.sourceStart));
  console.info(
    `${TAG} job ${jobId} mulai: clip "${clip.label}" (${clip.id}) ${frames} frame @${buffer.sampleRate} Hz` +
      ` (${buffer.numberOfChannels} kanal, proyek ${projectRate} Hz), model ${params.modelId},` +
      ` overlap ${params.overlap}, denoise ${params.denoise}, thread ${params.maxThreads ?? '-'}`,
  );

  try {
    // ── 1. Model ────────────────────────────────────────────────────────
    // Native: tahap ini hanya unduhan (`ensureModel`); worker: unduh + sesi ORT.
    setStage('model');
    let t = performance.now();
    // Probe dulu (di-cache): bawaan `wasmAccel` (webgpu kalau adapter ada)
    // dan `accel` native baru terisi setelahnya, dan `ensureVocalModel`
    // membaca yang pertama sebagai EP.
    await probeVocalSplitRuntime();
    if (signal.aborted) return cancelled('signal', started, 'setelah probe runtime');
    await ensureVocalModel(
      params.modelId,
      { maxThreads: params.maxThreads, executionProvider: deps.executionProvider },
      (p) => studioActions.setImportStage(jobId, 'model', p.total > 0 ? Math.min(1, p.loaded / p.total) : null),
    );
    if (signal.aborted) return cancelled('signal', started, 'setelah model siap');
    const { separate, runtime } = await pickSeparator(params);
    console.info(`${TAG} model siap dalam ${ms(t)}; runtime ${runtime}`);
    if (signal.aborted) return cancelled('signal', started, 'setelah runtime dipilih');

    // ── 2. PCM sumber → stereo 44,1 kHz ─────────────────────────────────
    setStage('pcm-sumber');
    t = performance.now();
    const input = await sourceRegionForModel(buffer, clip.sourceStart, frames);
    console.info(`${TAG} PCM sumber siap: ${input.left.length} frame @${MODEL_SAMPLE_RATE} Hz dalam ${ms(t)}`);
    if (signal.aborted) return cancelled('signal', started, 'setelah PCM sumber');

    // ── 3. Pisahkan (worker atau native) ────────────────────────────────
    setStage('separating');
    studioActions.setImportStage(jobId, 'separating', 0);
    t = performance.now();
    let result: SeparationResult;
    let segments = 0;
    try {
      result = await separate(
        input,
        (done, total) => {
          segments = total;
          studioActions.setImportStage(jobId, 'separating', total > 0 ? done / total : null);
        },
        signal,
      );
    } catch (err: unknown) {
      if (isAbortError(err)) return cancelled('signal', started, 'saat inferensi');
      throw err;
    }
    const perSegment = segments > 0 ? ` (${Math.round(result.totalMs / segments)} ms/segmen × ${segments})` : '';
    console.info(`${TAG} pemisahan selesai dalam ${ms(t)}${perSegment}`);

    // ── 4. Susun asset + lane ───────────────────────────────────────────
    setStage('assembling');
    studioActions.setImportStage(jobId, 'assembling', null);
    t = performance.now();
    const vocals = await pcmToProjectBuffer(result.vocals, projectRate);
    const instrumental = await pcmToProjectBuffer(result.instrumental, projectRate);
    if (signal.aborted) return cancelled('signal', started, 'setelah konversi ke rate proyek');

    // Verifikasi SEBELUM commit (docs/26 §3c). Store tidak punya id proyek;
    // yang dipakai: clip masih ada DI LANE YANG SAMA, dan job ini masih
    // terdaftar — `hydrate` (proyek diganti) mengosongkan `importJobs`, jadi
    // job yang hilang dari daftar berarti proyeknya sudah bukan yang tadi.
    const now = studioStore.getState();
    const still = findClip(now.lanes, clip.id);
    if (still === null) return cancelled('clip-hilang', started);
    if (still.lane.id !== lane.id) return cancelled('lane-berubah', started);
    if (!now.importJobs.some((j) => j.id === jobId)) return cancelled('job-tidak-terdaftar', started);

    const label = clip.label;
    const vocalsId = assetActions.newAssetId();
    assetActions.registerAsset(assetFromBuffer(vocalsId, `${label} · VOCALS`, vocals));
    registerBuffer(vocalsId, vocals);
    const instId = assetActions.newAssetId();
    assetActions.registerAsset(assetFromBuffer(instId, `${label} · INST`, instrumental));
    registerBuffer(instId, instrumental);

    const laneIds = studioActions.insertLanesBelow(
      lane.id,
      [
        { name: `${label} · VOCALS`, clips: [resultClip(still.clip, vocalsId, vocals.length, `${label} · VOCALS`)] },
        { name: `${label} · INST`, clips: [resultClip(still.clip, instId, instrumental.length, `${label} · INST`)] },
      ],
      { muteSource: params.muteSource },
    );
    console.info(
      `${TAG} selesai: lane [${laneIds.join(', ')}] (${vocals.length} frame @${projectRate} Hz),` +
        ` susun ${ms(t)}, total ${ms(started)}`,
    );
    return { laneIds, totalMs: result.totalMs, inferenceMs: result.inferenceMs, segments };
  } finally {
    studioActions.endImport(jobId);
    active = null;
    markVocalSplitJob(null);
  }
}

// ── Pemilihan runtime ────────────────────────────────────────────────────────

interface SeparationResult {
  readonly vocals: StereoPcm;
  readonly instrumental: StereoPcm;
  /** Seluruh langkah 3, ms (worker: `SplitResult.totalMs`; native: diukur di sini). */
  readonly totalMs: number;
  /** Hanya di dalam `session.run`, ms; null di native (host tidak melaporkannya). */
  readonly inferenceMs: number | null;
}

type Separator = (
  input: StereoPcm,
  onProgress: (done: number, total: number) => void,
  signal: AbortSignal,
) => Promise<SeparationResult>;

interface PickedSeparator {
  readonly separate: Separator;
  /** Label untuk log: `native·coreml`, `native·cpu`, `wasm`, atau `webgpu`. */
  readonly runtime: string;
}

/**
 * Langkah 3 untuk runtime yang dipilih sesi. Dipanggil SETELAH
 * `ensureVocalModel`, jadi klien worker (kalau itu runtimenya) sudah siap.
 */
async function pickSeparator(params: VocalSplitParams): Promise<PickedSeparator> {
  const native = nativeVocalSplitHost();
  if (native !== undefined) {
    // Probe mengisi `accel` bawaan (coreml kalau ada); di-cache setelah pertama.
    await probeVocalSplitRuntime();
    const accel = params.accel ?? vocalSplitSnapshot().accel;
    const separate: Separator = async (input, onProgress, signal) => {
      const t = performance.now();
      const out = await native.run(
        {
          left: input.left,
          right: input.right,
          sampleRate: MODEL_SAMPLE_RATE,
          modelId: params.modelId,
          overlap: params.overlap,
          denoise: params.denoise,
          accel,
          // Thread hanya berarti untuk CPU; CoreML mengatur dirinya sendiri.
          ...(accel === 'cpu' && params.maxThreads !== undefined ? { threads: params.maxThreads } : {}),
        },
        onProgress,
        signal,
      );
      return { ...out, totalMs: performance.now() - t, inferenceMs: null };
    };
    return { separate, runtime: `native·${accel}` };
  }
  const client = readyVocalSplitClient(params.modelId);
  if (client === null) throw new Error('sesi model hilang setelah dimuat');
  const executionProvider = vocalSplitSessionExecutionProvider() ?? 'wasm';
  const options = { overlap: params.overlap, denoise: params.denoise };
  const separate: Separator = async (input, onProgress, signal) => {
    const report = (p: { done: number; total: number }): void => onProgress(p.done, p.total);
    try {
      return await client.separate(
        input.left,
        input.right,
        // `transfer`: PCM di `input` adalah salinan/hasil render milik job ini,
        // bukan buffer asset — boleh dipindahkan tanpa salinan kedua. KECUALI
        // di WebGPU: kalau ia gagal, PCM yang sama masih harus dikirim ke
        // sesi WASM pengganti, dan buffer yang sudah dipindahkan itu kosong.
        { ...options, transfer: executionProvider !== 'webgpu' },
        report,
        signal,
      );
    } catch (err: unknown) {
      // Fallback WebGPU → WASM, SEKALI: sesudah `fallbackVocalSplitToWasm`
      // EP sesinya `wasm`, dan pemeriksaan di bawah tidak lolos lagi.
      if (isAbortError(err) || signal.aborted || vocalSplitSessionExecutionProvider() !== 'webgpu') throw err;
      const fallback = await fallbackVocalSplitToWasm(params.modelId, { maxThreads: params.maxThreads }, err);
      if (signal.aborted) throw abortError();
      console.info(`${TAG} mengulang pemisahan di wasm`);
      return await fallback.separate(input.left, input.right, { ...options, transfer: true }, report, signal);
    }
  };
  return { separate, runtime: executionProvider };
}

function abortError(): DOMException {
  return new DOMException('Vocal split dibatalkan', 'AbortError');
}

/**
 * Clip hasil: `start`/`len` SAMA PERSIS dengan sumber (docs/26 §3a), region
 * dari nol sepanjang hasil, tanpa chain, fade bawaan seperti `placeAssetOnLane`,
 * stem bypass. Lane baru berkecepatan 1 — kalau lane sumber varispeed,
 * `len` sumber yang disalin tetap yang dipakai, sesuai janji "sama persis".
 */
function resultClip(source: StudioClip, assetId: number, frames: number, label: string): Omit<StudioClip, 'id'> {
  return {
    assetId,
    chain: [],
    start: source.start,
    len: source.len,
    sourceStart: 0,
    sourceLen: frames,
    label,
    gainDb: 0,
    fadeInMs: 0,
    fadeOutMs: 0,
    fadeCurve: DEFAULT_FADE_CURVE,
    seed: assetId % 97,
    stem: STEM_BYPASS,
  };
}

// ── Konversi PCM ─────────────────────────────────────────────────────────────

type OfflineCtor = new (channels: number, length: number, sampleRate: number) => OfflineAudioContext;

/** Sama dengan `stem-bake.ts`: `OfflineAudioContext` atau prefiks webkit. */
function offlineCtor(): OfflineCtor {
  const w = globalThis as unknown as { OfflineAudioContext?: OfflineCtor; webkitOfflineAudioContext?: OfflineCtor };
  const Ctor = w.OfflineAudioContext ?? w.webkitOfflineAudioContext;
  if (Ctor === undefined) throw new Error('browser ini tidak punya OfflineAudioContext');
  return Ctor;
}

/**
 * Region `sourceStart..frames` dari asset sebagai stereo 44,1 kHz.
 *
 * Rate sama → salin langsung (mono digandakan). Rate beda → render lewat
 * `OfflineAudioContext` di rate model; sumber mono otomatis di-upmix ke dua
 * kanal oleh graf (interpretasi `speakers`).
 */
async function sourceRegionForModel(buffer: AudioBuffer, sourceStart: number, frames: number): Promise<StereoPcm> {
  if (buffer.sampleRate === MODEL_SAMPLE_RATE) {
    const left = buffer.getChannelData(0).slice(sourceStart, sourceStart + frames);
    const right = buffer.numberOfChannels > 1
      ? buffer.getChannelData(1).slice(sourceStart, sourceStart + frames)
      : left.slice();
    return { left, right };
  }
  const outFrames = Math.max(1, Math.round((frames * MODEL_SAMPLE_RATE) / buffer.sampleRate));
  const ctx = new (offlineCtor())(2, outFrames, MODEL_SAMPLE_RATE);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start(0, sourceStart / buffer.sampleRate, frames / buffer.sampleRate);
  const rendered = await ctx.startRendering();
  return { left: rendered.getChannelData(0), right: rendered.getChannelData(1) };
}

/** `AudioBuffer` stereo dari dua kanal PCM. */
function pcmToBuffer(pcm: StereoPcm, sampleRate: number): AudioBuffer {
  const out = new AudioBuffer({ numberOfChannels: 2, length: pcm.left.length, sampleRate });
  // `set`, bukan `copyToChannel`: PCM dari worker bertipe `ArrayBufferLike`
  // (boleh SharedArrayBuffer), dan `copyToChannel` menolaknya di tipe.
  out.getChannelData(0).set(pcm.left);
  out.getChannelData(1).set(pcm.right);
  return out;
}

/** Hasil pemisahan (44,1 kHz) → `AudioBuffer` di rate proyek, resample kalau perlu. */
async function pcmToProjectBuffer(pcm: StereoPcm, projectRate: number): Promise<AudioBuffer> {
  const atModelRate = pcmToBuffer(pcm, MODEL_SAMPLE_RATE);
  if (projectRate === MODEL_SAMPLE_RATE) return atModelRate;
  const outFrames = Math.max(1, Math.round((pcm.left.length * projectRate) / MODEL_SAMPLE_RATE));
  const ctx = new (offlineCtor())(2, outFrames, projectRate);
  const src = ctx.createBufferSource();
  src.buffer = atModelRate;
  src.connect(ctx.destination);
  src.start(0);
  return ctx.startRendering();
}
