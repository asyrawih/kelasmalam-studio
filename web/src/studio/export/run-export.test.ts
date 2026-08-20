/**
 * Tes loop export dengan engine PALSU.
 *
 * jsdom tidak bisa meng-instantiate modul WASM kita, jadi yang dites di sini
 * adalah satu-satunya bagian yang benar-benar bisa salah: urutan langkah
 * (asset didaftarkan SEBELUM render), pengambilan ulang view setelah
 * `memory.grow`, progress, dan pembatalan yang benar-benar menghentikan render.
 *
 * Yang TIDAK dites di sini — pemetaan model dan DSP — hidup di Rust dan dites
 * dengan `cargo test`, di tempat kebenarannya berada.
 */
import { describe, expect, it, vi } from 'vitest';

import { buildExportPayload } from './payload';
import {
  ExportCancelled,
  runExport,
  type ExportEncoder,
  type ExportEngine,
  type RenderHandle,
} from './run-export';
import { BlobSink } from './sinks';
import type { ExportAssetSource, ExportPayload } from './payload';
import type { StudioState } from '../model';

/**
 * `runExport` menuliskan byte ke sebuah sink, bukan mengembalikan Blob — lihat
 * `sinks.ts`. Tes di bawah peduli pada apa yang KELUAR, jadi helper ini
 * memasang `BlobSink` dan menyajikan hasilnya sebagai byte.
 */
async function runToBytes(
  opts: Omit<Parameters<typeof runExport>[0], 'sink' | 'pcm'> & { pcm?: ExportAssetSource },
): Promise<{ warnings: readonly string[]; frames: number; bytes: Uint8Array; blob: Blob }> {
  const sink = new BlobSink();
  const r = await runExport({ pcm: fakePcm(), ...opts, sink });
  return { ...r, bytes: sink.bytes(), blob: sink.blob(opts.encoder.mime) };
}

// ── Dobel ────────────────────────────────────────────────────────────────────

interface FakeEngineOpts {
  /** Berapa batch yang menghasilkan frame sebelum render selesai. */
  batches?: number;
  framesPerBatch?: number;
  warnings?: string[];
  /** Simulasikan memory.grow di batch ke-n: buffer lama jadi tidak sah. */
  growAtBatch?: number;
  /** Jumlah clip yang dilaporkan snapshot; menentukan penjaga export senyap. */
  clipCount?: number;
}

function fakeEngine(o: FakeEngineOpts = {}) {
  const batches = o.batches ?? 3;
  const framesPerBatch = o.framesPerBatch ?? 128;
  const calls: string[] = [];
  const registered: { id: number; frames: number; channels: number }[] = [];
  let generation = 0;
  let done = 0;
  let freed = false;

  const render: RenderHandle = {
    totalFrames: () => batches * framesPerBatch,
    renderedFrames: () => done * framesPerBatch,
    render: (blocks: number) => {
      calls.push(`render(${blocks})`);
      if (done >= batches) return 0;
      done++;
      // Batch tertentu "menumbuhkan" memory: pointer berubah, dan view lama
      // yang masih dipegang akan menunjuk data basi.
      if (o.growAtBatch === done) generation++;
      return framesPerBatch;
    },
    outLPtr: () => 1000 + generation * 10_000,
    outRPtr: () => 2000 + generation * 10_000,
    beginAsset: (id, channels, frames) => {
      calls.push(`beginAsset(${id})`);
      registered.push({ id, frames, channels });
      // Alamat palsu yang unik per asset; `view()` di bawah menerjemahkannya
      // jadi buffer tersendiri supaya isinya bisa diperiksa.
      return 100_000 + id * 10_000;
    },
    free: () => {
      calls.push('free');
      freed = true;
    },
  };

  const engine: ExportEngine = {
    snapshot: (json: string) => {
      calls.push('snapshot');
      expect(() => JSON.parse(json)).not.toThrow();
      return {
        bytes: new Uint8Array([1, 2, 3]),
        warnings: o.warnings ?? [],
        clipCount: o.clipCount ?? 1,
      };
    },
    createRender: (...args) => {
      calls.push(`createRender(end=${args[3]})`);
      return render;
    },
    // View "baru" tiap panggilan, isinya menandai generasi memory yang aktif —
    // view yang di-cache lintas batch akan terlihat sebagai generasi lama.
    view: (ptr: number, len: number) => {
      const a = new Float32Array(len);
      a.fill(ptr);
      return a;
    },
  };

  return {
    engine,
    calls,
    registered,
    isFreed: () => freed,
    generation: () => generation,
  };
}

