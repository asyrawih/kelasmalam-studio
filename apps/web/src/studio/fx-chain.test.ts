/**
 * Insert chain FX di sisi UI: aksi store, emisi payload, dan pemulihan project
 * lama.
 *
 * Yang dijaga di sini adalah dua kelas kegagalan senyap:
 *
 * 1. Efek yang ada di store tapi tidak ikut ke payload — persis cara
 *    `clip.stem` terdengar di preview tapi hilang dari file export.
 * 2. Project yang tersimpan sebelum FX ada, yang `chain`-nya `undefined` dan
 *    membuat `lane.chain.map` melempar saat export — jauh dari penyebabnya.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { buildExportPayload } from './export/payload';
import { normalizeLanes } from './persist/persistence';
import { studioActions, studioStore } from './store';
import type { FxTarget, StudioLane } from './model';

const noBuffer = (): undefined => undefined;

const PCM = new Float32Array(4_800);
/** Lookup yang MENGEMBALIKAN buffer: `buildExportPayload` membuang clip yang
 *  tidak punya PCM, jadi dengan `noBuffer` tidak ada clip yang tersisa untuk
 *  diperiksa. */
const withBuffer = (): AudioBuffer =>
  ({
    length: PCM.length,
    duration: 0.1,
    numberOfChannels: 2,
    sampleRate: 48_000,
    getChannelData: () => PCM,
  }) as unknown as AudioBuffer;

/** Lane yang benar-benar punya dua clip — demo tidak seragam. */
function laneWithTwoClips(): StudioLane {
  const l = studioStore.getState().lanes.find((x) => x.clips.length >= 2);
  if (l === undefined) throw new Error('demo tidak punya lane dengan dua clip');
  return l;
}

const MASTER: FxTarget = { kind: 'master' };
const lane = (id: string): FxTarget => ({ kind: 'lane', id });
const clipTarget = (id: string): FxTarget => ({ kind: 'clip', id });

function lanes(): StudioLane[] {
  return studioStore.getState().lanes;
}

