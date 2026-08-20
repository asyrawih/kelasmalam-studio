/**
 * L1 docs/16: referensi tersimpan memakai `contentHash`, bukan nomor sesi.
 *
 * Kriteria "done"-nya ditulis begini: *round-trip `serialize`→`deserialize`
 * mempertahankan referensi lewat hash; tes murni, tanpa jaringan.* Yang
 * sebenarnya dijaga lebih tajam dari itu — bug yang ditangkap tes ini berbentuk
 * **project yang menunjuk lagu yang SALAH**: `assetId: 3` hari ini dan
 * `assetId: 3` besok adalah dua lagu berbeda, dan tidak ada satu pun tanda di
 * layar yang membedakannya.
 */

import { describe, expect, it } from 'vitest';

import { relinkLanes, serialize } from './persistence';
import type { StudioAppState } from '../store';
import type { StudioLane } from '../model';

const SR = 48_000;

function clip(id: string, assetId: number): StudioLane['clips'][number] {
  return {
    id,
    assetId,
    chain: [],
    start: 0,
    len: SR,
    sourceStart: 0,
    sourceLen: SR,
    label: id.toUpperCase(),
    gainDb: 0,
    fadeInMs: 0,
    fadeOutMs: 0,
    fadeCurve: 'linear',
    seed: 1,
  } as unknown as StudioLane['clips'][number];
}

function state(over: Partial<StudioAppState> = {}): StudioAppState {
  const lane = { id: 'lane-1', clips: [clip('c1', 7)], chain: [] } as unknown as StudioLane;
  return {
    projectName: 'UJI',
    sampleRate: SR,
    lanes: [lane],
    playhead: 0,
    speed: 1,
    loop: false,
    minDurationSec: 60,
    maxDurationSec: null,
    eqMode: 'off',
    panelOrder: [],
    railOrder: [],
    masterGainDb: 0,
    masterChain: [],
    renderSpeed: 1,
    exportFileName: '',
    selectedLaneId: null,
    selectedClipId: null,
    assets: {
      7: {
        id: 7,
        name: 'Kelas Malam',
        contentHash: 'a'.repeat(64),
        frames: SR,
        sampleRate: SR,
        bpmOverride: 128,
        beatOffsetOverride: null,
        analysisLock: false,
      },
    },
    ...over,
  } as unknown as StudioAppState;
}

const parse = (s: StudioAppState): Record<string, unknown> =>
  JSON.parse(serialize(s)) as Record<string, unknown>;

describe('serialize menulis hash', () => {
  it('tiap clip membawa contentHash asetnya', () => {
    const data = parse(state());
    const lanes = data.lanes as { clips: { assetId: number; contentHash?: string }[] }[];
    expect(lanes[0]?.clips[0]).toMatchObject({ assetId: 7, contentHash: 'a'.repeat(64) });
  });

  it('koreksi grid juga ditulis ber-kunci hash', () => {
    const data = parse(state());
    expect(data.assetGridsByHash).toMatchObject({ ['a'.repeat(64)]: { bpm: 128 } });
  });

  it('asset TANPA hash (hasil bake) tidak dipaksa punya — clip-nya tetap tersimpan', () => {
    const s = state({
      assets: {
        7: {
          id: 7,
          name: 'BAKE',
          contentHash: '',
          frames: SR,
          sampleRate: SR,
          bpmOverride: null,
          beatOffsetOverride: null,
          analysisLock: false,
        },
      } as unknown as StudioAppState['assets'],
    });
    const lanes = parse(s).lanes as { clips: { assetId: number; contentHash?: string }[] }[];

    expect(lanes[0]?.clips[0]?.contentHash).toBeUndefined();
    // Yang tidak boleh terjadi: clip-nya hilang dari project karena asetnya
    // tidak punya identitas yang bertahan.
    expect(lanes[0]?.clips[0]?.assetId).toBe(7);
  });
});

describe('relink saat dibuka kembali', () => {
  const laneOf = (assetId: number, hash?: string): StudioLane =>
    ({
      id: 'lane-1',
      chain: [],
      clips: [hash === undefined ? clip('c1', assetId) : { ...clip('c1', assetId), contentHash: hash }],
    }) as unknown as StudioLane;

  it('clip mengikuti HASH-nya, bukan nomor sesi lamanya', () => {
    // Sesi baru memberi id 42 untuk lagu yang dulu ber-id 7.
    const out = relinkLanes([laneOf(7, 'a'.repeat(64))], new Map([['a'.repeat(64), 42]]));
    expect(out[0]?.clips[0]?.assetId).toBe(42);
  });

  it('contentHash tidak ikut masuk state runtime', () => {
    const out = relinkLanes([laneOf(7, 'a'.repeat(64))], new Map([['a'.repeat(64), 42]]));
    expect('contentHash' in (out[0]?.clips[0] ?? {})).toBe(false);
  });

  it('project LAMA (tanpa hash) tetap memakai assetId-nya', () => {
    const out = relinkLanes([laneOf(7)], new Map([['a'.repeat(64), 42]]));
    expect(out[0]?.clips[0]?.assetId).toBe(7);
  });

  it('hash yang tidak ada di kepustakaan meninggalkan clip BISU, bukan menghapusnya', () => {
    const out = relinkLanes([laneOf(7, 'b'.repeat(64))], new Map([['a'.repeat(64), 42]]));
    // Clip yang lenyap tidak bisa diperbaiki user; yang bisu bisa.
    expect(out[0]?.clips).toHaveLength(1);
    expect(out[0]?.clips[0]?.assetId).toBe(7);
  });

  it('dua clip yang menunjuk lagu yang sama ikut dua-duanya', () => {
    const lane = {
      id: 'lane-1',
      chain: [],
      clips: [
        { ...clip('c1', 7), contentHash: 'a'.repeat(64) },
        { ...clip('c2', 7), contentHash: 'a'.repeat(64) },
      ],
    } as unknown as StudioLane;

    const out = relinkLanes([lane], new Map([['a'.repeat(64), 42]]));
    expect(out[0]?.clips.map((c) => c.assetId)).toEqual([42, 42]);
  });
});