function fakeEncoder(): ExportEncoder & { seen: Float32Array[][] } {
  const seen: Float32Array[][] = [];
  return {
    mime: 'audio/wav',
    seen,
    init: vi.fn().mockResolvedValue(undefined),
    header: () => new Uint8Array([0xff, 0xff]),
    encode(planar) {
      seen.push(planar.map((p) => p.slice()));
      return new Uint8Array([planar[0]!.length & 0xff]);
    },
    finish: () => new Uint8Array([0xee]),
    finalHeader: () => new Uint8Array([0xaa, 0xbb]),
  };
}

const payload = (endSample = 384): ExportPayload => ({
  json: JSON.stringify({ sampleRate: 48_000, speed: 1, lanes: [] }),
  assets: [
    { assetId: 0, channels: 1, frames: 64, sampleRate: 48_000 },
    { assetId: 3, channels: 2, frames: 64, sampleRate: 48_000 },
  ],
  endSample,
});

/** Sumber PCM palsu yang mencatat asset mana saja yang benar-benar diminta. */
function fakePcm(): ExportAssetSource & { asked: number[] } {
  const asked: number[] = [];
  const fn = (info: { assetId: number; channels: number; frames: number }) => {
    asked.push(info.assetId);
    return Array.from({ length: info.channels }, () => new Float32Array(info.frames).fill(0.5));
  };
  return Object.assign(fn, { asked });
}

const noYield = (): Promise<void> => Promise.resolve();

// ── Tes ──────────────────────────────────────────────────────────────────────

