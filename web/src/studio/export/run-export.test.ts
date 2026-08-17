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

import { buildExportPayload, flattenBuffer } from './payload';
import {
  ExportCancelled,
  runExport,
  type ExportEncoder,
  type ExportEngine,
  type RenderHandle,
} from './run-export';
import type { ExportPayload } from './payload';

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
    registerAsset: (id, data, channels, frames) => {
      calls.push(`registerAsset(${id})`);
      registered.push({ id, frames, channels });
      expect(data.length).toBeGreaterThan(0);
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
    { assetId: 0, data: new Float32Array(64), channels: 1, frames: 64, sampleRate: 48_000 },
    { assetId: 3, data: new Float32Array(128), channels: 2, frames: 64, sampleRate: 48_000 },
  ],
  endSample,
});

const noYield = (): Promise<void> => Promise.resolve();

// ── Tes ──────────────────────────────────────────────────────────────────────

describe('runExport', () => {
  it('mendaftarkan SEMUA asset sebelum render pertama', async () => {
    const f = fakeEngine();
    await runExport({
      payload: payload(),
      sampleRate: 48_000,
      engine: f.engine,
      encoder: fakeEncoder(),
      yieldToEventLoop: noYield,
    });

    // Tanpa urutan ini engine merender senyap sempurna, tanpa error apa pun.
    const firstRender = f.calls.findIndex((c) => c.startsWith('render('));
    const lastRegister = f.calls.map((c) => c.startsWith('registerAsset')).lastIndexOf(true);
    expect(lastRegister).toBeGreaterThanOrEqual(0);
    expect(lastRegister).toBeLessThan(firstRender);
    expect(f.registered.map((r) => r.id)).toEqual([0, 3]);
  });

  it('mengambil ULANG view tiap batch, jadi memory.grow tidak membuatnya membaca data basi', async () => {
    const f = fakeEngine({ batches: 3, growAtBatch: 2 });
    const enc = fakeEncoder();
    await runExport({
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
    const r = await runExport({
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
      runExport({
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
      runExport({
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
    const r = await runExport({
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
    const r = await runExport({
      payload: {
        ...payload(),
        assets: [
          { assetId: 0, data: new Float32Array(8), channels: 1, frames: 8, sampleRate: 44_100 },
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
    const r = await runExport({
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
  const state = (over: Record<string, unknown> = {}) =>
    ({
      sampleRate: 48_000,
      speed: 1,
      lanes: [
        {
          id: 'l1',
          mute: false,
          solo: false,
          gainDb: -3,
          speedRatio: 1.5,
          eq: { bands: [{ id: 'low', kind: 'lowshelf', freq: 90, q: 0.7, gainDb: 4 }] },
          clips: [
            {
              id: 'c1',
              assetId: 7,
              start: 4800,
              len: 48_000,
              sourceStart: 100,
              gainDb: -1,
              fadeInMs: 250,
              fadeOutMs: 500,
              fadeCurve: 'equalPower',
            },
            // Clip demo tanpa PCM — harus DILEWATI, sama seperti di preview.
            { id: 'c2', assetId: 99, start: 0, len: 96_000, sourceStart: 0, gainDb: 0, fadeInMs: 0, fadeOutMs: 0, fadeCurve: 'linear' },
          ],
        },
      ],
      ...over,
    }) as never;

  const lookup = (id: number): AudioBuffer | undefined => (id === 7 ? buffer(1024) : undefined);

  it('membuang clip tanpa PCM dan mengumpulkan asset sekali per id', () => {
    const p = buildExportPayload(state(), lookup);
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
    expect(p.assets[0]!.data.length).toBe(2048);
  });

  it('menomori ulang id asset besar ke rentang u32 yang rapat', () => {
    const big = 1_786_993_078_361_001; // bentuk id sungguhan: Date.now() * 1000
    const s = state({
      lanes: [
        {
          ...((state() as unknown as { lanes: Record<string, unknown>[] }).lanes[0] as object),
          clips: [
            {
              ...((state() as unknown as { lanes: { clips: object[] }[] }).lanes[0]!
                .clips[0] as object),
              assetId: big,
            },
          ],
        },
      ],
    });
    const p = buildExportPayload(s, (id: number) => (id === big ? buffer(1024) : undefined));
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
    expect(buildExportPayload(state(), lookup).endSample).toBe(52_800);
    expect(buildExportPayload(state({ renderSpeed: 2 }), lookup).endSample).toBe(26_400);
  });

  it('kecepatan TRANSPORT tidak mempengaruhi file yang dihasilkan', () => {
    // Dua angka yang sengaja dipisah: mendengarkan cepat untuk mencari titik
    // edit tidak boleh diam-diam mengubah kecepatan file yang di-export.
    const fast = buildExportPayload(state({ speed: 2 }), lookup);
    expect(fast.endSample).toBe(52_800);
    expect(JSON.parse(fast.json).speed).toBe(1);
  });

  it('lane mute tidak menyumbang panjang output', () => {
    const muted = state({
      lanes: [{ ...(state() as unknown as { lanes: unknown[] }).lanes[0] as object, mute: true }],
    });
    expect(buildExportPayload(muted, lookup).endSample).toBe(0);
  });
});

describe('flattenBuffer', () => {
  it('menyusun channel BERURUTAN (planar), bukan interleaved', () => {
    const flat = flattenBuffer(buffer(4, 2));
    expect(flat.length).toBe(8);
    // Channel 0 seluruhnya dulu, baru channel 1 — kontrak `registerAsset`.
    expect(flat[0]).toBeCloseTo(0);
    expect(flat[3]).toBeCloseTo(0.75);
    expect(flat[4]).toBeCloseTo(1);
    expect(flat[7]).toBeCloseTo(1.75);
  });
});

describe('penjaga export senyap', () => {
  it('menolak render kalau ada clip tapi PCM tidak dikirim', async () => {
    const f = fakeEngine({ clipCount: 3 });
    await expect(
      runExport({
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
    const r = await runExport({
      payload: { ...payload(), assets: [] },
      sampleRate: 48_000,
      engine: f.engine,
      encoder: fakeEncoder(),
      yieldToEventLoop: noYield,
    });
    expect(r.frames).toBeGreaterThanOrEqual(0);
  });
});
