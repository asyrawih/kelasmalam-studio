/**
 * Suite KONTRAK `LibraryApi`: satu daftar janji, DUA implementasi.
 *
 * Janji `LibraryApi` yang harus dipenuhi klien Worker DAN kepustakaan lokal
 * (docs/21 §2d). Tiap tes ditulis sekali dan dijalankan untuk keduanya;
 * yang berbeda hanya cara backend-nya diskrip — `fetch` yang dijawab
 * `Response`, atau `invoke` yang dijawab nilai. Kalau salah satu implementasi
 * berhenti memenuhi kontrak, tes yang gagal menyebut implementasi mana.
 *
 * Berkas ini BUKAN tes (tidak berakhiran `.test.ts`): ia harness yang
 * dipanggil dua tempat — `library.test.ts` (Worker, di app web) dan
 * `apps/desktop/src/library-local/local-api-contract.test.ts` (lokal, di app
 * desktop). Sejak docs/25 P2 implementasi lokal tidak ada di bundel web, jadi
 * tesnya pun tidak bisa tinggal di satu berkas — tapi daftarnya harus tetap
 * SATU, supaya janji yang ditambah untuk yang satu otomatis menagih yang lain.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LibraryError, VersionConflict, type LibraryApi } from './api';
import type { LibraryTrack, LibraryUser } from './model';

export const HASH = 'a'.repeat(64);

export const track = (over: Partial<LibraryTrack> = {}): LibraryTrack => ({
  hash: HASH,
  name: 'Lagu',
  bytes: 1024 * 1024,
  mime: 'audio/mpeg',
  frames: 48_000 * 90,
  sampleRate: 48_000,
  marks: null,
  ...over,
});

export type Step = { readonly kind: 'ok'; readonly value: unknown } | { readonly kind: 'fail'; readonly value: unknown };

/** Skrip jawaban backend, satu per langkah, FIFO. Nama-namanya bahasa kontrak, bukan transport. */
export interface Given {
  user(user: LibraryUser): void;
  tracks(list: readonly LibraryTrack[]): void;
  blob(bytes: Uint8Array): void;
  has(exists: boolean): void;
  ok(): void;
  projects(list: readonly { id: string; name: string; updatedAt: number; version: number }[]): void;
  project(body: { id: string; name: string; json: unknown; version: number; tracks: readonly string[] }): void;
  created(id: string, version: number): void;
  updated(version: number): void;
  conflict(currentVersion: number, message: string): void;
  removed(deletedFromLibrary: boolean): void;
  error(code: string, message: string): void;
}

export interface Backend {
  readonly name: string;
  setup(): void;
  teardown(): void;
  api(): LibraryApi;
  readonly given: Given;
  /** Byte yang sampai ke penyimpanan lewat `putUpload`. */
  uploaded(): readonly number[];
  /** Badan JSON permintaan terakhir yang membawa badan. */
  lastJsonBody(): unknown;
}

export const USER: LibraryUser = { id: 'u1', email: 'a@test', name: 'Ana' };
export const META = { hash: HASH, name: 'Lagu', bytes: 2048, mime: 'audio/mpeg', frames: 480, sampleRate: 48_000 };

