/**
 * Simpan, buka, dan hapus project (L6 + L7 docs/16).
 *
 * Dua janji yang dijaga paling ketat di sini, karena keduanya berbentuk
 * pekerjaan user yang hilang:
 *
 *  - **Simpan ditolak** kalau ada lagu yang belum ada di kepustakaan. Project
 *    yang menunjuk asset yang tidak ada tidak gagal saat DISIMPAN — ia gagal
 *    saat DIBUKA, berminggu-minggu kemudian, tanpa petunjuk apa yang hilang.
 *  - **Kalah versi diberitahukan**, bukan ditimpa. Dua tab, satu project: yang
 *    belakangan menang diam-diam adalah cara termudah menghapus satu jam kerja
 *    tanpa jejak (§8c).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { hashesIn, saveProject, unsavedAssets } from './projects';
import { VersionConflict, type LibraryApi } from './api';
import { fakeLibraryApi } from './fake-api';
import { libraryActions } from './store';
import { selectProjectDirty, studioActions, studioStore } from '../studio/store';

const HASH = 'a'.repeat(64);
const SR = 48_000;

/** Daftarkan satu asset + satu clip yang memakainya. */
function seedProject(contentHash: string): void {
  studioActions.registerAsset({
    id: 5,
    name: 'Kelas Malam',
    contentHash,
    envelope: { levels: [], frames: 0 },
    frames: SR,
    sampleRate: SR,
    tempo: null,
    tempoPending: false,
    tempoOctave: 0,
    bpmOverride: null,
    beatOffsetOverride: null,
    analysisLock: false,
  } as unknown as Parameters<typeof studioActions.registerAsset>[0]);

  const laneId = studioStore.getState().lanes[0]?.id ?? '';
  studioActions.addClip(laneId, {
    id: 'c1',
    assetId: 5,
    chain: [],
    start: 0,
    len: SR,
    sourceStart: 0,
    sourceLen: SR,
    label: 'C1',
    gainDb: 0,
    fadeInMs: 0,
    fadeOutMs: 0,
    fadeCurve: 'linear',
    seed: 1,
  } as unknown as Parameters<typeof studioActions.addClip>[1]);
}

beforeEach(() => {
  libraryActions.__resetForTest();
  studioActions.__resetForTest?.('empty');
});

describe('penjaga sebelum menyimpan', () => {
  it('menyebut NAMA lagu yang belum ada di kepustakaan, bukan hash-nya', () => {
    seedProject(HASH);
    // Kepustakaan kosong: lagunya belum diunggah.
    expect(unsavedAssets()).toEqual(['Kelas Malam']);
  });

  it('diam kalau semua lagunya sudah ada', () => {
    seedProject(HASH);
    libraryActions.setTracks([
      {
        hash: HASH,
        name: 'Kelas Malam',
        bytes: 1,
        mime: 'audio/mpeg',
        frames: SR,
        sampleRate: SR,
        marks: null,
      },
    ]);
    expect(unsavedAssets()).toEqual([]);
  });

  it('hasil bake ikut disebut — ia tidak akan pernah ada di kepustakaan', () => {
    seedProject('');
    expect(unsavedAssets()).toEqual(['Kelas Malam']);
  });
});

