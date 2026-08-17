/**
 * @vitest-environment node
 *
 * TES INTEGRASI EXPORT — satu-satunya tes di repo ini yang benar-benar
 * menghasilkan file audio.
 *
 * Kenapa perlu, padahal `run-export.test.ts` sudah hijau: tes itu memakai engine
 * PALSU. Ia membuktikan urutan panggilan loop-nya benar dan tidak lebih. Semua
 * hal yang paling mungkin rusak ada di luar jangkauannya:
 *
 *   - artefak .wasm-nya sendiri bisa tidak bisa di-compile (dan memang pernah:
 *     `wasm-opt -all` menyalakan proposal eksperimen binaryen yang mengubah
 *     encoding section import — file 205 KB yang ditolak SEMUA mesin wasm,
 *     dengan wasm-opt keluar status 0),
 *   - `wasm-loader` bisa membaca memory yang SALAH (varian st mengekspor
 *     memory-nya sendiri dan mengabaikan yang dikirim JS) — hasilnya file berisi
 *     nol sempurna, tanpa satu pun error,
 *   - pemetaan model→snapshot di `studio.rs` bisa menjatuhkan semua clip.
 *
 * Ketiganya menghasilkan file yang UKURANNYA benar dan HEADER-nya benar. Cuma
 * isinya yang senyap. Jadi yang di-assert di sini bukan "tidak melempar", tapi:
 * ada energi di dalamnya, jumlah frame-nya persis, header RIFF-nya sah, dan
 * sample-nya cocok dengan yang diramalkan matematika gain/fade.
 *
 * Jalan di environment `node` karena jsdom tidak punya `WebAssembly` yang bisa
 * dipakai untuk ini; varian `st` dipilih karena ia tidak butuh SharedArrayBuffer
 * maupun cross-origin isolation.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { buildExportPayload } from './payload';
import { runExport, type ExportEncoder, type ExportEngine } from './run-export';
import type {
  EqBandKind,
  ExportFormat,
  FadeCurve,
  StudioLane,
  StudioState,
} from '../model';
import { defaultEq } from '../model';

const SR = 48_000;
const CHANNELS = 2;

// ── memuat artefak SUNGGUHAN ────────────────────────────────────────────────

interface Glue {
  initSync(o: { module: WebAssembly.Module }): { memory: WebAssembly.Memory };
  initNonRealtime(): void;
  abiVersion(): number;
  snapshotFromStudioJson(json: string): {
    bytes(): Uint8Array;
    warnings(): string[];
    clipCount(): number;
    free(): void;
  };
  OfflineRender: new (
    snapshot: Uint8Array,
    sampleRate: number,
    start: number,
    end: number,
    blocksPerBatch: number,
  ) => never;
  WavEncoderHandle: unknown;
  WavBits: { Pcm16: number; Pcm24: number; Float32: number };
  FlacEncoderHandle: unknown;
  FlacBitsJs: { Pcm16: number; Pcm24: number };
}

let glue: Glue;
let memory: WebAssembly.Memory;

beforeAll(async () => {
  const glueUrl = new URL('../../wasm/st/engine.js', import.meta.url).href;
  const wasmPath = fileURLToPath(new URL('../../wasm/st/engine_bg.wasm', import.meta.url));

  glue = (await import(/* @vite-ignore */ glueUrl)) as unknown as Glue;
  // `WebAssembly.compile` di sini BUKAN formalitas: inilah yang menangkap
  // artefak rusak. Kalau baris ini melempar, tidak ada gunanya melanjutkan —
  // tombol COMPILE di browser akan gagal dengan cara yang sama persis.
  const module = await WebAssembly.compile(readFileSync(wasmPath));
  // Varian st MENGEKSPOR memory-nya sendiri; nilai balik `initSync` (yaitu
  // `instance.exports`) adalah satu-satunya sumber memory yang benar.
  memory = glue.initSync({ module }).memory;
  glue.initNonRealtime();
});

/** Adaptor yang sama bentuknya dengan `createWasmExportEngine`, tapi memakai
 *  memory yang benar-benar milik instance. */
