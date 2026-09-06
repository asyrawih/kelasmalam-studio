/**
 * `library.project.save` / `library.project.saveAs` — simpan lewat REGISTRY,
 * bukan lewat tombol (sisa PR #52: ⌘S yang benar-benar menyimpan).
 *
 * Yang dijaga:
 *  - jalur command memakai `saveProject` yang sama dengan tombol: API yang
 *    benar dipanggil, `markSaved` menerima serial PRA-serialisasi, notice
 *    "Tersimpan: <nama>" tampil, dan project yang baru dibuat menjadi yang
 *    terbuka supaya ⌘S berikutnya menimpanya;
 *  - `enabled` jujur: belum masuk (web) → command redup, `runCommand` `false`;
 *  - `studio.project.save` mendelegasikan bila dok hidup, dan jatuh ke
 *    "buka dok" bila tidak.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async () => null,
  isTauri: () => false,
}));

import { LibraryDock } from './LibraryDock';
import { VersionConflict, type LibraryApi } from './api';
import { fakeLibraryApi } from './fake-api';
import { libraryActions, libraryStore } from './store';
import {
  __clearCommandsForTest,
  getCommand,
  isCommandEnabled,
  listCommands,
  runCommand,
} from '../app-shell/command';
import { useCommands } from '../app-shell/useCommands';
import { setPlatformHostForTests } from '../platform';
import { studioCommands } from '../studio/commands';
import { selectProjectDirty, studioActions, studioStore } from '../studio/store';

const HASH = 'a'.repeat(64);
const SR = 48_000;

/** Satu asset + satu clip yang memakainya — cara termurah membuat project "kotor". */
function seedClip(contentHash: string): void {
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

const knownTrack = {
  hash: HASH,
  name: 'Kelas Malam',
  bytes: 1,
  mime: 'audio/mpeg',
  frames: SR,
  sampleRate: SR,
  marks: null,
} as const;

/** Kepustakaan yang sudah masuk dan mengenal satu lagu. */
const api = (over: Partial<LibraryApi> = {}): LibraryApi =>
  fakeLibraryApi({ tracks: async () => [knownTrack], ...over });

async function mount(lib: LibraryApi): Promise<void> {
  render(<LibraryDock api={lib} />);
  await waitFor(() => expect(libraryStore.getState().status).toBe('masuk'));
  await waitFor(() => expect(libraryStore.getState().tracks).toHaveLength(1));
}

const jalankan = async (id: string): Promise<boolean> => {
  let ok = false;
  await act(async () => {
    ok = runCommand(id);
  });
  return ok;
};

const dirty = (): boolean => selectProjectDirty(studioStore.getState());

beforeEach(() => {
  libraryActions.__resetForTest();
  studioActions.__resetForTest();
});
afterEach(() => {
  cleanup();
  __clearCommandsForTest();
  setPlatformHostForTests(null);
  vi.restoreAllMocks();
});

describe('library.project.save', () => {
  it('terdaftar selama dok hidup, bersama saveAs dan toggle — masing-masing sekali', async () => {
    await mount(api());
    const ids = listCommands().map((c) => c.id);
    for (const id of ['library.toggle', 'library.project.save', 'library.project.saveAs']) {
      expect(ids.filter((x) => x === id)).toHaveLength(1);
    }
  });

  it('belum pernah disimpan → membuat project baru dengan nama Studio saat ini, lalu menjadi yang terbuka', async () => {
    const createProject = vi.fn(async (_name: string, _json: unknown) => ({ id: 'p9', version: 1 }));
    const updateProject = vi.fn(async () => 99);
    await mount(api({ createProject, updateProject }));
    seedClip(HASH);
    expect(dirty()).toBe(true);
    const nama = studioStore.getState().projectName;

    expect(await jalankan('library.project.save')).toBe(true);
    await waitFor(() => expect(libraryStore.getState().notice).toBe(`Tersimpan: ${nama} (v1)`));

    expect(createProject).toHaveBeenCalledTimes(1);
    expect(createProject.mock.calls[0]?.[0]).toBe(nama);
    expect(updateProject).not.toHaveBeenCalled();
    expect(libraryStore.getState().openProject).toEqual({ id: 'p9', name: nama, version: 1 });
    // Judul jendela kehilangan `•` lewat mekanisme yang sama dengan tombol.
    expect(dirty()).toBe(false);
  });

  it('project yang terbuka disimpan dengan id + versi If-Match-nya, dan versinya naik', async () => {
    const createProject = vi.fn(async () => ({ id: 'x', version: 1 }));
    const updateProject = vi.fn(async (_id, _name, _json, v: number) => v + 1);
    await mount(api({ createProject, updateProject }));
    libraryActions.setOpenProject({ id: 'p1', name: 'Mix', version: 3 });
    seedClip(HASH);

    expect(await jalankan('library.project.save')).toBe(true);
    await waitFor(() => expect(libraryStore.getState().notice).toBe('Tersimpan: Mix (v4)'));

    expect(createProject).not.toHaveBeenCalled();
    expect(updateProject).toHaveBeenCalledTimes(1);
    const [id, name, json, version] = updateProject.mock.calls[0] ?? [];
    expect([id, name, version]).toEqual(['p1', 'Mix', 3]);
    expect(json).toMatchObject({ projectName: studioStore.getState().projectName });
    expect(libraryStore.getState().openProject).toEqual({ id: 'p1', name: 'Mix', version: 4 });
    expect(dirty()).toBe(false);
  });

  it('markSaved menerima serial PRA-serialisasi — edit selama simpan tetap kotor', async () => {
    let selesai: (v: { id: string; version: number }) => void = () => {};
    const createProject = vi.fn(() => new Promise<{ id: string; version: number }>((r) => (selesai = r)));
    await mount(api({ createProject }));
    seedClip(HASH);
    const serial = studioStore.getState().projectSerial;
    const markSaved = vi.spyOn(studioActions, 'markSaved');

    await jalankan('library.project.save');
    await waitFor(() => expect(createProject).toHaveBeenCalled());
    // Server masih berpikir; user mengedit.
    act(() => studioActions.setMasterGain(-3));
    await act(async () => selesai({ id: 'p2', version: 1 }));

    await waitFor(() => expect(markSaved).toHaveBeenCalledWith(serial));
    expect(dirty()).toBe(true);
  });

  it('lagu yang belum ada di kepustakaan: tidak disimpan, notice menyebut namanya — sama dengan tombol', async () => {
    const createProject = vi.fn(async () => ({ id: 'x', version: 1 }));
    await mount(api({ createProject }));
    seedClip('b'.repeat(64));

    expect(await jalankan('library.project.save')).toBe(true);
    await waitFor(() => expect(libraryStore.getState().notice).toMatch(/Kelas Malam/));
    expect(libraryStore.getState().notice).toMatch(/belum ada di kepustakaan/);
    expect(createProject).not.toHaveBeenCalled();
    expect(dirty()).toBe(true);
  });

  it('kalah versi ditampilkan seperti tombol: pesan server + saran buka ulang', async () => {
    await mount(
      api({
        updateProject: async () => {
          throw new VersionConflict('versi di server sudah 5', 5);
        },
      }),
    );
    libraryActions.setOpenProject({ id: 'p1', name: 'Mix', version: 3 });
    seedClip(HASH);

    await jalankan('library.project.save');
    await waitFor(() => expect(libraryStore.getState().notice).toMatch(/versi di server sudah 5/));
    expect(libraryStore.getState().notice).toMatch(/buka ulang project ini/);
    expect(libraryStore.getState().openProject?.version).toBe(3);
    expect(dirty()).toBe(true);
  });

  it('web belum masuk → command terdaftar tapi REDUP, dan runCommand menjawab false', async () => {
    render(<LibraryDock api={fakeLibraryApi({ me: async () => null })} />);
    await waitFor(() => expect(libraryStore.getState().status).toBe('anonim'));
    const cmd = getCommand('library.project.save');
    expect(cmd).toBeDefined();
    expect(isCommandEnabled(cmd!)).toBe(false);
    expect(await jalankan('library.project.save')).toBe(false);
  });

  it('nama Studio kosong dan kolom nama kosong → dok terbuka, kolom nama fokus', async () => {
    const createProject = vi.fn(async () => ({ id: 'x', version: 1 }));
    await mount(api({ createProject }));
    act(() => studioActions.hydrate({ projectName: '   ' }));

    await jalankan('library.project.save');
    await waitFor(() => expect(libraryStore.getState().collapsed).toBe(false));
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('nama project baru'));
    expect(createProject).not.toHaveBeenCalled();
  });
});

