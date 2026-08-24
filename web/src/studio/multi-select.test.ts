/**
 * Seleksi banyak clip: himpunan, invariannya, dan aksi massal.
 *
 * Yang dijaga di sini terutama INVARIAN — bagian yang tidak terlihat dari layar
 * sampai ia rusak: primer harus selalu anggota himpunan, id yang clip-nya sudah
 * dihapus harus lenyap, dan project lama yang cuma punya `selectedClipId` harus
 * tetap menghasilkan seleksi yang sah tanpa migrasi apa pun.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { studioActions, studioStore } from '../studio/store';
import { DEFAULT_FADE_CURVE, type StudioClip } from '../studio/model';

const SR = 48_000;

function clip(id: string, startSec: number, lenSec = 2): StudioClip {
  return {
    id,
    assetId: 1,
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
    chain: [],
  };
}

function laneIds(): string[] {
  return studioStore.getState().lanes.map((l) => l.id);
}

function clipsOf(laneIndex: number): StudioClip[] {
  return studioStore.getState().lanes[laneIndex]!.clips;
}

function ids(): readonly string[] {
  return studioStore.getState().selectedClipIds;
}

/** Dua lane: A/B di lane 0, C di lane 1. */
beforeEach(() => {
  studioActions.__resetForTest('empty');
  if (studioStore.getState().lanes.length < 2) studioActions.addLane();
  const [l0, l1] = laneIds();
  studioActions.addClip(l0!, clip('a', 0));
  studioActions.addClip(l0!, clip('b', 10));
  studioActions.addClip(l1!, clip('c', 4));
  studioActions.clearClipSelection();
});

describe('himpunan seleksi', () => {
  it('clip yang baru ditambahkan menjadi satu-satunya seleksi yang konsisten', () => {
    studioActions.selectClip('a');
    studioActions.toggleClipSelection('b');
    const lane = laneIds()[1]!;
    studioActions.addClip(lane, clip('baru', 20, 11 * 60));

    const s = studioStore.getState();
    expect(s.selectedClipId).toBe('baru');
    expect(s.selectedClipIds).toEqual(['baru']);
    expect(s.selectedLaneId).toBe(lane);
  });

  it('klik biasa memilih satu dan membuang sisanya', () => {
    studioActions.setSelectedClips(['a', 'b', 'c']);
    studioActions.selectClip('b');
    expect(ids()).toEqual(['b']);
    expect(studioStore.getState().selectedClipId).toBe('b');
  });

  it('toggle menambah lalu membuang', () => {
    studioActions.selectClip('a');
    studioActions.toggleClipSelection('c');
    expect([...ids()].sort()).toEqual(['a', 'c']);
    studioActions.toggleClipSelection('c');
    expect(ids()).toEqual(['a']);
  });

  it('membuang clip PRIMER tidak mengosongkan seleksi', () => {
    studioActions.setSelectedClips(['a', 'b'], 'b');
    studioActions.toggleClipSelection('b');
    expect(ids()).toEqual(['a']);
    // Primer pindah ke sisa yang masih terpilih, bukan jadi null.
    expect(studioStore.getState().selectedClipId).toBe('a');
  });

  it('primer selalu anggota himpunan', () => {
    studioActions.setSelectedClips(['a', 'b'], 'c');
    const s = studioStore.getState();
    expect(s.selectedClipIds).toContain(s.selectedClipId);
  });

  it('id yang clip-nya dihapus lenyap dari seleksi', () => {
    studioActions.setSelectedClips(['a', 'b', 'c']);
    studioActions.removeClip('b');
    expect([...ids()].sort()).toEqual(['a', 'c']);
  });

  it('project lama yang hanya punya selectedClipId tetap sah', () => {
    studioActions.hydrate({ selectedClipId: 'b' } as never);
    expect(ids()).toEqual(['b']);
  });

  it('himpunan yang isinya sama mengembalikan array LAMA (stabil secara referensi)', () => {
    studioActions.setSelectedClips(['a', 'b']);
    const first = ids();
    studioActions.setSelectedClips(['a', 'b']);
    expect(ids()).toBe(first);
  });
});