describe('runExport', () => {
  it('mendaftarkan SEMUA asset sebelum render pertama', async () => {
    const f = fakeEngine();
    await runToBytes({
      payload: payload(),
      sampleRate: 48_000,
      engine: f.engine,
      encoder: fakeEncoder(),
      yieldToEventLoop: noYield,
    });

    // Tanpa urutan ini engine merender senyap sempurna, tanpa error apa pun.
    const firstRender = f.calls.findIndex((c) => c.startsWith('render('));
    const lastRegister = f.calls.map((c) => c.startsWith('beginAsset')).lastIndexOf(true);
    expect(lastRegister).toBeGreaterThanOrEqual(0);
    expect(lastRegister).toBeLessThan(firstRender);
    expect(f.registered.map((r) => r.id)).toEqual([0, 3]);
  });

  it('mengambil ULANG view tiap batch, jadi memory.grow tidak membuatnya membaca data basi', async () => {
    const f = fakeEngine({ batches: 3, growAtBatch: 2 });
    const enc = fakeEncoder();
    await runToBytes({
      payload: payload(),
      sampleRate: 48_000,
      engine: f.engine,
      encoder: enc,
      yieldToEventLoop: noYield,
    });

    expect(enc.seen).toHaveLength(3);
    // Batch 1 dari generasi 0, batch 2 & 3 sesudah grow → pointer berbeda.
    expect(enc.seen[0]![0]![0]).toBe(1000);
    expect(enc.seen[1]![0]![0]).toBe(11_000);
    expect(enc.seen[2]![0]![0]).toBe(11_000);
  });

  it('melaporkan progress monoton 0..1 dan membebaskan renderer', async () => {
    const f = fakeEngine({ batches: 4 });
    const seen: number[] = [];
    const r = await runToBytes({
      payload: payload(),
      sampleRate: 48_000,
      engine: f.engine,
      encoder: fakeEncoder(),
      onProgress: (p) => seen.push(p),
      yieldToEventLoop: noYield,
    });

    expect(seen).toEqual([0.25, 0.5, 0.75, 1, 1]);
    expect(r.frames).toBe(512);
    expect(f.isFreed()).toBe(true);
    expect(r.blob.type).toBe('audio/wav');
  });

  it('membatalkan DI TENGAH render, bukan sesudah selesai', async () => {
    const f = fakeEngine({ batches: 100 });
    let batchesSeen = 0;
    await expect(
      runToBytes({
        payload: payload(),
        sampleRate: 48_000,
        engine: f.engine,
        encoder: fakeEncoder(),
        onProgress: () => {
          batchesSeen++;
        },
        // Batal setelah dua batch: loop harus berhenti di sana, bukan di 100.
        isCancelled: () => batchesSeen >= 2,
        yieldToEventLoop: noYield,
      }),
    ).rejects.toBeInstanceOf(ExportCancelled);

    expect(batchesSeen).toBe(2);
    const renders = f.calls.filter((c) => c.startsWith('render(')).length;
    expect(renders).toBe(2);
    // Renderer tetap dibebaskan walau dibatalkan — kalau tidak, tiap
    // pembatalan menyisakan buffer render di linear memory selamanya.
    expect(f.isFreed()).toBe(true);
  });

  it('batal sebelum batch pertama tidak merender apa pun', async () => {
    const f = fakeEngine();
    await expect(
      runToBytes({
        payload: payload(),
        sampleRate: 48_000,
        engine: f.engine,
        encoder: fakeEncoder(),
        isCancelled: () => true,
        yieldToEventLoop: noYield,
      }),
    ).rejects.toBeInstanceOf(ExportCancelled);
    expect(f.calls.filter((c) => c.startsWith('render('))).toHaveLength(0);
  });

  it('mengganti header placeholder dengan header final, bukan menambahkannya', async () => {
    const f = fakeEngine({ batches: 1 });
    const r = await runToBytes({
      payload: payload(),
      sampleRate: 48_000,
      engine: f.engine,
      encoder: fakeEncoder(),
      yieldToEventLoop: noYield,
    });
    const bytes = new Uint8Array(await r.blob.arrayBuffer());
    // Header final (aa bb) di depan; placeholder (ff ff) tidak boleh tersisa —
    // WAV dengan dua header adalah file rusak.
    expect([...bytes.slice(0, 2)]).toEqual([0xaa, 0xbb]);
    expect([...bytes]).not.toContain(0xff);
  });

  it('meneruskan peringatan dari Rust dan menambah peringatan sample-rate asset', async () => {
    const f = fakeEngine({ warnings: ['Lane "a" punya 5 band EQ.'] });
    const got: string[][] = [];
    const r = await runToBytes({
      payload: {
        ...payload(),
        assets: [
          { assetId: 0, channels: 1, frames: 8, sampleRate: 44_100 },
        ],
      },
      sampleRate: 48_000,
      engine: f.engine,
      encoder: fakeEncoder(),
      onWarnings: (w) => got.push([...w]),
      yieldToEventLoop: noYield,
    });

    expect(r.warnings).toHaveLength(2);
    expect(r.warnings[0]).toContain('band EQ');
    expect(r.warnings[1]).toContain('44100');
    expect(got[0]).toEqual(r.warnings);
  });

  it('tanpa selisih, tidak ada peringatan sama sekali', async () => {
    const f = fakeEngine();
    const onWarnings = vi.fn();
    const r = await runToBytes({
      payload: payload(),
      sampleRate: 48_000,
      engine: f.engine,
      encoder: fakeEncoder(),
      onWarnings,
      yieldToEventLoop: noYield,
    });
    expect(r.warnings).toEqual([]);
    expect(onWarnings).not.toHaveBeenCalled();
  });
});

// ── Payload ─────────────────────────────────────────────────────────────────

function buffer(frames: number, channels = 2, sampleRate = 48_000): AudioBuffer {
  const data = Array.from({ length: channels }, (_, c) =>
    Float32Array.from({ length: frames }, (_, i) => c + i / frames),
  );
  return {
    length: frames,
    numberOfChannels: channels,
    sampleRate,
    duration: frames / sampleRate,
    getChannelData: (c: number) => data[c]!,
  } as unknown as AudioBuffer;
}