describe('library.project.saveAs', () => {
  it('selalu membuat project baru — dengan nama yang diketik di kolom, lalu kolomnya dikosongkan', async () => {
    const createProject = vi.fn(async (_name: string, _json: unknown) => ({ id: 'p7', version: 1 }));
    const updateProject = vi.fn(async () => 9);
    await mount(api({ createProject, updateProject }));
    libraryActions.setOpenProject({ id: 'p1', name: 'Mix', version: 3 });
    act(() => libraryActions.setCollapsed(false));
    const kolom = await screen.findByLabelText('nama project baru');
    fireEvent.change(kolom, { target: { value: 'Mix v2' } });

    expect(await jalankan('library.project.saveAs')).toBe(true);
    await waitFor(() => expect(libraryStore.getState().notice).toBe('Tersimpan: Mix v2 (v1)'));
    expect(createProject.mock.calls[0]?.[0]).toBe('Mix v2');
    expect(updateProject).not.toHaveBeenCalled();
    expect(libraryStore.getState().openProject).toEqual({ id: 'p7', name: 'Mix v2', version: 1 });
    expect((screen.getByLabelText('nama project baru') as HTMLInputElement).value).toBe('');
  });

  it('project terbuka tanpa nama baru → minta nama, bukan membuat kembaran bernama sama', async () => {
    const createProject = vi.fn(async () => ({ id: 'x', version: 1 }));
    await mount(api({ createProject }));
    libraryActions.setOpenProject({ id: 'p1', name: 'Mix', version: 3 });

    await jalankan('library.project.saveAs');
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('nama project baru'));
    expect(createProject).not.toHaveBeenCalled();
  });
});

