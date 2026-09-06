/**
 * `createLocalLibraryApi` — hal-hal yang KHUSUS lokal, di luar suite kontrak
 * bersama di `library.test.ts`: tidak ada sesi (me() tanpa IPC, logout/login
 * melempar), `uploadUrl` palsu yang dibaca kembali oleh `putUpload`, ekstensi
 * dari MIME, dan terjemahan galat Rust ke kelas yang sudah dikenal pemanggil.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn(async (_cmd: string, _args?: unknown, _opts?: unknown): Promise<unknown> => null);
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown, opts?: unknown) => invoke(cmd, args, opts),
  isTauri: () => false,
}));

import { LibraryError, VersionConflict } from './api';
import { createLocalLibraryApi, extOfMime, LOCAL_USER } from './local-api';

const HASH = 'a'.repeat(64);
const calls = (): string[] => invoke.mock.calls.map(([cmd]) => cmd);

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(null);
});

describe('tanpa sesi', () => {
  it('me() menjawab user LOKAL tanpa satu pun IPC, dan tidak pernah null', async () => {
    const api = createLocalLibraryApi();
    await expect(api.me()).resolves.toEqual(LOCAL_USER);
    expect(LOCAL_USER).toEqual({ id: 'lokal', email: '', name: 'KEPUSTAKAAN LOKAL' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('logout dan loginUrl melempar dengan pesan yang menyebut kenapa', async () => {
    const api = createLocalLibraryApi();
    await expect(api.logout()).rejects.toThrow(/tidak ada akun/);
    expect(() => api.loginUrl('/studio')).toThrow(/tidak ada akun/);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('unggah', () => {
  it('initTrack: ada → uploadUrl null; belum → penanda local:<hash>', async () => {
    const api = createLocalLibraryApi();
    const meta = { hash: HASH, name: 'Lagu', bytes: 10, mime: 'audio/mpeg', frames: 0, sampleRate: 0 };
    invoke.mockResolvedValueOnce(true);
    await expect(api.initTrack(meta)).resolves.toEqual({ exists: true, uploadUrl: null });
    invoke.mockResolvedValueOnce(false);
    await expect(api.initTrack(meta)).resolves.toEqual({ exists: false, uploadUrl: `local:${HASH}` });
    expect(invoke).toHaveBeenCalledWith('library_has', { hash: HASH }, undefined);
  });

  it('putUpload: hash dari url, ext dari MIME, badan mentah + header — lalu progres 100', async () => {
    const api = createLocalLibraryApi();
    const seen: number[] = [];
    await api.putUpload(`local:${HASH}`, new ArrayBuffer(3), 'audio/ogg', (p) => seen.push(p));
    const [cmd, body, opts] = invoke.mock.calls[0]!;
    expect(cmd).toBe('library_put_bytes');
    expect(body).toBeInstanceOf(Uint8Array);
    expect(opts).toEqual({ headers: { 'x-hash': HASH, 'x-ext': 'ogg' } });
    expect(seen).toEqual([100]);
  });

  it('ekstensi mengikuti daftar format kepustakaan — satu sumber dengan MIME_OF_FORMAT', () => {
    expect(extOfMime('audio/mpeg')).toBe('mp3');
    expect(extOfMime('audio/ogg')).toBe('ogg');
    expect(extOfMime('audio/wav')).toBe('wav');
    expect(extOfMime('audio/flac')).toBe('flac');
    expect(extOfMime('audio/mp4')).toBeNull();
  });

  it('MIME yang tidak dikenal dan url yang bukan milik lokal ditolak SEBELUM menyentuh Rust', async () => {
    const api = createLocalLibraryApi();
    await expect(api.putUpload(`local:${HASH}`, new ArrayBuffer(1), 'audio/mp4')).rejects.toThrow(/belum didukung/);
    await expect(api.putUpload('https://r2.test/put', new ArrayBuffer(1), 'audio/mpeg')).rejects.toThrow(
      /bukan milik kepustakaan lokal/,
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it('commitTrack mengirim persis enam field kontrak', async () => {
    const api = createLocalLibraryApi();
    await api.commitTrack({ hash: HASH, name: 'Lagu', bytes: 10, mime: 'audio/wav', frames: 480, sampleRate: 48 });
    expect(invoke).toHaveBeenCalledWith(
      'library_commit',
      { hash: HASH, name: 'Lagu', bytes: 10, mime: 'audio/wav', frames: 480, sampleRate: 48 },
      undefined,
    );
  });
});

describe('galat Rust → kelas yang sudah dikenal pemanggil', () => {
  it('VERSION_CONFLICT → VersionConflict dengan currentVersion', async () => {
    invoke.mockRejectedValueOnce({ code: 'VERSION_CONFLICT', message: 'sudah berubah', currentVersion: 7 });
    const err = await createLocalLibraryApi().updateProject('p', 'n', {}, 3).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VersionConflict);
    expect((err as VersionConflict).name).toBe('VersionConflict');
    expect((err as VersionConflict).currentVersion).toBe(7);
    expect((err as VersionConflict).message).toBe('sudah berubah');
  });

  it('IN_USE saat hapus lagu → LibraryError yang pesannya menyebut project pemakainya', async () => {
    invoke.mockRejectedValueOnce({ code: 'IN_USE', message: 'masih dipakai project Mix Malam', count: 1 });
    const err = await createLocalLibraryApi().deleteTrack(HASH).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LibraryError);
    expect((err as LibraryError).code).toBe('IN_USE');
    expect((err as LibraryError).message).toMatch(/project Mix Malam/);
  });

  it('penolakan tanpa bentuk tetap jadi LibraryError, bukan objek telanjang', async () => {
    invoke.mockRejectedValueOnce('boom');
    const err = await createLocalLibraryApi().tracks().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LibraryError);
    expect((err as LibraryError).code).toBe('IO');
    expect((err as LibraryError).message).toBe('boom');
  });
});

describe('pemetaan lainnya', () => {
  it('tracks() memetakan LocalTrack → LibraryTrack tanpa membawa createdAt', async () => {
    invoke.mockResolvedValueOnce([
      { hash: HASH, name: 'L', bytes: 1, mime: 'audio/mpeg', frames: 2, sampleRate: 3, marks: { cues: {} }, createdAt: 9 },
    ]);
    const [t] = await createLocalLibraryApi().tracks();
    expect(t).toEqual({ hash: HASH, name: 'L', bytes: 1, mime: 'audio/mpeg', frames: 2, sampleRate: 3, marks: { cues: {} } });
  });

  it('blob() melaporkan 100 sekali — disk lokal tidak punya kemajuan yang layak dilaporkan', async () => {
    invoke.mockResolvedValueOnce(new Uint8Array([1, 2]));
    const seen: number[] = [];
    const out = await createLocalLibraryApi().blob(HASH, (p) => seen.push(p));
    expect(out.byteLength).toBe(2);
    expect(seen).toEqual([100]);
  });

  it('createProject memulai folder kosong (tracks: []), sama dengan Worker', async () => {
    invoke.mockResolvedValueOnce({ id: 'p1', version: 1 });
    await expect(createLocalLibraryApi().createProject('Mix', { a: 1 })).resolves.toEqual({ id: 'p1', version: 1 });
    expect(invoke).toHaveBeenCalledWith('library_project_create', { name: 'Mix', json: { a: 1 }, tracks: [] }, undefined);
  });

  it('project/add/remove/delete/marks/importPath/storeInfo memanggil command padanannya', async () => {
    const api = createLocalLibraryApi();
    invoke.mockResolvedValueOnce({ id: 'p1', name: 'Mix', json: {}, version: 2, tracks: [HASH], updatedAt: 1 });
    await expect(api.project('p1')).resolves.toEqual({ id: 'p1', name: 'Mix', json: {}, version: 2, tracks: [HASH] });
    await api.addProjectTrack('p1', HASH);
    invoke.mockResolvedValueOnce(true);
    await expect(api.removeProjectTrack('p1', HASH)).resolves.toBe(true);
    await api.deleteProject('p1');
    await api.putMarks(HASH, { cues: {} });
    invoke.mockResolvedValueOnce({ hash: HASH, name: 'x', bytes: 1, mime: 'audio/wav', frames: 0, sampleRate: 0, marks: null, createdAt: 1, existed: false });
    await expect(api.importPath!('/a/x.wav')).resolves.toMatchObject({ hash: HASH, existed: false });
    invoke.mockResolvedValueOnce({ dir: '/d', bytes: 5, tracks: 1, projects: 0, schemaVersion: 1 });
    await expect(api.storeInfo!()).resolves.toMatchObject({ dir: '/d', bytes: 5 });
    expect(calls()).toEqual([
      'library_project',
      'library_project_add_track',
      'library_project_remove_track',
      'library_project_delete',
      'library_put_marks',
      'library_import_path',
      'store_info',
    ]);
    expect(invoke).toHaveBeenCalledWith('library_project_add_track', { projectId: 'p1', hash: HASH }, undefined);
    expect(invoke).toHaveBeenCalledWith('library_put_marks', { hash: HASH, marks: { cues: {} } }, undefined);
    expect(invoke).toHaveBeenCalledWith('library_import_path', { path: '/a/x.wav' }, undefined);
  });
});
