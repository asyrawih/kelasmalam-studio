/**
 * Tes regresi untuk jebakan retensi asset.
 *
 * Bug yang dijaga: lagu yang diimpor di halaman `/dj` tidak duduk di lane mana
 * pun, sehingga definisi lama "terpakai" (`lanes.flatMap(...)`) tidak
 * melihatnya — dan apa pun yang memangkas atas dasar itu membuang lagu yang
 * sedang duduk di deck. Pemangkas otomatisnya sudah tidak ada, tapi jalur
 * simpan eksplisit menanyakan himpunan yang persis sama, dan jawaban yang
 * kurang di sana berarti lagu yang tidak ikut ter-upload.
 *
 * Sengaja MURNI — tanpa penyimpanan dan tanpa timer. Yang diuji adalah
 * himpunannya.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_FADE_CURVE, type StudioLane } from '../model';
import type { StudioAppState } from '../store';
import { __clearAssetRootsForTest, registerAssetRoot } from './asset-roots';
import { assetsInUse } from './persistence';

const lane = (assetId: number): StudioLane => ({
  id: 'l1',
  name: 'LANE',
  clips: [
    {
      id: 'c1',
      assetId,
      chain: [],
      start: 0,
      len: 100,
      sourceStart: 0,
      sourceLen: 100,
      label: 'X',
      gainDb: 0,
      fadeInMs: 0,
      fadeOutMs: 0,
      fadeCurve: DEFAULT_FADE_CURVE,
      seed: 1,
    },
  ],
  gainDb: 0,
  mute: false,
  solo: false,
  eq: { bands: [] },
  chain: [],
  speedRatio: 1,
  color: '#ffd400',
});

const stateWith = (lanes: StudioLane[]): StudioAppState =>
  ({ lanes }) as unknown as StudioAppState;

afterEach(() => {
  __clearAssetRootsForTest();
});

describe('assetsInUse', () => {
  it('tanpa akar terdaftar, asset yang tidak dipakai clip TIDAK dipertahankan', () => {
    expect(assetsInUse(stateWith([lane(1)]))).toEqual(new Set([1]));
  });

  it('asset yang dipegang akar terdaftar IKUT dipertahankan meski tanpa clip', () => {
    registerAssetRoot(() => [42]);
    const used = assetsInUse(stateWith([lane(1)]));
    expect(used.has(42)).toBe(true);
    expect(used.has(1)).toBe(true);
  });

  it('melepas pendaftaran mengembalikan perilaku semula', () => {
    const off = registerAssetRoot(() => [42]);
    expect(assetsInUse(stateWith([]))).toEqual(new Set([42]));
    off();
    expect(assetsInUse(stateWith([]))).toEqual(new Set());
  });

  it('akar yang melempar tidak mengosongkan keep-set — gagal ke arah MENYIMPAN', () => {
    registerAssetRoot(() => {
      throw new Error('akar rusak');
    });
    registerAssetRoot(() => [7]);
    const used = assetsInUse(stateWith([lane(3)]));
    expect(used.has(7)).toBe(true);
    expect(used.has(3)).toBe(true);
  });
});