describe('simpan', () => {
  it('project baru dibuat, dan versinya dikembalikan', async () => {
    const createProject = vi.fn(async () => ({ id: 'p9', version: 1 }));
    const api = fakeLibraryApi({ createProject: createProject as unknown as LibraryApi['createProject'] });

    const out = await saveProject(api, { id: null, name: 'Set malam', version: 0 });
    expect(out).toEqual({ ok: true, id: 'p9', version: 1 });
    expect(createProject).toHaveBeenCalledTimes(1);
  });

  it('project yang sudah ada di-PUT dengan versi yang dipegang tab ini', async () => {
    // Tanda tangan eksplisit supaya `mock.calls[0][3]` — versi yang dikirim
    // sebagai If-Match — bisa diperiksa; `vi.fn(async () => …)` menyimpulkan
    // parameternya kosong.
    const updateProject = vi.fn(
      async (_id: string, _name: string, _json: unknown, _expected: number) => 4,
    );
    const api = fakeLibraryApi({
      updateProject: updateProject as unknown as LibraryApi['updateProject'],
    });

    const out = await saveProject(api, { id: 'p9', name: 'Set malam', version: 3 });
    expect(out).toEqual({ ok: true, id: 'p9', version: 4 });
    expect(updateProject.mock.calls[0]?.[3]).toBe(3);
  });

  it('yang dikirim adalah hasil serialize — termasuk hash tiap clip', async () => {
    seedProject(HASH);
    let dikirim: unknown = null;
    const api = fakeLibraryApi({
      createProject: async (_name, json) => {
        dikirim = json;
        return { id: 'p1', version: 1 };
      },
    });

    await saveProject(api, { id: null, name: 'x', version: 0 });
    expect(hashesIn(dikirim)).toEqual([HASH]);
  });

  it('KALAH VERSI ditandai khusus, bukan sekadar "gagal"', async () => {
    const api = fakeLibraryApi({
      updateProject: async () => {
        throw new VersionConflict('project ini sudah berubah di tempat lain', 9);
      },
    });

    const out = await saveProject(api, { id: 'p9', name: 'x', version: 3 });
    expect(out).toMatchObject({ ok: false, conflict: true });
    expect((out as { message: string }).message).toContain('berubah di tempat lain');
  });

  it('kegagalan biasa TIDAK ditandai konflik', async () => {
    const api = fakeLibraryApi({
      updateProject: async () => {
        throw new Error('jaringan putus');
      },
    });
    const out = await saveProject(api, { id: 'p9', name: 'x', version: 3 });
    expect(out).toMatchObject({ ok: false, conflict: false, message: 'jaringan putus' });
  });
});

describe('hashesIn', () => {
  it('menemukan hash di clip maupun di peta grid', () => {
    const json = {
      lanes: [{ clips: [{ contentHash: HASH }] }],
      assetGridsByHash: { ['b'.repeat(64)]: { bpm: 120 } },
    };
    expect([...hashesIn(json)].sort()).toEqual([HASH, 'b'.repeat(64)].sort());
  });

  it('tidak menghitung hash yang sama dua kali', () => {
    const json = { lanes: [{ clips: [{ contentHash: HASH }, { contentHash: HASH }] }] };
    expect(hashesIn(json)).toEqual([HASH]);
  });

  it('mengabaikan string kosong', () => {
    expect(hashesIn({ lanes: [{ clips: [{ contentHash: '' }] }] })).toEqual([]);
  });
});

describe('penanda kotor (docs/21 K2, PR #45 butir 1)', () => {
  const knownTrack = (): void =>
    libraryActions.setTracks([
      { hash: HASH, name: 'Kelas Malam', bytes: 1, mime: 'audio/mpeg', frames: SR, sampleRate: SR, marks: null },
    ]);
  const dirty = (): boolean => selectProjectDirty(studioStore.getState());

  it('simpan yang berhasil menandai project bersih — buat baru maupun timpa', async () => {
    seedProject(HASH);
    knownTrack();
    expect(dirty()).toBe(true);

    const out = await saveProject(fakeLibraryApi(), { id: null, name: 'Mix', version: 0 });
    expect(out.ok).toBe(true);
    expect(dirty()).toBe(false);

    seedProject(HASH); // edit lagi
    expect(dirty()).toBe(true);
    await saveProject(fakeLibraryApi(), { id: 'p1', name: 'Mix', version: 1 });
    expect(dirty()).toBe(false);
  });

  it('edit yang terjadi SELAMA simpan berjalan tetap terhitung belum tersimpan', async () => {
    seedProject(HASH);
    knownTrack();
    let selesai: (v: { id: string; version: number }) => void = () => {};
    const api = fakeLibraryApi({
      createProject: () => new Promise((resolve) => (selesai = resolve)),
    });

    const simpan = saveProject(api, { id: null, name: 'Mix', version: 0 });
    // Server masih berpikir; user menambah clip.
    seedProject(HASH);
    selesai({ id: 'p1', version: 1 });
    await simpan;

    // Serial yang ditandai adalah serial PRA-serialisasi, bukan yang sekarang.
    expect(dirty()).toBe(true);
  });

  it('simpan yang gagal tidak menandai apa pun', async () => {
    seedProject(HASH);
    knownTrack();
    const api = fakeLibraryApi({
      createProject: async () => {
        throw new VersionConflict('kalah', 2);
      },
    });
    const out = await saveProject(api, { id: null, name: 'Mix', version: 0 });
    expect(out.ok).toBe(false);
    expect(dirty()).toBe(true);
  });
});
