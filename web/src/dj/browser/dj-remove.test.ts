/**
 * Hapus lagu dari kepustakaan.
 *
 * Penjaga terpentingnya bukan "penghapusan berhasil" melainkan **penghapusan
 * yang DITOLAK**: registry asset dipakai bersama `/studio`, dan clip yang
 * menunjuk asset hantu tidak melempar apa pun — ia hanya menggambar placeholder
 * dan diam saat diputar. Penyebabnya terjadi di halaman lain, beberapa menit
 * sebelumnya, jadi praktis tidak bisa dilacak dari layar.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const deleted: number[] = [];
vi.mock('../../studio/persist/db', () => ({
  deleteAsset: (id: number) => {
    deleted.push(id);
    return Promise.resolve(true);
  },
}));

const unregistered: number[] = [];
vi.mock('../../studio/preview/audio-preview', () => ({
  unregisterBuffer: (id: number) => void unregistered.push(id),
}));

import { DEFAULT_FADE_CURVE, type StudioClip, type StudioLane } from '../../studio/model';
import { studioActions, studioStore, type StudioAsset } from '../../studio/store';
import { djActions, djStore } from '../store';
import { inspectRemoval, removeAssetFromLibrary } from './dj-remove';

const SR = 48_000;

const asset = (id: number): StudioAsset =>
  ({
    id,
    name: `LAGU ${id}`,
    envelope: { frames: SR, levels: [{ bucket: 64, min: new Float32Array(1), max: new Float32Array(1), rms: new Float32Array(1) }] },
    frames: SR,
    sampleRate: SR,
    tempo: null,
    tempoPending: false,
    tempoOctave: 0,
    bpmOverride: null,
    beatOffsetOverride: null,
  }) as unknown as StudioAsset;

const clip = (assetId: number): StudioClip => ({
  id: `c${assetId}`,
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

/** Sisipkan lane berisi clip ke store Studio tanpa lewat jalur import. */
function laneWith(assetId: number): StudioLane {
  const lanes = studioStore.getState().lanes;
  const first = lanes[0];
  if (first === undefined) throw new Error('store Studio tanpa lane');
  return { ...first, name: 'LANE UJI', clips: [clip(assetId)] };
}

beforeEach(() => {
  deleted.length = 0;
  unregistered.length = 0;
  djActions.__resetForTest();
  studioActions.__resetForTest?.();
  studioActions.registerAsset(asset(1));
  studioActions.registerAsset(asset(2));
});

describe('menolak yang masih dipakai Studio', () => {
  it('lagu yang dipakai clip TIDAK dihapus, dan alasannya menyebut jumlahnya', async () => {
    studioActions.hydrate({ lanes: [laneWith(1)] });
    const r = await removeAssetFromLibrary(1);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/1 clip/);
    expect(r.reason).toMatch(/LANE UJI/);
    // Dan benar-benar tidak tersentuh: bukan "ditolak lalu dihapus juga".
    expect(studioStore.getState().assets[1]).toBeDefined();
    expect(deleted).toEqual([]);
    expect(unregistered).toEqual([]);
  });

  it('inspectRemoval melaporkan pemakaian tanpa mengubah apa pun', () => {
    studioActions.hydrate({ lanes: [laneWith(1)] });
    const r = inspectRemoval(1);
    expect(r.clips).toBe(1);
    expect(r.lanes).toEqual(['LANE UJI']);
    expect(studioStore.getState().assets[1]).toBeDefined();
  });
});

describe('menghapus yang tidak dipakai', () => {
  it('lenyap dari registry, cache PCM, dan penyimpanan — ketiganya', async () => {
    const r = await removeAssetFromLibrary(2);
    expect(r.ok).toBe(true);
    expect(studioStore.getState().assets[2]).toBeUndefined();
    expect(unregistered).toEqual([2]);
    expect(deleted).toEqual([2]);
    // Lagu lain tidak ikut terbawa.
    expect(studioStore.getState().assets[1]).toBeDefined();
  });

  it('deck yang memegangnya DIKOSONGKAN lebih dulu', async () => {
    djActions.loadDeck('A', { assetId: 2, frames: SR, name: 'LAGU 2', sampleRate: SR });
    expect(inspectRemoval(2).decks).toEqual(['A']);

    await removeAssetFromLibrary(2);
    // Kalau deck dibiarkan memegang assetId yang sudah lenyap, `apply()`
    // berikutnya mencari buffer yang tidak ada dan deck-nya diam tanpa tanda.
    expect(djStore.getState().decks.A.assetId).toBeNull();
  });

  it('cue-nya ikut dilupakan — kalau tidak, ia muncul di lagu lain yang memakai id itu', async () => {
    djActions.loadDeck('A', { assetId: 2, frames: SR, name: 'LAGU 2', sampleRate: SR });
    djActions.setHotCue('A', 'A', 1234);
    expect(djStore.getState().cues[2]).toBeDefined();

    await removeAssetFromLibrary(2);
    expect(djStore.getState().cues[2]).toBeUndefined();
  });

  it('membatalkan pilihan di browser kalau yang dihapus sedang tersorot', async () => {
    djActions.selectBrowseAsset(2);
    await removeAssetFromLibrary(2);
    expect(djStore.getState().browse.selectedAssetId).toBeNull();
  });

  it('menghapus yang sudah tidak ada mengembalikan alasan, bukan melempar', async () => {
    const r = await removeAssetFromLibrary(999);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/sudah tidak ada/);
  });
});
