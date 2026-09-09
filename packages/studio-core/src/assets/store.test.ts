/**
 * Registry aset (docs/25 P4) — yang dijaga adalah kontrak yang dulu hidup di
 * `studioStore` dan kini berdiri sendiri: id yang muat `u32`, kunci analisis
 * yang menolak koreksi grid, dan pemberitahuan yang HANYA terjadi saat peta
 * benar-benar berubah (selector berbasis referensi bergantung padanya).
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type { StudioAsset } from './model';
import { assetActions, assetStore } from './store';

const SR = 48_000;

function asset(id: number, over: Partial<StudioAsset> = {}): StudioAsset {
  return {
    id,
    name: `a-${id}`,
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
    ...over,
  };
}

beforeEach(() => assetActions.__resetForTest());

describe('registrasi', () => {
  it('daftar, lalu buang — peta baru tiap perubahan, peta lama utuh', () => {
    const before = assetStore.getState().assets;
    assetActions.registerAsset(asset(1));
    const after = assetStore.getState().assets;
    expect(after).not.toBe(before);
    expect(before[1]).toBeUndefined();
    expect(after[1]?.name).toBe('a-1');

    assetActions.removeAsset(1);
    expect(assetStore.getState().assets[1]).toBeUndefined();
  });

  it('aksi tanpa perubahan TIDAK membangunkan pelanggan', () => {
    assetActions.registerAsset(asset(1));
    let calls = 0;
    const off = assetStore.subscribe(() => (calls += 1));
    assetActions.removeAsset(999);
    assetActions.setAnalysisLock(1, false);
    assetActions.shiftAssetTempoOctave(1, 0);
    assetActions.resetAssetBeatGrid(1);
    expect(calls).toBe(0);
    assetActions.setAnalysisLock(1, true);
    expect(calls).toBe(1);
    off();
  });

  it('newAssetId muat u32 dan tidak menabrak id yang sudah ada', () => {
    assetActions.registerAsset(asset(40));
    const id = assetActions.newAssetId();
    expect(id).toBe(41);
    expect(assetActions.newAssetId()).toBe(42);
    expect(id).toBeLessThanOrEqual(0xffff_ffff);
  });
});

describe('koreksi grid dan kunci analisis', () => {
  it('BPM di-clamp ke rentang grid; offset yang bukan angka jadi null', () => {
    assetActions.registerAsset(asset(1));
    assetActions.setAssetBeatGrid(1, { bpm: 1000, offsetSec: Number.NaN });
    expect(assetStore.getState().assets[1]!.bpmOverride).toBe(300);
    expect(assetStore.getState().assets[1]!.beatOffsetOverride).toBeNull();
  });

  it('terkunci: grid, anchor, dan AUTO ditolak; kuncinya sendiri tetap bisa dibuka', () => {
    assetActions.registerAsset(asset(1, { bpmOverride: 120 }));
    assetActions.setAnalysisLock(1, true);
    assetActions.setAssetBeatGrid(1, { bpm: 90 });
    assetActions.setAssetBeatAnchor(1, { atSec: 10, bpm: 100 });
    assetActions.resetAssetBeatGrid(1);
    assetActions.markAssetTempoPending(1);
    const a = assetStore.getState().assets[1]!;
    expect(a.bpmOverride).toBe(120);
    expect(a.beatAnchors ?? null).toBeNull();
    expect(a.tempoPending).toBe(false);

    assetActions.setAnalysisLock(1, false);
    assetActions.setAssetBeatGrid(1, { bpm: 90 });
    expect(assetStore.getState().assets[1]!.bpmOverride).toBe(90);
  });

  it('anchor di detik yang sama DIGANTI, bukan ditumpuk; hasilnya urut', () => {
    assetActions.registerAsset(asset(1));
    assetActions.setAssetBeatAnchor(1, { atSec: 30, bpm: 128 });
    assetActions.setAssetBeatAnchor(1, { atSec: 10, bpm: 120 });
    assetActions.setAssetBeatAnchor(1, { atSec: 30.0004, bpm: 130 });
    expect(assetStore.getState().assets[1]!.beatAnchors).toEqual([
      { atSec: 10, bpm: 120 },
      { atSec: 30.0004, bpm: 130 },
    ]);
    assetActions.removeAssetBeatAnchorNear(1, 10.2, 0.5);
    expect(assetStore.getState().assets[1]!.beatAnchors).toEqual([{ atSec: 30.0004, bpm: 130 }]);
  });

  it('restoreAssets mengganti seluruh peta dalam satu pemberitahuan', () => {
    assetActions.registerAsset(asset(1));
    const snapshot = assetStore.getState().assets;
    assetActions.registerAsset(asset(2));
    let calls = 0;
    const off = assetStore.subscribe(() => (calls += 1));
    assetActions.restoreAssets(snapshot);
    off();
    expect(calls).toBe(1);
    expect(assetStore.getState().assets).toBe(snapshot);
  });
});