describe('buildExportPayload', () => {
  // Diketik `StudioState`, BUKAN `as never`. Cast ke `never` mematikan seluruh
  // pengecekan tipe di fixture, sehingga field wajib yang baru tidak ketahuan
  // saat compile — hanya saat tes gagal jauh kemudian. Itu persis yang terjadi
  // ketika `chain` ditambahkan.
  const state = (over: Partial<StudioState> = {}): StudioState =>
    ({
      sampleRate: 48_000,
      speed: 1,
      masterGainDb: 0,
      masterChain: [],
      lanes: [
        {
          id: 'l1',
          mute: false,
          solo: false,
          gainDb: -3,
          speedRatio: 1.5,
          eq: { bands: [{ id: 'low', kind: 'lowshelf', freq: 90, q: 0.7, gainDb: 4 }] },
          chain: [],
          clips: [
            {
              id: 'c1',
              assetId: 7,
              chain: [],
              start: 4800,
              len: 48_000,
              sourceStart: 100,
              gainDb: -1,
              fadeInMs: 250,
              fadeOutMs: 500,
              fadeCurve: 'equalPower',
            },
            // Clip demo tanpa PCM — harus DILEWATI, sama seperti di preview.
            { id: 'c2', assetId: 99, chain: [], start: 0, len: 96_000, sourceStart: 0, gainDb: 0, fadeInMs: 0, fadeOutMs: 0, fadeCurve: 'linear' },
          ],
        },
      ],
      ...over,
    }) as StudioState;

  const lookup = (id: number): AudioBuffer | undefined => (id === 7 ? buffer(1024) : undefined);

  it('membuang clip tanpa PCM dan mengumpulkan asset sekali per id', () => {
    const { payload: p } = buildExportPayload(state(), lookup);
    const json = JSON.parse(p.json) as {
      lanes: { clips: { id: string; fadeCurve: string }[]; speedRatio: number }[];
    };
    expect(json.lanes[0]!.clips.map((c) => c.id)).toEqual(['c1']);
    // Field yang paling mudah hilang dalam penyalinan — dan yang paling
    // terdengar kalau hilang.
    expect(json.lanes[0]!.clips[0]!.fadeCurve).toBe('equalPower');
    expect(json.lanes[0]!.speedRatio).toBe(1.5);
    expect(p.assets).toHaveLength(1);
    // Id asset DINOMORI ULANG jadi index rapat 0..n-1. Id UI (di sini 7, tapi
    // di aplikasi sungguhan berbasis timestamp ~1.7e15) tidak muat di `u32`
    // milik engine dan akan ditolak saat snapshot dideserialisasi.
    expect(p.assets[0]).toMatchObject({ assetId: 0, channels: 2, frames: 1024 });
    // Deskriptor saja: PCM-nya TIDAK ikut, dan itulah pokok perubahannya.
    expect(p.assets[0]).not.toHaveProperty('data');
  });

  it('menomori ulang id asset besar ke rentang u32 yang rapat', () => {
    const big = 1_786_993_078_361_001; // bentuk id sungguhan: Date.now() * 1000
    const s = state({
      lanes: [
        {
          ...state().lanes[0]!,
          clips: [{ ...state().lanes[0]!.clips[0]!, assetId: big }],
        },
      ],
    });
    const { payload: p } = buildExportPayload(s, (id: number) =>
      id === big ? buffer(1024) : undefined,
    );
    const json = JSON.parse(p.json) as { lanes: { clips: { assetId: number }[] }[] };

    const ids = p.assets.map((a) => a.assetId);
    expect(ids).toEqual([0]);
    for (const id of ids) expect(id).toBeLessThanOrEqual(0xffff_ffff);

    // Referensi clip harus IKUT dinomori ulang; kalau tidak, clip menunjuk
    // asset yang tidak ada dan hasilnya senyap.
    const referenced = json.lanes.flatMap((l) => l.clips.map((c) => c.assetId));
    for (const r of referenced) expect(ids).toContain(r);
  });

  it('panjang output mengerut mengikuti RENDER speed', () => {
    expect(buildExportPayload(state(), lookup).payload.endSample).toBe(52_800);
    expect(buildExportPayload(state({ renderSpeed: 2 }), lookup).payload.endSample).toBe(26_400);
  });

  it('kecepatan TRANSPORT tidak mempengaruhi file yang dihasilkan', () => {
    // Dua angka yang sengaja dipisah: mendengarkan cepat untuk mencari titik
    // edit tidak boleh diam-diam mengubah kecepatan file yang di-export.
    const { payload: fast } = buildExportPayload(state({ speed: 2 }), lookup);
    expect(fast.endSample).toBe(52_800);
    expect(JSON.parse(fast.json).speed).toBe(1);
  });

  it('clip yang LOOP dijabarkan jadi deretan potongan yang menutup rentangnya', () => {
    // Engine Rust belum mengenal `loopLen`; kalau field ini diam-diam ikut
    // terkirim (atau diabaikan), file hasil export akan memutar materi lurus
    // sepanjang clip — persis yang TIDAK terdengar di preview.
    const s = state({
      lanes: [
        {
          ...state().lanes[0]!,
          speedRatio: 1,
          clips: [
            {
              id: 'c1',
              assetId: 7,
              start: 0,
              len: 48_000,
              sourceStart: 0,
              sourceLen: 48_000,
              label: 'c1',
              seed: 1,
              chain: [],
              loopLen: 16_000,
              gainDb: 0,
              fadeInMs: 0,
              fadeOutMs: 0,
              fadeCurve: 'linear',
            },
          ],
        },
      ],
    });
    const json = JSON.parse(buildExportPayload(s, lookup).payload.json) as {
      lanes: { clips: { start: number; len: number; sourceStart: number }[] }[];
    };
    const clips = json.lanes[0]!.clips;
    expect(clips).toHaveLength(3);
    expect(clips.map((c) => c.start)).toEqual([0, 16_000, 32_000]);
    // Tiap potongan membaca region yang sama — itu arti mengulang.
    for (const c of clips) expect(c.sourceStart).toBe(0);
    const last = clips[clips.length - 1]!;
    expect(last.start + last.len).toBe(48_000);
  });

  it('lane mute tidak menyumbang panjang output', () => {
    const muted = state({
      lanes: [{ ...state().lanes[0]!, mute: true }],
    });
    expect(buildExportPayload(muted, lookup).payload.endSample).toBe(0);
  });
});