export function libraryApiContract(backend: Backend): void {
  describe(`kontrak LibraryApi — ${backend.name}`, () => {
    beforeEach(() => backend.setup());
    afterEach(() => backend.teardown());

    it('me() memberi pemilik kepustakaan dengan id dan nama', async () => {
      backend.given.user(USER);
      const me = await backend.api().me();
      expect(me).not.toBeNull();
      expect(typeof me?.id).toBe('string');
      expect(me?.name.length).toBeGreaterThan(0);
    });

    it('tracks() mempertahankan frames dan marks apa adanya', async () => {
      backend.given.tracks([track({ frames: 0, marks: { cues: { cuePoint: 3 } } })]);
      const list = await backend.api().tracks();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ hash: HASH, frames: 0, marks: { cues: { cuePoint: 3 } } });
    });

    it('blob() memberi byte-nya dan progresnya berakhir di 100', async () => {
      backend.given.blob(new Uint8Array([1, 2, 3, 4]));
      const seen: number[] = [];
      const out = await backend.api().blob(HASH, (p) => seen.push(p));
      expect(out.byteLength).toBe(4);
      expect(seen[seen.length - 1]).toBe(100);
    });

    it('initTrack: sudah ada → tidak ada alamat unggah; belum → ada', async () => {
      backend.given.has(true);
      await expect(backend.api().initTrack(META)).resolves.toEqual({ exists: true, uploadUrl: null });
      backend.given.has(false);
      const init = await backend.api().initTrack(META);
      expect(init.exists).toBe(false);
      expect(typeof init.uploadUrl).toBe('string');
    });

    it('putUpload lalu commitTrack: byte-nya sampai SEKALI, utuh', async () => {
      backend.given.has(false);
      const api = backend.api();
      const init = await api.initTrack(META);
      const seen: number[] = [];
      await api.putUpload(init.uploadUrl!, new ArrayBuffer(2048), 'audio/mpeg', (p) => seen.push(p));
      expect(backend.uploaded()).toEqual([2048]);
      expect(seen[seen.length - 1]).toBe(100);
      backend.given.ok();
      await expect(api.commitTrack(META)).resolves.toBeUndefined();
    });

    it('projects() dan project(id) memberi bentuk yang sama', async () => {
      backend.given.projects([{ id: 'p1', name: 'Mix', updatedAt: 5, version: 2 }]);
      await expect(backend.api().projects()).resolves.toEqual([{ id: 'p1', name: 'Mix', updatedAt: 5, version: 2 }]);
      backend.given.project({ id: 'p1', name: 'Mix', json: { lanes: [] }, version: 2, tracks: [HASH] });
      const body = await backend.api().project('p1');
      expect(body).toMatchObject({ id: 'p1', name: 'Mix', json: { lanes: [] }, version: 2, tracks: [HASH] });
    });

    it('createProject memberi id + versi; updateProject memberi versi baru', async () => {
      backend.given.created('p9', 1);
      await expect(backend.api().createProject('Mix', { a: 1 })).resolves.toEqual({ id: 'p9', version: 1 });
      backend.given.updated(2);
      await expect(backend.api().updateProject('p9', 'Mix', { a: 2 }, 1)).resolves.toBe(2);
    });

    it('kalah versi → VersionConflict yang membawa versi sekarang, bukan LibraryError', async () => {
      backend.given.conflict(5, 'project ini sudah berubah di tempat lain');
      const err = await backend.api().updateProject('p9', 'Mix', {}, 3).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(VersionConflict);
      expect((err as VersionConflict).name).toBe('VersionConflict');
      expect((err as VersionConflict).currentVersion).toBe(5);
      expect((err as Error).message).toMatch(/sudah berubah/);
    });

    it('hapus lagu yang masih dipakai → LibraryError yang MENYEBUT project-nya', async () => {
      backend.given.error('IN_USE', 'masih dipakai project Mix Malam');
      const err = await backend.api().deleteTrack(HASH).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LibraryError);
      expect((err as LibraryError).code).toBe('IN_USE');
      expect((err as Error).message).toContain('Mix Malam');
    });

    it('galat lain membawa kode dan pesan backend apa adanya', async () => {
      backend.given.error('DISK_FULL', 'kepustakaan penuh');
      const err = await backend.api().tracks().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LibraryError);
      expect(err).toMatchObject({ code: 'DISK_FULL', message: 'kepustakaan penuh' });
    });

    it('removeProjectTrack menjawab apakah lagunya ikut hilang dari kepustakaan', async () => {
      backend.given.removed(true);
      await expect(backend.api().removeProjectTrack('p1', HASH)).resolves.toBe(true);
      backend.given.removed(false);
      await expect(backend.api().removeProjectTrack('p1', HASH)).resolves.toBe(false);
    });

    it('putMarks mengirim keadaan LENGKAP, bukan tambalan', async () => {
      backend.given.ok();
      const marks = { cues: { cuePoint: 1 }, grid: { bpm: 120, offsetSec: 0, lock: true } };
      await backend.api().putMarks(HASH, marks);
      expect(JSON.stringify(backend.lastJsonBody())).toContain(JSON.stringify(marks));
    });

    it('addProjectTrack dan deleteProject selesai tanpa isi', async () => {
      backend.given.ok();
      await expect(backend.api().addProjectTrack('p1', HASH)).resolves.toBeUndefined();
      backend.given.ok();
      await expect(backend.api().deleteProject('p1')).resolves.toBeUndefined();
    });
  });
}