describe('studio.project.save (⌘S)', () => {
  it('mendelegasikan ke library.project.save bila dok hidup', async () => {
    const createProject = vi.fn(async () => ({ id: 'p3', version: 1 }));
    render(
      <>
        <StudioHarness />
        <LibraryDock api={api({ createProject })} />
      </>,
    );
    await waitFor(() => expect(libraryStore.getState().status).toBe('masuk'));
    await waitFor(() => expect(libraryStore.getState().tracks).toHaveLength(1));
    seedClip(HASH);

    expect(await jalankan('studio.project.save')).toBe(true);
    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(libraryStore.getState().notice).toMatch(/^Tersimpan: /));
    expect(dirty()).toBe(false);
    // Tidak ada yang meminta dok dibuka: yang diminta adalah simpan, dan itu terjadi.
    expect(libraryStore.getState().collapsed).toBe(true);
  });

  it('jatuh ke "buka dok + fokus" bila dok tidak mendaftarkan', async () => {
    render(<StudioHarness />);
    expect(getCommand('library.project.save')).toBeUndefined();
    expect(await jalankan('studio.project.save')).toBe(true);
    expect(libraryStore.getState().collapsed).toBe(false);
  });

  it('jatuh ke "buka dok" bila dok ada tapi belum masuk — supaya alasannya terlihat', async () => {
    render(
      <>
        <StudioHarness />
        <LibraryDock api={fakeLibraryApi({ me: async () => null })} />
      </>,
    );
    await waitFor(() => expect(libraryStore.getState().status).toBe('anonim'));
    expect(await jalankan('studio.project.save')).toBe(true);
    await waitFor(() => expect(libraryStore.getState().collapsed).toBe(false));
    expect(screen.getByText(/Masuk untuk menyimpan/)).toBeDefined();
  });
});

/** Yang dilakukan `/studio`: daftarkan `studioCommands()` — tanpa dok. */
function StudioHarness(): JSX.Element {
  useCommands(studioCommands());
  return <span data-testid="studio-harness" />;
}