describe('penjaga export senyap', () => {
  it('menolak render kalau ada clip tapi PCM tidak dikirim', async () => {
    const f = fakeEngine({ clipCount: 3 });
    await expect(
      runToBytes({
        payload: { ...payload(), assets: [] },
        sampleRate: 48_000,
        engine: f.engine,
        encoder: fakeEncoder(),
        yieldToEventLoop: noYield,
      }),
    ).rejects.toThrow(/senyap/i);

    // Berhenti SEBELUM render — bukan setelah membakar CPU untuk hasil kosong.
    expect(f.calls.some((c) => c.startsWith('render'))).toBe(false);
  });

  it('project kosong (nol clip) tetap boleh di-render', async () => {
    const f = fakeEngine({ clipCount: 0 });
    const r = await runToBytes({
      payload: { ...payload(), assets: [] },
      sampleRate: 48_000,
      engine: f.engine,
      encoder: fakeEncoder(),
      yieldToEventLoop: noYield,
    });
    expect(r.frames).toBeGreaterThanOrEqual(0);
  });
});

/**
 * PCM diminta MALAS — satu asset per satu asset, dan hanya sesudah semua
 * penjaga lolos.
 *
 * Dulu `buildExportPayload` meratakan SEMUA asset di muka dan menahannya di
 * heap JS sampai export selesai: untuk project 4 lane × 27 menit itu 2,4 GiB,
 * di samping 2,4 GiB yang sama di linear memory dan 2,4 GiB lagi di cache
 * preview. Tiga salinan dari audio yang sama.
 */
