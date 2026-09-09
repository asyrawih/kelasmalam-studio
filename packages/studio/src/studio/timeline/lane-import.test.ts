/**
 * Siklus hidup `ImportJob` + penempatan clip saat beberapa file datang
 * sekaligus.
 *
 * Yang dijaga di sini adalah dua kegagalan yang tidak terlihat sebagai error:
 * job yang tidak pernah ditutup (bar progres abadi di lane) dan import yang
 * diam-diam berjalan berantre (lagu ketiga baru mulai setelah dua yang pertama
 * selesai — persis yang membuat "import 3 lagu sekaligus" terasa macet).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_FADE_CURVE, type StudioClip } from '../model';

/** Panggilan yang ditangkap + kendalinya, supaya tes bisa menahan penyelesaian. */
interface Call {
  readonly name: string;
  readonly laneId: string;
  readonly start: number;
  readonly opts: { onProgress?: Report; avoidOverlap?: boolean };
  resolve: (r: { ok: boolean; reason?: string }) => void;
  reject: (e: Error) => void;
}
type Report = (p: { stage: 'reading' | 'decoding' | 'analyzing'; ratio: number | null }) => void;
const calls: Call[] = [];

function capture(
  name: string,
  laneId: string,
  start: number,
  opts: Call['opts'],
): Promise<{ ok: boolean; reason?: string }> {
  return new Promise((resolve, reject) => {
    calls.push({ name, laneId, start, opts, resolve, reject });
  });
}

/** Kabar kemajuan yang diteruskan lane-import ke store, milik panggilan ke-`i`. */
const report = (i: number): Report => {
  const fn = calls[i]!.opts.onProgress;
  if (fn === undefined) throw new Error('lane-import tidak meneruskan onProgress');
  return fn;
};

vi.mock('./audio-import', () => ({
  importFileToLane: (file: File, laneId: string, start: number, _sr: number, opts: Call['opts']) =>
    capture(file.name, laneId, start, opts),
}));

vi.mock('./url-to-lane', () => ({
  importUrlToLane: (text: string, laneId: string, start: number, _sr: number, opts: Call['opts']) =>
    capture(text, laneId, start, opts),
}));

const { runFileImport, runUrlImport } = await import('./lane-import');
const { studioActions, studioStore } = await import('../store');

const SR = 48_000;
const file = (name: string): File => ({ name }) as unknown as File;
const jobs = () => studioStore.getState().importJobs;

function clip(id: string, startSec: number, lenSec: number): StudioClip {
  return {
    id,
    assetId: 1,
    chain: [],
    start: startSec * SR,
    len: lenSec * SR,
    sourceStart: 0,
    sourceLen: lenSec * SR,
    label: id,
    gainDb: 0,
    fadeInMs: 0,
    fadeOutMs: 0,
    fadeCurve: DEFAULT_FADE_CURVE,
    seed: 1,
  };
}

let laneA = '';
let laneB = '';

beforeEach(() => {
  calls.length = 0;
  studioActions.__resetForTest('empty');
  if (studioStore.getState().lanes.length < 2) studioActions.addLane();
  const [a, b] = studioStore.getState().lanes.map((l) => l.id);
  laneA = a!;
  laneB = b!;
});

describe('job import', () => {
  it('hidup selama import berjalan dan hilang setelah selesai', async () => {
    const done = runFileImport(file('a.wav'), laneA, 0, SR);
    expect(jobs()).toHaveLength(1);
    expect(jobs()[0]!.laneId).toBe(laneA);
    expect(jobs()[0]!.name).toBe('a.wav');
    expect(jobs()[0]!.stage).toBe('reading');

    calls[0]!.resolve({ ok: true });
    await done;
    expect(jobs()).toHaveLength(0);
  });

  it('meneruskan tahap dan rasio dari decoder ke store', async () => {
    const done = runFileImport(file('a.wav'), laneA, 0, SR);
    report(0)({ stage: 'reading', ratio: 0.42 });
    expect(jobs()[0]!.ratio).toBe(0.42);
    report(0)({ stage: 'decoding', ratio: null });
    expect(jobs()[0]!.stage).toBe('decoding');
    expect(jobs()[0]!.ratio).toBeNull();

    calls[0]!.resolve({ ok: true });
    await done;
  });

  it('menutup job walau import gagal ATAU melempar', async () => {
    const failed = runFileImport(file('a.wav'), laneA, 0, SR);
    calls[0]!.resolve({ ok: false, reason: 'bukan audio' });
    expect((await failed).ok).toBe(false);
    expect(jobs()).toHaveLength(0);

    const thrown = runFileImport(file('b.wav'), laneA, 0, SR);
    calls[1]!.reject(new Error('boom'));
    await expect(thrown).rejects.toThrow('boom');
    expect(jobs()).toHaveLength(0);
  });

  it('tiga import berjalan BERSAMAAN, bukan berantre', () => {
    void runFileImport(file('a.wav'), laneA, 0, SR);
    void runFileImport(file('b.wav'), laneB, 0, SR);
    void runUrlImport('https://x.test/c.wav', laneB, 0, SR);

    // Ketiganya sudah mulai walau belum satu pun selesai.
    expect(calls.map((c) => c.name)).toEqual(['a.wav', 'b.wav', 'https://x.test/c.wav']);
    expect(jobs()).toHaveLength(3);
    // Dan tiap lane hanya melihat miliknya sendiri.
    expect(jobs().filter((j) => j.laneId === laneB)).toHaveLength(2);
  });

  it('nama job dari URL memakai ruas terakhirnya, bukan URL penuh', () => {
    void runUrlImport('https://x.test/musik/lagu.wav', laneA, 0, SR);
    expect(jobs()[0]!.name).toBe('lagu.wav');
  });
});

describe('opsi penempatan diteruskan, bukan dihitung di sini', () => {
  it('`avoidOverlap` sampai ke jalur pembuat clip apa adanya', () => {
    studioActions.addClip(laneA, clip('x', 0, 10));
    void runFileImport(file('a.wav'), laneA, 2 * SR, SR, { avoidOverlap: true });

    // Posisinya TIDAK digeser di sini: kalau digeser sekarang, tiga import yang
    // mulai bersamaan akan menghitung angka yang sama persis dan tetap
    // menumpuk. Yang tahu jawabannya hanya `importBytesToLane`, saat clip-nya
    // benar-benar dibuat (lihat lane-placement.test.ts).
    expect(calls[0]!.start).toBe(2 * SR);
    expect(calls[0]!.opts.avoidOverlap).toBe(true);
  });

  it('tanpa opsi, tidak ada `avoidOverlap` yang diselipkan diam-diam', () => {
    void runFileImport(file('a.wav'), laneA, 2 * SR, SR);
    expect(calls[0]!.start).toBe(2 * SR);
    expect(calls[0]!.opts.avoidOverlap).toBeUndefined();
  });
});
