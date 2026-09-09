/**
 * Hapus lagu dari kepustakaan.
 *
 * Penjaga terpentingnya bukan "penghapusan berhasil" melainkan **penghapusan
 * yang DITOLAK**: registry asset dipakai bersama `/studio`, dan clip yang
 * menunjuk asset hantu tidak melempar apa pun — ia hanya menggambar placeholder
 * dan diam saat diputar. Penyebabnya terjadi di halaman lain, beberapa menit
 * sebelumnya, jadi praktis tidak bisa dilacak dari layar.
 *
 * Sejak docs/25 P4 paket ini tidak tahu lane: pemakaian dijawab lewat registry
 * `assets/usage.ts` core, dan di sini penyedianya dipalsukan. Bahwa Studio
 * benar-benar mendaftarkan penghitung berbasis lane dibuktikan di
 * `packages/studio/src/studio/asset-usage.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioAsset } from '@kelasmalam/studio-core/assets/model';
import { assetActions, assetStore } from '@kelasmalam/studio-core/assets/store';
import { __clearAssetUsageForTest, registerAssetUsage } from '@kelasmalam/studio-core/assets/usage';

const unregistered: number[] = [];
vi.mock('@kelasmalam/studio-core/preview/audio-context', () => ({
  unregisterBuffer: (id: number) => void unregistered.push(id),
}));

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

/** Nyatakan `assetId` dipakai satu clip di lane bernama `LANE UJI`. */
function usedInStudio(assetId: number): void {
  registerAssetUsage((id) => (id === assetId ? { count: 1, where: ['LANE UJI'] } : { count: 0, where: [] }));
}

beforeEach(() => {
  unregistered.length = 0;
  __clearAssetUsageForTest();
  djActions.__resetForTest();
  assetActions.__resetForTest();
  assetActions.registerAsset(asset(1));
  assetActions.registerAsset(asset(2));
});

describe('menolak yang masih dipakai Studio', () => {
  it('lagu yang dipakai clip TIDAK dihapus, dan alasannya menyebut jumlahnya', async () => {
    usedInStudio(1);
    const r = await removeAssetFromLibrary(1);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/1 clip/);
    expect(r.reason).toMatch(/LANE UJI/);
    // Dan benar-benar tidak tersentuh: bukan "ditolak lalu dihapus juga".
    expect(assetStore.getState().assets[1]).toBeDefined();
    expect(unregistered).toEqual([]);
  });

  it('inspectRemoval melaporkan pemakaian tanpa mengubah apa pun', () => {
    usedInStudio(1);
    const r = inspectRemoval(1);
    expect(r.clips).toBe(1);
    expect(r.lanes).toEqual(['LANE UJI']);
    expect(assetStore.getState().assets[1]).toBeDefined();
  });

  it('tanpa penyedia yang terdaftar, tidak ada yang dianggap dipakai', () => {
    expect(inspectRemoval(1).clips).toBe(0);
  });
});

describe('menghapus yang tidak dipakai', () => {
  it('lenyap dari registry DAN dari cache PCM — keduanya', async () => {
    const r = await removeAssetFromLibrary(2);
    expect(r.ok).toBe(true);
    expect(assetStore.getState().assets[2]).toBeUndefined();
    expect(unregistered).toEqual([2]);
    // Lagu lain tidak ikut terbawa.
    expect(assetStore.getState().assets[1]).toBeDefined();
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