function engine(): ExportEngine {
  return {
    snapshot(json) {
      const h = glue.snapshotFromStudioJson(json);
      try {
        return { bytes: h.bytes(), warnings: h.warnings(), clipCount: h.clipCount() };
      } finally {
        h.free();
      }
    },
    createRender(snapshot, sampleRate, start, end, blocks) {
      return new glue.OfflineRender(snapshot, sampleRate, start, end, blocks) as never;
    },
    view(ptr, len) {
      return new Float32Array(memory.buffer, ptr, len);
    },
  };
}

// ── bahan uji ───────────────────────────────────────────────────────────────

/** Sine 440 Hz, amplitudo 0.5, mono. Sinyal yang RMS-nya diketahui persis:
 *  0.5/√2 ≈ 0.3536 — jadi "tidak senyap" bisa diuji sebagai ANGKA, bukan firasat. */
function sine(frames: number, freq = 440, amp = 0.5): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

/** `AudioBuffer` tidak ada di node; `buildExportPayload` hanya memakai empat
 *  anggota ini, jadi bentuk inilah kontrak sebenarnya. */
function fakeBuffer(data: Float32Array, channels = 1): AudioBuffer {
  return {
    numberOfChannels: channels,
    length: data.length,
    sampleRate: SR,
    getChannelData: () => data,
  } as unknown as AudioBuffer;
}

function clip(o: {
  id: string;
  assetId: number;
  start: number;
  len: number;
  gainDb?: number;
  fadeInMs?: number;
  fadeOutMs?: number;
  fadeCurve?: FadeCurve;
}) {
  return {
    id: o.id,
    assetId: o.assetId,
    start: o.start,
    len: o.len,
    sourceStart: 0,
    sourceLen: o.len,
    label: o.id,
    gainDb: o.gainDb ?? 0,
    fadeInMs: o.fadeInMs ?? 0,
    fadeOutMs: o.fadeOutMs ?? 0,
    fadeCurve: o.fadeCurve ?? ('linear' as FadeCurve),
    seed: 1,
  };
}

function lane(o: Partial<StudioLane> & { id: string }): StudioLane {
  return {
    name: o.id,
    color: '#ffd400',
    mute: false,
    solo: false,
    gainDb: 0,
    speedRatio: 1,
    eq: defaultEq(),
    clips: [],
    ...o,
  } as StudioLane;
}

function state(lanes: StudioLane[], format: ExportFormat = 'WAV'): StudioState {
  return {
    projectName: 'integration',
    sampleRate: SR,
    duration: SR * 10,
    lanes,
    playing: false,
    playhead: 0,
    speed: 1,
    selectedLaneId: null,
    selectedClipId: null,
    pxPerSecond: null,
    tab: 'compile',
    format,
    preset: 'FLAT',
    exportProgress: null,
  };
}

/** EQ dengan gain nyata di beberapa band — supaya jalur filter benar-benar
 *  dilewati, bukan di-bypass karena semua gain-nya nol. */
function tiltedEq() {
  const eq = defaultEq();
  const gains: Record<string, number> = { low: 9, mid: -6, pres: 4, air: -3 };
  for (const b of eq.bands) b.gainDb = gains[b.id] ?? 0;
  // Pastikan jenisnya memang shelf/peaking seperti yang dipetakan studio.rs.
  const kinds = new Set<EqBandKind>(['lowshelf', 'peaking', 'highshelf']);
  for (const b of eq.bands) expect(kinds.has(b.kind)).toBe(true);
  return eq;
}

// ── util analisis ───────────────────────────────────────────────────────────

function rms(x: Float32Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i]! * x[i]!;
  return Math.sqrt(s / Math.max(1, x.length));
}

interface WavInfo {
  sampleRate: number;
  channels: number;
  bits: number;
  format: number;
  frames: number;
  left: Float32Array;
  right: Float32Array;
}

/** Parser WAV mandiri. Sengaja TIDAK memakai kode encoder kita: encoder yang
 *  memeriksa dirinya sendiri akan setuju dengan kesalahannya sendiri. */
