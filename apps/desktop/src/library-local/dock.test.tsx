/**
 * Dok kepustakaan di DESKTOP: kepustakaan LOKAL (docs/21 K1) lewat host
 * desktop + command Tauri yang di-mock.
 *
 * Dulu dua describe di `apps/web/src/library/dock.test.tsx` dengan
 * `createDesktopHost()`; sejak docs/25 P2 host desktop hanya ada di app ini,
 * jadi tesnya ikut. Komponennya sendiri (`LibraryDock`) dari paket
 * `@kelasmalam/library` — yang diuji di sini adalah apa yang dilakukannya
 * dengan susunan desktop: kepustakaan LOKAL yang didaftarkan lewat
 * `registerLibraryApi` (seperti `main.tsx`), host tanpa `login` (tanpa
 * MASUK/KELUAR), jalur cepat `library_import_path` untuk berkas dari Finder.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn(async (_cmd: string, _args?: unknown, _opts?: unknown): Promise<unknown> => null);
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown, opts?: unknown) => invoke(cmd, args, opts),
}));

import { createDesktopHost } from '../platform/desktop';
import { createLocalLibraryApi } from './local-api';
import { setPlatformHostForTests } from '../platform';
import { registerLibraryApi } from '@kelasmalam/library/library/registry';
import type { LibraryApi } from '@kelasmalam/library/library/api';
import { fakeLibraryApi } from '@kelasmalam/library/library/fake-api';
import { LibraryDock } from '@kelasmalam/library/library/LibraryDock';
import type { LibraryTrack } from '@kelasmalam/library/library/model';
import { libraryActions, libraryStore } from '@kelasmalam/library/library/store';
import { notifyImported } from '@kelasmalam/studio-core/timeline/import-sink';

const HASH = 'a'.repeat(64);

const track = (over: Partial<LibraryTrack> = {}): LibraryTrack => ({
  hash: HASH,
  name: 'Kelas Malam',
  bytes: 3 * 1024 * 1024,
  mime: 'audio/mpeg',
  frames: 48_000 * 187,
  sampleRate: 48_000,
  marks: null,
  ...over,
});

const withTrack = (over: Partial<LibraryApi> = {}): LibraryApi =>
  fakeLibraryApi({ tracks: async () => [track()], ...over });

const strip = (): HTMLElement => screen.getByRole('button', { name: /kepustakaan/i });

beforeEach(() => {
  libraryActions.__resetForTest();
  invoke.mockReset();
  invoke.mockResolvedValue(null);
  // Seperti `main.tsx`: kepustakaan lokal didaftarkan app, bukan dijawab host.
  registerLibraryApi(() => createLocalLibraryApi());
});
afterEach(() => {
  cleanup();
  setPlatformHostForTests(null);
  registerLibraryApi(null);
  vi.restoreAllMocks();
});

describe('host desktop dengan klien Worker yang disuntik', () => {
  it('desktop yang diberi klien Worker tanpa sesi: bukan MASUK yang mati, melainkan satu kalimat jujur', async () => {
    setPlatformHostForTests(createDesktopHost());
    const me = vi.fn(async () => null);
    render(<LibraryDock api={withTrack({ me })} />);
    await waitFor(() => expect(libraryStore.getState().status).toBe('tidak-tersedia'));
    expect(screen.queryByRole('button', { name: /MASUK/ })).toBeNull();
    expect(screen.getByText('TIDAK ADA CARA MASUK')).toBeDefined();
    fireEvent.click(strip());
    expect(screen.getByText(/tidak punya cara masuk/i)).toBeDefined();
    // Bukan "rusak": tidak ada badge merah, tidak ada catatan galat.
    expect(screen.queryByText('TIDAK TERSAMBUNG')).toBeNull();
    expect(libraryStore.getState().error).toBeNull();
  });
});

describe('desktop: kepustakaan LOKAL (docs/21 K1)', () => {
  const localTrack = { ...track(), createdAt: 1 };
  const STORE = { dir: '/Users/ana/Library/Application Support/daw', bytes: 3 * 1024 * 1024, tracks: 1, projects: 0, schemaVersion: 1 };
  const jawab = (extra: (cmd: string, args: unknown) => unknown = () => undefined): void => {
    invoke.mockImplementation(async (cmd, args) => {
      const ex = extra(cmd, args);
      if (ex !== undefined) return ex;
      if (cmd === 'library_tracks') return [localTrack];
      if (cmd === 'library_projects') return [];
      if (cmd === 'store_info') return STORE;
      return null;
    });
  };
  const calls = (): string[] => invoke.mock.calls.map(([cmd]) => cmd);

  it('status masuk sebagai KEPUSTAKAAN LOKAL, tanpa MASUK/KELUAR, dan tidak satu pun HTTP', async () => {
    setPlatformHostForTests(createDesktopHost());
    jawab();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<LibraryDock />);

    await waitFor(() => expect(libraryStore.getState().status).toBe('masuk'));
    expect(libraryStore.getState().user).toEqual({ id: 'lokal', email: '', name: 'KEPUSTAKAAN LOKAL' });
    expect(screen.getByText('KEPUSTAKAAN LOKAL')).toBeDefined();
    expect(screen.queryByRole('button', { name: /MASUK/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'KELUAR' })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();

    await waitFor(() => expect(libraryStore.getState().tracks).toHaveLength(1));
    expect(strip().textContent).toContain('1 LAGU');
    expect(calls()).toEqual(expect.arrayContaining(['library_tracks', 'library_projects', 'store_info']));
  });

  it('folder dan ukuran di disk dari store_info tampil di dok', async () => {
    setPlatformHostForTests(createDesktopHost());
    jawab();
    render(<LibraryDock />);
    await waitFor(() => expect(libraryStore.getState().store).toEqual({ dir: STORE.dir, bytes: STORE.bytes }));
    fireEvent.click(strip());
    const baris = screen.getByTestId('library-store');
    expect(baris.textContent).toContain('3.0 MB');
    expect(baris.textContent).toContain(STORE.dir);
  });

  it('store_info yang gagal tidak meruntuhkan dok — daftarnya tetap tampil', async () => {
    setPlatformHostForTests(createDesktopHost());
    jawab((cmd) => (cmd === 'store_info' ? Promise.reject({ code: 'IO', message: 'x' }) : undefined));
    render(<LibraryDock />);
    await waitFor(() => expect(libraryStore.getState().tracks).toHaveLength(1));
    expect(libraryStore.getState().status).toBe('masuk');
    expect(libraryStore.getState().store).toBeNull();
  });

  it('berkas dari Finder masuk lewat library_import_path — byte-nya TIDAK dikirim balik lewat put_bytes', async () => {
    const host = createDesktopHost();
    const droppedPathFor = vi.fn((name: string, size: number) =>
      name === 'kelas.wav' && size === 4 ? '/Users/ana/Music/kelas.wav' : null,
    );
    setPlatformHostForTests({ ...host, droppedPathFor });
    jawab((cmd) =>
      cmd === 'library_import_path'
        ? { ...localTrack, name: 'kelas.wav', frames: 480, existed: false }
        : undefined,
    );
    render(<LibraryDock />);
    await waitFor(() => expect(libraryStore.getState().status).toBe('masuk'));

    act(() =>
      notifyImported({
        contentHash: HASH,
        assetId: 1,
        name: 'kelas.wav',
        bytes: new ArrayBuffer(4),
        format: 'WAV',
        frames: 480,
        sampleRate: 48_000,
      }),
    );

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('library_import_path', { path: '/Users/ana/Music/kelas.wav' }, undefined),
    );
    await waitFor(() => expect(libraryStore.getState().uploads[HASH]).toBeUndefined());
    expect(droppedPathFor).toHaveBeenCalledWith('kelas.wav', 4);
    expect(calls()).not.toContain('library_put_bytes');
    expect(calls()).not.toContain('library_has');
  });

  it('berkas tanpa path (tempel dari clipboard, URL) tetap lewat has/put_bytes/commit', async () => {
    setPlatformHostForTests({ ...createDesktopHost(), droppedPathFor: () => null });
    jawab((cmd) => (cmd === 'library_has' ? false : undefined));
    render(<LibraryDock />);
    await waitFor(() => expect(libraryStore.getState().status).toBe('masuk'));

    act(() =>
      notifyImported({
        contentHash: 'b'.repeat(64),
        assetId: 2,
        name: 'tempel.mp3',
        bytes: new ArrayBuffer(8),
        format: 'MP3',
        frames: 10,
        sampleRate: 48_000,
      }),
    );
    await waitFor(() => expect(calls()).toContain('library_commit'));
    expect(calls()).not.toContain('library_import_path');
    expect(calls()).toEqual(expect.arrayContaining(['library_has', 'library_put_bytes', 'library_commit']));
  });
});