describe('pengambilan PCM', () => {
  it('meminta tiap asset tepat sekali, berpasangan dengan pendaftarannya', async () => {
    const f = fakeEngine();
    const pcm = fakePcm();

    await runToBytes({
      payload: payload(),
      sampleRate: 48_000,
      engine: f.engine,
      encoder: fakeEncoder(),
      pcm,
      yieldToEventLoop: noYield,
    });

    expect(pcm.asked).toEqual([0, 3]);
    expect(f.calls.filter((c) => c.startsWith('beginAsset'))).toEqual([
      'beginAsset(0)',
      'beginAsset(3)',
    ]);
  });

  it('menyalin tiap channel ke alamat yang diberikan engine', async () => {
    const f = fakeEngine();
    const written: Array<{ ptr: number; len: number }> = [];
    // `view()` di fake engine mengembalikan array baru tiap panggilan, jadi
    // yang bisa diperiksa adalah PERMINTAANNYA: satu view seukuran seluruh
    // asset, di alamat yang baru saja dikembalikan `beginAsset`.
    const base = f.engine.view;
    f.engine.view = (ptr, len) => {
      written.push({ ptr, len });
      return base(ptr, len);
    };

    await runToBytes({
      payload: payload(),
      sampleRate: 48_000,
      engine: f.engine,
      encoder: fakeEncoder(),
      pcm: fakePcm(),
      yieldToEventLoop: noYield,
    });

    // Dua asset: 1×64 dan 2×64 sample, di alamat dari `beginAsset`.
    expect(written.slice(0, 2)).toEqual([
      { ptr: 100_000, len: 64 },
      { ptr: 130_000, len: 128 },
    ]);
  });

  /**
   * Dan ini janji yang selama ini tertulis di komentar penjaga tapi tidak
   * ditepati: ia berjalan SESUDAH perataan selesai, jadi "gagal sebelum apa pun
   * dialokasi" tidak pernah benar. Sekarang benar.
   */
  it('tidak menyentuh PCM sama sekali kalau penjaga menolak', async () => {
    const f = fakeEngine();
    // Asset di `payload()` butuh 768 byte; sisa 8 byte jelas tidak cukup.
    f.engine.memoryHeadroomBytes = () => 8;
    const pcm = fakePcm();

    await expect(
      runToBytes({
        payload: payload(),
        sampleRate: 48_000,
        engine: f.engine,
        encoder: fakeEncoder(),
        pcm,
        yieldToEventLoop: noYield,
      }),
    ).rejects.toThrow(/terlalu besar/i);

    expect(pcm.asked).toEqual([]);
  });

  it('menolak sumber yang memberi channel lebih sedikit dari yang dijanjikan', async () => {
    const f = fakeEngine();
    await expect(
      runToBytes({
        payload: payload(),
        sampleRate: 48_000,
        engine: f.engine,
        encoder: fakeEncoder(),
        // Asset kedua butuh 2 channel; sumber ini selalu memberi 1.
        pcm: (info) => [new Float32Array(info.frames)],
        yieldToEventLoop: noYield,
      }),
    ).rejects.toThrow(/butuh 2/);
  });
});

describe('penjaga muat-memori', () => {
  /** Payload dengan satu asset sebesar `frames` × `channels` sample. */
  const bigPayload = (frames: number, channels = 2): ExportPayload => ({
    json: JSON.stringify({ sampleRate: 48_000, speed: 1, lanes: [] }),
    assets: [
      { assetId: 0, channels, frames, sampleRate: 48_000 },
    ],
    endSample: frames,
  });

  it('menolak SEBELUM renderer dibuat kalau PCM melewati sisa linear memory', async () => {
    const f = fakeEngine();
    // 4 MiB PCM (512k frame stereo f32) vs sisa 1 MiB.
    f.engine.memoryHeadroomBytes = () => 1024 * 1024;

    await expect(
      runToBytes({
        payload: bigPayload(512 * 1024),
        sampleRate: 48_000,
        engine: f.engine,
        encoder: fakeEncoder(),
        yieldToEventLoop: noYield,
      }),
    ).rejects.toThrow(/terlalu besar/i);

    // Yang penting bukan cuma "melempar": tanpa ini kegagalannya terjadi di
    // tengah beginAsset sebagai trap wasm, dengan OfflineRender yang sudah
    // berdiri dan tidak pernah di-free.
    expect(f.calls).not.toContain('free');
    expect(f.calls.some((c) => c.startsWith('createRender'))).toBe(false);
    expect(f.calls.some((c) => c.startsWith('beginAsset'))).toBe(false);
  });

  it('pesannya menyebut angka yang bisa ditindaklanjuti, bukan cuma "gagal"', async () => {
    const f = fakeEngine();
    f.engine.memoryHeadroomBytes = () => 1024 * 1024;

    let err: Error | null = null;
    try {
      await runToBytes({
        payload: bigPayload(512 * 1024),
        sampleRate: 48_000,
        engine: f.engine,
        encoder: fakeEncoder(),
        yieldToEventLoop: noYield,
      });
    } catch (e: unknown) {
      err = e as Error;
    }
    expect(err).not.toBeNull();

    // Butuh 4 MiB, sisa 1 MiB — keduanya harus kelihatan, plus jalan keluarnya.
    expect(err!.message).toContain('4 MiB');
    expect(err!.message).toContain('1 MiB');
    expect(err!.message).toMatch(/per-lane/);
  });

  it('yang muat tetap jalan — penjaga tidak boleh jadi pagar yang kelewat rapat', async () => {
    const f = fakeEngine();
    f.engine.memoryHeadroomBytes = () => 8 * 1024 * 1024;

    const r = await runToBytes({
      payload: bigPayload(512 * 1024),
      sampleRate: 48_000,
      engine: f.engine,
      encoder: fakeEncoder(),
      yieldToEventLoop: noYield,
    });
    expect(r.frames).toBeGreaterThan(0);
  });

  it('engine tanpa laporan sisa memori tidak diperiksa sama sekali', async () => {
    // `undefined` berarti "tidak tahu", dan tidak tahu bukan alasan menolak.
    const f = fakeEngine();
    expect(f.engine.memoryHeadroomBytes).toBeUndefined();
    const r = await runToBytes({
      payload: bigPayload(4 * 1024 * 1024),
      sampleRate: 48_000,
      engine: f.engine,
      encoder: fakeEncoder(),
      yieldToEventLoop: noYield,
    });
    expect(r.frames).toBeGreaterThan(0);
  });
});