function parseWav(bytes: Uint8Array): WavInfo {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (off: number): string => String.fromCharCode(...bytes.subarray(off, off + 4));
  expect(tag(0)).toBe('RIFF');
  expect(tag(8)).toBe('WAVE');
  expect(dv.getUint32(4, true)).toBe(bytes.length - 8);

  let off = 12;
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataOff = -1;
  let dataLen = 0;
  while (off + 8 <= bytes.length) {
    const id = tag(off);
    const size = dv.getUint32(off + 4, true);
    if (id === 'fmt ') {
      format = dv.getUint16(off + 8, true);
      channels = dv.getUint16(off + 10, true);
      sampleRate = dv.getUint32(off + 12, true);
      bits = dv.getUint16(off + 22, true);
    } else if (id === 'data') {
      dataOff = off + 8;
      dataLen = size;
    }
    off += 8 + size + (size % 2);
  }
  expect(dataOff).toBeGreaterThan(0);

  const bytesPerSample = bits / 8;
  const frames = dataLen / (channels * bytesPerSample);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const p = dataOff + (i * channels + c) * bytesPerSample;
      let v: number;
      if (format === 3) v = dv.getFloat32(p, true);
      else if (bits === 16) v = dv.getInt16(p, true) / 32767;
      else {
        // 24-bit little-endian, bit tanda di byte ketiga.
        const raw = (bytes[p]! | (bytes[p + 1]! << 8) | (bytes[p + 2]! << 16)) << 8;
        v = raw / 8 / 8_388_607;
      }
      (c === 0 ? left : right)[i] = v;
    }
  }
  return { sampleRate, channels, bits, format, frames, left, right };
}

async function blobBytes(b: Blob): Promise<Uint8Array> {
  return new Uint8Array(await b.arrayBuffer());
}

/**
 * `runExport` sengaja TIDAK memanggil `encoder.init()` — itu tugas
 * `export-bridge`, yang harus melakukannya sebelum picker "save as" agar user
 * gesture tidak keburu hilang. Helper ini meniru urutan yang sama.
 */
async function runOne(
  payload: ReturnType<typeof buildExportPayload>,
  encoder: ExportEncoder,
  extra: { onProgress?: (f: number) => void; isCancelled?: () => boolean } = {},
) {
  await encoder.init({ sampleRate: SR, channels: CHANNELS });
  return runExport({ payload, sampleRate: SR, engine: engine(), encoder, ...extra });
}

/** Encoder WAV Rust, dipanggil lewat jalur yang sama dengan UI. */
function wavEncoder(bitDepth: 16 | 24 | 32): ExportEncoder {
  const Ctor = glue.WavEncoderHandle as new (
    sr: number,
    ch: number,
    bits: number,
    seed: number,
  ) => {
    header(): Uint8Array;
    encode(l: Float32Array, r: Float32Array): Uint8Array;
    flush(): Uint8Array;
    patchHeader(): Uint8Array;
    free(): void;
  };
  let h: InstanceType<typeof Ctor> | null = null;
  return {
    mime: 'audio/wav',
    init: (o) => {
      const bits =
        bitDepth === 16 ? glue.WavBits.Pcm16 : bitDepth === 32 ? glue.WavBits.Float32 : glue.WavBits.Pcm24;
      h = new Ctor(o.sampleRate, o.channels, bits, 0x5eed1234);
      return Promise.resolve();
    },
    header: () => h!.header(),
    encode: (p) => h!.encode(p[0]!, p[1]!),
    finish: () => h!.flush(),
    finalHeader: () => {
      const out = h!.patchHeader();
      h!.free();
      h = null;
      return out;
    },
  };
}

