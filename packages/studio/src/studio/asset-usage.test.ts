/**
 * Studio lane MENDAFTARKAN penghitung pemakaian aset ke registry core
 * (docs/25 P4). Halaman `/dj` bertanya lewat `assetUsage(id)` dari core dan
 * tidak tahu lane; kalau pendaftaran ini hilang, penghapusan lagu di `/dj`
 * akan lolos untuk lagu yang masih dipakai clip — persis cacat yang
 * `dj-remove.ts` ada untuk mencegahnya.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type { StudioAsset } from '@kelasmalam/studio-core/assets/model';
import { assetActions } from '@kelasmalam/studio-core/assets/store';
import { assetUsage } from '@kelasmalam/studio-core/assets/usage';
import { DEFAULT_FADE_CURVE, type StudioClip } from './model';
import { laneAssetUsage, studioActions, studioStore } from './store';

const SR = 48_000;

const asset = (id: number): StudioAsset => ({
  id,
  name: `LAGU ${id}`,
  contentHash: '',
  envelope: { frames: SR, levels: [] },
  frames: SR,
  sampleRate: SR,
  tempo: null,
  tempoPending: false,
  tempoOctave: 0,
  bpmOverride: null,
  beatOffsetOverride: null,
  analysisLock: false,
});

const clip = (id: string, assetId: number): StudioClip => ({
  id,
  assetId,
  chain: [],
  start: 0,
  len: SR,
  sourceStart: 0,
  sourceLen: SR,
  label: 'X',
  gainDb: 0,
  fadeInMs: 0,
  fadeOutMs: 0,
  fadeCurve: DEFAULT_FADE_CURVE,
  seed: 1,
});

beforeEach(() => studioActions.__resetForTest('empty'));

describe('pemakaian aset oleh lane', () => {
  it('aset tanpa clip: tidak dipakai', () => {
    assetActions.registerAsset(asset(1));
    expect(assetUsage(1)).toEqual({ count: 0, where: [] });
  });

  it('clip di lane terhitung lewat registry core, dengan nama lane-nya', () => {
    assetActions.registerAsset(asset(1));
    const laneId = studioStore.getState().lanes[0]!.id;
    studioActions.renameLane(laneId, 'LANE UJI');
    studioActions.addClip(laneId, clip('c1', 1));
    studioActions.addClip(laneId, clip('c2', 1));

    expect(assetUsage(1)).toEqual({ count: 2, where: ['LANE UJI'] });
    expect(laneAssetUsage(studioStore.getState(), 1)).toEqual({ count: 2, where: ['LANE UJI'] });
    expect(assetUsage(2).count).toBe(0);
  });

  it('menghapus clip-nya membuat aset bebas dihapus lagi', () => {
    assetActions.registerAsset(asset(1));
    const laneId = studioStore.getState().lanes[0]!.id;
    studioActions.addClip(laneId, clip('c1', 1));
    studioActions.removeClip('c1');
    expect(assetUsage(1).count).toBe(0);
  });
});