describe('geser banyak clip', () => {
  it('seluruh rombongan bergeser dengan selisih yang sama', () => {
    const origins = [
      { id: 'a', start: 0, laneIndex: 0 },
      { id: 'b', start: 10 * SR, laneIndex: 0 },
    ];
    studioActions.moveClips(origins, 3 * SR, 0);
    expect(clipsOf(0).map((c) => c.start)).toEqual([3 * SR, 13 * SR]);
  });

  it('bisa pindah lane bersama-sama', () => {
    studioActions.moveClips([{ id: 'a', start: 0, laneIndex: 0 }], 0, 1);
    expect(clipsOf(0).map((c) => c.id)).toEqual(['b']);
    expect(clipsOf(1).map((c) => c.id).sort()).toEqual(['a', 'c']);
  });

  it('selisih di-clamp SEKALI untuk seluruh rombongan, bukan per clip', () => {
    const origins = [
      { id: 'a', start: 0, laneIndex: 0 },
      { id: 'b', start: 10 * SR, laneIndex: 0 },
    ];
    // Ditarik jauh ke kiri: `a` menabrak nol, tapi jarak keduanya HARUS tetap
    // 10 detik. Kalau tiap clip dijepit sendiri, susunannya berubah bentuk.
    studioActions.moveClips(origins, -50 * SR, 0);
    const starts = clipsOf(0).map((c) => c.start);
    expect(starts).toEqual([0, 10 * SR]);
  });

  it('lane di-clamp bersama juga', () => {
    const origins = [
      { id: 'a', start: 0, laneIndex: 0 },
      { id: 'c', start: 4 * SR, laneIndex: 1 },
    ];
    // `c` sudah di lane terakhir, jadi rombongan tidak bisa turun sama sekali.
    // Yang dijaga: `a` TIDAK ikut turun sendirian meninggalkan `c` — susunan
    // antar lane harus tetap seperti saat diambil.
    studioActions.moveClips(origins, 0, 5);
    expect(clipsOf(0).map((c) => c.id).sort()).toEqual(['a', 'b']);
    expect(clipsOf(1).map((c) => c.id)).toEqual(['c']);
  });

  it('origins kosong tidak mengubah apa pun', () => {
    const before = studioStore.getState().lanes;
    studioActions.moveClips([], 5 * SR, 1);
    expect(studioStore.getState().lanes).toBe(before);
  });
});

describe('hapus, salin, tempel massal', () => {
  it('X menghapus SEMUA yang terpilih', () => {
    studioActions.setSelectedClips(['a', 'c']);
    studioActions.deleteSelectedClip();
    expect(clipsOf(0).map((c) => c.id)).toEqual(['b']);
    expect(clipsOf(1)).toHaveLength(0);
    expect(ids()).toEqual([]);
  });

  it('copy/paste mempertahankan jarak antar clip DAN antar lane', () => {
    studioActions.setSelectedClips(['a', 'c']); // lane 0 @0 s, lane 1 @4 s
    studioActions.copySelectedClip();
    studioActions.selectLane(laneIds()[0]!);
    studioActions.setPlayhead(20 * SR);
    studioActions.pasteClipboard();

    const pasted0 = clipsOf(0).filter((c) => c.start >= 20 * SR);
    const pasted1 = clipsOf(1).filter((c) => c.start >= 20 * SR);
    expect(pasted0).toHaveLength(1);
    expect(pasted1).toHaveLength(1);
    expect(pasted0[0]!.start).toBe(20 * SR);
    expect(pasted1[0]!.start).toBe(24 * SR); // selisih 4 detik dipertahankan
  });

  it('hasil paste jadi seleksi yang baru', () => {
    studioActions.setSelectedClips(['a', 'b']);
    studioActions.copySelectedClip();
    studioActions.setPlayhead(30 * SR);
    studioActions.pasteClipboard();
    expect(ids()).toHaveLength(2);
    expect(ids()).not.toContain('a');
  });

  it('paste yang melewati lane terakhir DIJEPIT, bukan dibuang', () => {
    studioActions.setSelectedClips(['a', 'c']);
    studioActions.copySelectedClip();
    studioActions.selectLane(laneIds()[1]!); // mulai dari lane terakhir
    studioActions.setPlayhead(40 * SR);
    studioActions.pasteClipboard();
    // Dua-duanya tetap ada, keduanya mendarat di lane terakhir.
    expect(clipsOf(1).filter((c) => c.start >= 40 * SR)).toHaveLength(2);
  });

  it('copy tanpa seleksi tidak menyentuh papan salin', () => {
    studioActions.clearClipSelection();
    studioActions.copySelectedClip();
    expect(studioStore.getState().clipboard).toBeNull();
  });
});