/** Encoder FLAC Rust — bentuknya identik dengan WAV, itu memang intinya. */
function flacEncoder(bitDepth: 16 | 24): ExportEncoder {
  const Ctor = glue.FlacEncoderHandle as new (
    sr: number,
    ch: number,
    bits: number,
    seed: number,
  ) => {
    header(): Uint8Array;
    encode(l: Float32Array, r: Float32Array): Uint8Array;
    flush(): Uint8Array;
    patchHeader(): Uint8Array;
    free(): void;
  };
  let h: InstanceType<typeof Ctor> | null = null;
  return {
    mime: 'audio/flac',
    init: (o) => {
      h = new Ctor(
        o.sampleRate,
        o.channels,
        bitDepth === 16 ? glue.FlacBitsJs.Pcm16 : glue.FlacBitsJs.Pcm24,
        0x5eed1234,
      );
      return Promise.resolve();
    },
    header: () => h!.header(),
    encode: (p) => h!.encode(p[0]!, p[1]!),
    finish: () => h!.flush(),
    finalHeader: () => {
      const out = h!.patchHeader();
      h!.free();
      h = null;
      return out;
    },
  };
}

// ── proyek uji: dua lane, tiga clip, satu fade, satu lane speed≠1 + EQ ──────

const SECONDS = 3;
const FRAMES = SR * SECONDS;
const TONE_A = sine(FRAMES, 440, 0.5);
const TONE_B = sine(FRAMES, 220, 0.35);
const FADE_MS = 500;

function twoLaneProject() {
  const lanes = [
    lane({
      id: 'A',
      clips: [
        clip({ id: 'a1', assetId: 1, start: 0, len: FRAMES, fadeInMs: FADE_MS }),
        clip({ id: 'a2', assetId: 1, start: FRAMES, len: FRAMES, gainDb: -6 }),
      ],
    }),
    lane({
      id: 'B',
      // Varispeed: durasi timeline clip = sourceLen / speedRatio.
      speedRatio: 1.5,
      eq: tiltedEq(),
      clips: [clip({ id: 'b1', assetId: 2, start: 0, len: Math.round(FRAMES / 1.5) })],
    }),
  ];
  const buffers = new Map<number, AudioBuffer>([
    [1, fakeBuffer(TONE_A)],
    [2, fakeBuffer(TONE_B)],
  ]);
  return {
    st: state(lanes),
    getBuffer: (id: number) => buffers.get(id),
  };
}