describe('insert chain FX', () => {
  beforeEach(() => {
    studioActions.__resetForTest('demo');
  });

  it('menambah efek dengan params kosong, bukan salinan default', () => {
    const id = lanes()[0]!.id;
    studioActions.addFx(lane(id), 'eq4');
    const chain = lanes()[0]!.chain;
    expect(chain).toHaveLength(1);
    expect(chain[0]!.kind).toBe('eq4');
    expect(chain[0]!.enabled).toBe(true);
    // Kosong: default-nya dimiliki katalog di Rust. Menyalinnya ke sini akan
    // membekukan angka yang seharusnya bisa berubah.
    expect(chain[0]!.params).toEqual({});
  });

  it('menghapus dan memindahkan efek', () => {
    const id = lanes()[0]!.id;
    studioActions.addFx(lane(id), 'eq4');
    studioActions.addFx(lane(id), 'comp');
    expect(lanes()[0]!.chain.map((f) => f.kind)).toEqual(['eq4', 'comp']);

    // Urutan efek mengubah suara, jadi ini bukan sekadar kosmetik.
    studioActions.moveFx(lane(id), 1, 0);
    expect(lanes()[0]!.chain.map((f) => f.kind)).toEqual(['comp', 'eq4']);

    studioActions.removeFx(lane(id), 0);
    expect(lanes()[0]!.chain.map((f) => f.kind)).toEqual(['eq4']);
  });

  it('indeks di luar rentang tidak merusak chain', () => {
    const id = lanes()[0]!.id;
    studioActions.addFx(lane(id), 'eq4');
    studioActions.moveFx(lane(id), 5, 0);
    studioActions.moveFx(lane(id), 0, 9);
    studioActions.removeFx(lane(id), 7);
    expect(lanes()[0]!.chain).toHaveLength(1);
  });

  it('menyetel parameter dan bypass', () => {
    const id = lanes()[0]!.id;
    studioActions.addFx(lane(id), 'eq4');
    studioActions.setFxParam(lane(id), 0, 'b1_freq', 500);
    studioActions.setFxParam(lane(id), 0, 'b1_on', 1);
    studioActions.setFxEnabled(lane(id), 0, false);
    const fx = lanes()[0]!.chain[0]!;
    expect(fx.params).toEqual({ b1_freq: 500, b1_on: 1 });
    expect(fx.enabled).toBe(false);
  });

  it('target master punya chain sendiri', () => {
    studioActions.addFx(MASTER, 'comp');
    studioActions.setFxParam(MASTER, 0, 'ratio', 8);
    expect(studioStore.getState().masterChain).toHaveLength(1);
    expect(studioStore.getState().masterChain[0]!.params).toEqual({ ratio: 8 });
    // Dan tidak menyentuh lane mana pun.
    expect(lanes().every((l) => l.chain.length === 0)).toBe(true);
  });

  /// Kegagalan kelas 1: ada di store, hilang di payload.
  it('chain ikut ke payload export, lane maupun master', () => {
    const id = lanes()[0]!.id;
    studioActions.addFx(lane(id), 'eq4');
    studioActions.setFxParam(lane(id), 0, 'b1_freq', 800);
    studioActions.addFx(MASTER, 'comp');
    studioActions.setFxEnabled(MASTER, 0, false);

    const { payload } = buildExportPayload(studioStore.getState(), noBuffer);
    const json = JSON.parse(payload.json) as {
      lanes: { chain: { kind: string; enabled: boolean; params: Record<string, number> }[] }[];
      masterChain: { kind: string; enabled: boolean }[];
    };

    const laneChain = json.lanes[0]!.chain;
    expect(laneChain).toHaveLength(1);
    expect(laneChain[0]!.kind).toBe('eq4');
    expect(laneChain[0]!.params).toEqual({ b1_freq: 800 });

    expect(json.masterChain).toHaveLength(1);
    expect(json.masterChain[0]!.kind).toBe('comp');
    expect(json.masterChain[0]!.enabled).toBe(false);
  });

  /// Kegagalan kelas 2: project lama tanpa `chain`.
  it('project yang tersimpan sebelum FX ada tetap terbuka', () => {
    const old = lanes().map((l) => {
      const { chain: _drop, ...rest } = l;
      return rest as unknown as StudioLane;
    });
    const fixed = normalizeLanes(old);
    expect(fixed.every((l) => Array.isArray(l.chain))).toBe(true);
    // Dan payload-nya bisa dibangun tanpa melempar.
    expect(() =>
      buildExportPayload({ ...studioStore.getState(), lanes: fixed }, noBuffer),
    ).not.toThrow();
  });

  /// Clip punya chain sendiri, terpisah dari lane maupun master — dan hanya
  /// clip yang dituju yang berubah.
  it('chain per-clip terpisah dari lane dan clip lain', () => {
    const l = laneWithTwoClips();
    const [c1, c2] = l.clips;
    if (c1 === undefined || c2 === undefined) throw new Error('butuh dua clip');

    studioActions.addFx(clipTarget(c1.id), 'eq4');
    studioActions.setFxParam(clipTarget(c1.id), 0, 'b1_freq', 300);

    const after = studioStore.getState().lanes.find((x) => x.id === l.id)!;
    expect(after.clips.find((c) => c.id === c1.id)!.chain).toHaveLength(1);
    expect(after.clips.find((c) => c.id === c2.id)!.chain).toHaveLength(0);
    expect(after.chain).toHaveLength(0);
    expect(studioStore.getState().masterChain).toHaveLength(0);
  });

  it('chain per-clip ikut ke payload export', () => {
    const c = laneWithTwoClips().clips[0]!;
    studioActions.addFx(clipTarget(c.id), 'filter');
    studioActions.setFxParam(clipTarget(c.id), 0, 'knob', -0.7);

    const json = JSON.parse(buildExportPayload(studioStore.getState(), withBuffer).payload.json) as {
      lanes: { clips: { id: string; chain: { kind: string; params: Record<string, number> }[] }[] }[];
    };
    const emitted = json.lanes.flatMap((l) => l.clips).find((x) => x.id === c.id);
    expect(emitted?.chain).toHaveLength(1);
    expect(emitted?.chain[0]!.params).toEqual({ knob: -0.7 });
  });

});