describe('error asli tidak tertimpa free()', () => {
  it('render yang gagal tetap yang dilaporkan, meski free() ikut melempar', async () => {
    // Ini bentuk kegagalan yang sesungguhnya terjadi di browser: render kehabisan
    // memori dan trap, lalu `free()` di `finally` melempar "attempted to take
    // ownership of Rust value while it was borrowed" karena flag borrow
    // wasm-bindgen tertinggal aktif. Yang kedua itu akibat, bukan sebab.
    const f = fakeEngine();
    f.engine.createRender = () => ({
      totalFrames: () => 1024,
      renderedFrames: () => 0,
      render: () => {
        throw new Error('unreachable executed');
      },
      outLPtr: () => 0,
      outRPtr: () => 0,
      beginAsset: () => 0,
      free: () => {
        throw new Error('attempted to take ownership of Rust value while it was borrowed');
      },
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      runToBytes({
        payload: payload(),
        sampleRate: 48_000,
        engine: f.engine,
        encoder: fakeEncoder(),
        yieldToEventLoop: noYield,
      }),
    ).rejects.toThrow('unreachable executed');

    // Yang tertimpa tidak boleh hilang diam-diam — ia turun ke console.
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('kalau HANYA free() yang gagal, error itu yang dilaporkan', async () => {
    const f = fakeEngine();
    const base = f.engine.createRender;
    f.engine.createRender = (...args) => {
      const h = base(...args);
      return { ...h, free: () => { throw new Error('free rusak'); } };
    };

    await expect(
      runToBytes({
        payload: payload(),
        sampleRate: 48_000,
        engine: f.engine,
        encoder: fakeEncoder(),
        yieldToEventLoop: noYield,
      }),
    ).rejects.toThrow('free rusak');
  });
});

/**
 * Kontrak `runExport` ↔ sink.
 *
 * Urutannya penting sampai ke detail: header placeholder harus keluar SEBELUM
 * chunk pertama (kalau tidak ia tidak bisa ditimpa di posisi 0), dan
 * `patchHeader` harus keluar SEBELUM `close` (sesudah ditutup, berkas di disk
 * sudah dipindahkan ke tujuannya). Dan pada kegagalan apa pun, sink harus
 * di-`abort` — berkas separuh jadi yang ditutup rapi adalah kegagalan yang
 * paling sulit dikenali user.
 */
describe('runExport → sink', () => {
  function recordingSink() {
    const log: string[] = [];
    let held = 0;
    let maxHeld = 0;
    return {
      log,
      maxHeld: () => maxHeld,
      sink: {
        header: (b: Uint8Array) => {
          log.push(`header(${b.length})`);
        },
        chunk: (b: Uint8Array) => {
          log.push(`chunk(${b.length})`);
          // Sink nyata menuliskannya lalu melepasnya. Yang diukur di sini:
          // `runExport` tidak pernah menyerahkan chunk kedua sambil masih
          // memegang yang pertama.
          held++;
          maxHeld = Math.max(maxHeld, held);
          held--;
        },
        patchHeader: (b: Uint8Array) => {
          log.push(`patchHeader(${b.length})`);
        },
        close: () => {
          log.push('close');
        },
        abort: () => {
          log.push('abort');
        },
      },
    };
  }

  it('menyerahkan header, tiap chunk, header final, lalu menutup — dengan urutan itu', async () => {
    const f = fakeEngine({ batches: 3 });
    const r = recordingSink();

    await runExport({
      payload: payload(),
      sampleRate: 48_000,
      engine: f.engine,
      encoder: fakeEncoder(),
      sink: r.sink,
      pcm: fakePcm(),
      yieldToEventLoop: noYield,
    });

    expect(r.log).toEqual([
      'header(2)',
      'chunk(1)',
      'chunk(1)',
      'chunk(1)',
      'chunk(1)', // sisa dari finish()
      'patchHeader(2)',
      'close',
    ]);
    expect(r.maxHeld()).toBe(1);
  });

  it('membatalkan → abort, dan TIDAK close', async () => {
    const f = fakeEngine({ batches: 100 });
    const r = recordingSink();
    let batches = 0;

    await expect(
      runExport({
        payload: payload(),
        sampleRate: 48_000,
        engine: f.engine,
        encoder: fakeEncoder(),
        sink: r.sink,
        pcm: fakePcm(),
        onProgress: () => {
          batches++;
        },
        isCancelled: () => batches >= 2,
        yieldToEventLoop: noYield,
      }),
    ).rejects.toBeInstanceOf(ExportCancelled);

    expect(r.log).toContain('abort');
    expect(r.log).not.toContain('close');
    expect(r.log).not.toContain('patchHeader(2)');
  });

  it('encoder gagal di tengah → abort, dan error aslinya yang naik', async () => {
    const f = fakeEngine({ batches: 5 });
    const r = recordingSink();
    const enc = fakeEncoder();
    let n = 0;
    enc.encode = () => {
      if (++n === 3) throw new Error('encoder meledak');
      return new Uint8Array([1]);
    };

    await expect(
      runExport({
        payload: payload(),
        sampleRate: 48_000,
        engine: f.engine,
        encoder: enc,
        sink: r.sink,
        pcm: fakePcm(),
        yieldToEventLoop: noYield,
      }),
    ).rejects.toThrow('encoder meledak');

    expect(r.log).toContain('abort');
    expect(r.log).not.toContain('close');
    expect(f.isFreed()).toBe(true);
  });

  /**
   * Batas format dicek dari `endSample`, jadi ia bisa menolak sebelum
   * `createRender` — tidak ada renderer yang dibuat, tidak ada byte yang
   * ditulis, dan waktu render tidak terbuang.
   */
  it('menolak sebelum render kalau panjangnya melewati batas format', async () => {
    const f = fakeEngine({ batches: 3 });
    const r = recordingSink();
    const enc = fakeEncoder();
    enc.limitFrames = () => 100;

    await expect(
      runExport({
        payload: { ...payload(), endSample: 101 },
        sampleRate: 48_000,
        engine: f.engine,
        encoder: enc,
        sink: r.sink,
        pcm: fakePcm(),
        yieldToEventLoop: noYield,
      }),
    ).rejects.toThrow(/terlalu panjang untuk format ini/);

    expect(r.log).toEqual([]);
    expect(f.calls.filter((c) => c.startsWith('render('))).toEqual([]);
  });

  it('batas null berarti tak terbatas, bukan nol', async () => {
    const f = fakeEngine({ batches: 1 });
    const r = recordingSink();
    const enc = fakeEncoder();
    enc.limitFrames = () => null;

    await expect(
      runExport({
        payload: payload(),
        sampleRate: 48_000,
        engine: f.engine,
        encoder: enc,
        sink: r.sink,
        pcm: fakePcm(),
        yieldToEventLoop: noYield,
      }),
    ).resolves.toBeTruthy();
    expect(r.log).toContain('close');
  });
});