describe('export lewat engine WASM sungguhan', () => {
  it('artefak st bisa di-compile dan ABI-nya cocok', () => {
    expect(glue.abiVersion()).toBe(1);
    expect(memory.buffer.byteLength).toBeGreaterThan(0);
  });

  it('menghasilkan WAV 16-bit yang TIDAK senyap, panjang & header-nya benar', async () => {
    const { st, getBuffer } = twoLaneProject();
    const payload = buildExportPayload(st, getBuffer);
    expect(payload.assets.length).toBe(2);
    expect(payload.endSample).toBe(FRAMES * 2);

    const progress: number[] = [];
    const result = await runOne(payload, wavEncoder(16), {
      onProgress: (f) => progress.push(f),
    });

    expect(result.frames).toBe(FRAMES * 2);
    const bytes = await blobBytes(result.blob);
    const wav = parseWav(bytes);
    expect(wav.sampleRate).toBe(SR);
    expect(wav.channels).toBe(CHANNELS);
    expect(wav.bits).toBe(16);
    expect(wav.format).toBe(1);
    expect(wav.frames).toBe(FRAMES * 2);

    // INI assert-nya. Senyap = 0; ambang 0.05 jauh di atas noise dither
    // (~1e-5) dan jauh di bawah level sinyal yang diharapkan.
    const energyL = rms(wav.left);
    // eslint-disable-next-line no-console
    console.log(`[export] wav16 rms L=${energyL.toFixed(4)} R=${rms(wav.right).toFixed(4)}`);
    expect(energyL).toBeGreaterThan(0.05);
    expect(rms(wav.right)).toBeGreaterThan(0.05);
    // Kanal L dan R harus setara: tidak ada pan, jadi mix-nya simetris.
    expect(rms(wav.right)).toBeCloseTo(energyL, 2);

    // Progress harus benar-benar bergerak, bukan melompat dari 0 ke 1.
    expect(progress.length).toBeGreaterThan(3);
    expect(progress[0]!).toBeGreaterThan(0);
    expect(progress[progress.length - 1]!).toBe(1);
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]!).toBeGreaterThanOrEqual(progress[i - 1]!);
    }
  });

  /**
   * Gain dan fade diperiksa SAMPLE PER SAMPLE terhadap ramalan aritmetiknya.
   * Satu lane saja, tanpa EQ, supaya tidak ada yang mengaburkan hasilnya —
   * "RMS > 0" akan lulus untuk engine yang mengalikan dengan angka yang salah.
   */
  it('gain dan fade cocok dengan matematika yang diramalkan', async () => {
    const half = Math.round(FRAMES / 2);
    const st = state([
      lane({
        id: 'solo',
        clips: [
          clip({ id: 'c', assetId: 1, start: 0, len: half, fadeInMs: FADE_MS, gainDb: -6 }),
        ],
      }),
    ]);
    const payload = buildExportPayload(st, (id) => (id === 1 ? fakeBuffer(TONE_A) : undefined));

    // f32: tidak ada kuantisasi maupun dither yang perlu ditoleransi.
    const result = await runOne(payload, wavEncoder(32));
    const wav = parseWav(await blobBytes(result.blob));
    expect(wav.format).toBe(3);
    expect(wav.frames).toBe(half);

    const gain = Math.pow(10, -6 / 20);
    const fadeSamples = (FADE_MS / 1000) * SR;
    // Beberapa titik: dalam fade (25 % dan 75 %), tepat sesudah fade, dan jauh
    // di tengah clip.
    for (const i of [
      Math.round(fadeSamples * 0.25),
      Math.round(fadeSamples * 0.75),
      Math.round(fadeSamples) + 1000,
      half - 1000,
    ]) {
      const fade = Math.min(1, i / fadeSamples);
      const expected = TONE_A[i]! * gain * fade;
      expect(wav.left[i]!).toBeCloseTo(expected, 4);
      expect(wav.right[i]!).toBeCloseTo(expected, 4);
    }

    // Sample pertama harus benar-benar nol: fade-in mulai dari 0.
    expect(Math.abs(wav.left[0]!)).toBeLessThan(1e-6);
  });

  it('EQ non-flat benar-benar mengubah audio (bukan di-bypass diam-diam)', async () => {
    const mk = async (eq: ReturnType<typeof defaultEq>): Promise<Float32Array> => {
      const st = state([
        lane({ id: 'x', eq, clips: [clip({ id: 'c', assetId: 1, start: 0, len: FRAMES })] }),
      ]);
      const payload = buildExportPayload(st, () => fakeBuffer(TONE_A));
      const r = await runOne(payload, wavEncoder(32));
      return parseWav(await blobBytes(r.blob)).left;
    };

    const flat = await mk(defaultEq());
    const tilted = await mk(tiltedEq());
    expect(flat.length).toBe(tilted.length);
    // Selisih RMS-nya harus signifikan — low shelf +9 dB pada sine 440 Hz.
    let diff = 0;
    for (let i = 0; i < flat.length; i++) diff += Math.abs(flat[i]! - tilted[i]!);
    expect(diff / flat.length).toBeGreaterThan(1e-3);
  });

  it('lane speed 1.5x memampatkan clip di timeline', async () => {
    const st = state([
      lane({
        id: 'fast',
        speedRatio: 1.5,
        clips: [clip({ id: 'c', assetId: 1, start: 0, len: Math.round(FRAMES / 1.5) })],
      }),
    ]);
    const payload = buildExportPayload(st, () => fakeBuffer(TONE_A));
    const r = await runOne(payload, wavEncoder(32));
    const wav = parseWav(await blobBytes(r.blob));
    expect(wav.frames).toBe(Math.round(FRAMES / 1.5));
    // Dipercepat berarti tetap berbunyi sampai ujung — bukan senyap di ekor.
    expect(rms(wav.left.subarray(wav.frames - SR / 2))).toBeGreaterThan(0.1);
  });

  it('pembatalan menghentikan render dan tidak menghasilkan file', async () => {
    const { st, getBuffer } = twoLaneProject();
    const payload = buildExportPayload(st, getBuffer);
    let batches = 0;
    await expect(
      runOne(payload, wavEncoder(16), {
        onProgress: () => {
          batches++;
        },
        isCancelled: () => batches >= 2,
      }),
    ).rejects.toMatchObject({ cancelled: true });
  });

  /**
   * Bukti klaim yang jadi alasan FLAC ditambahkan: sample yang SAMA, file yang
   * lebih kecil. Keduanya lahir dari `render_block` yang sama — tidak ada jalur
   * render kedua di mana pun.
   */
  it('FLAC lossless lebih kecil dari WAV untuk sumber yang sama', async () => {
    const { st, getBuffer } = twoLaneProject();
    const payload = buildExportPayload(st, getBuffer);

    const wav = await runOne(payload, wavEncoder(24));
    const flac = await runOne(payload, flacEncoder(24));

    const wavBytes = await blobBytes(wav.blob);
    const flacBytes = await blobBytes(flac.blob);

    expect(flac.frames).toBe(wav.frames);
    expect(String.fromCharCode(...flacBytes.subarray(0, 4))).toBe('fLaC');
    // STREAMINFO final: total_samples harus terisi, bukan masih placeholder 0.
    // STREAMINFO mulai di byte 8; `total_samples` = 36 bit yang dimulai di bit
    // 108 di dalamnya, jadi 4 bit rendah byte 13 + 4 byte berikutnya.
    const si = flacBytes.subarray(8, 42);
    const total =
      (si[13]! & 0x0f) * 2 ** 32 +
      si[14]! * 2 ** 24 +
      si[15]! * 2 ** 16 +
      si[16]! * 2 ** 8 +
      si[17]!;
    expect(total).toBe(wav.frames);
    expect(flacBytes.length).toBeLessThan(wavBytes.length);

    // Angka nyata dicetak supaya laporan ukuran tidak perlu ditebak.
    // eslint-disable-next-line no-console
    console.log(
      `[export] frames=${wav.frames} wav24=${wavBytes.length}B flac24=${flacBytes.length}B ` +
        `(${((flacBytes.length / wavBytes.length) * 100).toFixed(1)}%)`,
    );
  });

  /**
   * Matriks format. Semua empat encoder memakan PCM yang SAMA dari
   * `render_block` — kalau salah satunya menghasilkan file kosong (jalur OGG
   * pernah begitu: `finish()` sinkron mengembalikan array kosong), ini yang
   * menangkapnya.
   */
  it('keempat format menghasilkan file berisi dari render yang sama', async () => {
    const { st, getBuffer } = twoLaneProject();
    const payload = buildExportPayload(st, getBuffer);

    const { Mp3LameJsEncoder } = await import('../../encoders/mp3-lamejs');
    const { OggVorbisEncoder } = await import('../../encoders/ogg-vorbis');

    const cases: [string, ExportEncoder][] = [
      ['wav16', wavEncoder(16)],
      ['flac16', flacEncoder(16)],
      ['mp3-192', new Mp3LameJsEncoder() as unknown as ExportEncoder],
      ['ogg-q0.5', new OggVorbisEncoder() as unknown as ExportEncoder],
    ];

    const sizes: string[] = [];
    for (const [name, enc] of cases) {
      await enc.init({ sampleRate: SR, channels: CHANNELS, quality: name.startsWith('mp3') ? 192 : 0.5 });
      const r = await runExport({ payload, sampleRate: SR, engine: engine(), encoder: enc });
      const bytes = await blobBytes(r.blob);
      expect(r.frames).toBe(FRAMES * 2);
      // Ambang 1 KB, bukan 0: file "berhasil" yang hanya berisi header adalah
      // kegagalan yang paling gampang lolos.
      expect(bytes.length).toBeGreaterThan(1024);
      sizes.push(`${name}=${bytes.length}B`);
    }
    // eslint-disable-next-line no-console
    console.log(`[export] ${SECONDS * 2}s stereo — ${sizes.join(' ')}`);
  });
});
