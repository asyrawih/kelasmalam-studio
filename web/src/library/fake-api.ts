/**
 * `LibraryApi` palsu untuk tes — SATU tempat.
 *
 * Sebelumnya tiap berkas tes menyusun palsuannya sendiri, dan tiap kali
 * antarmuka bertambah satu metode, semuanya merah sekaligus dengan pesan
 * "property X is missing" yang tidak ada hubungannya dengan apa yang sedang
 * diuji. Dengan satu palsuan, metode baru cukup diberi bawaan di sini.
 *
 * Bawaannya sengaja MEMBOSANKAN: berhasil, kosong, tanpa efek. Tes yang peduli
 * pada perilaku tertentu menimpanya sendiri, dan yang ditimpa itulah yang
 * terbaca sebagai maksud tesnya.
 */

import type { InitResult, LibraryApi, ProjectBody, ProjectSummary } from './api';
import type { LibraryTrack, LibraryUser } from './model';

export const FAKE_USER: LibraryUser = { id: 'u1', email: 'a@test', name: 'Ana' };

export function fakeLibraryApi(over: Partial<LibraryApi> = {}): LibraryApi {
  return {
    base: 'https://api.test',
    me: async (): Promise<LibraryUser | null> => FAKE_USER,
    tracks: async (): Promise<readonly LibraryTrack[]> => [],
    blob: async (): Promise<ArrayBuffer> => new ArrayBuffer(8),
    initTrack: async (): Promise<InitResult> => ({
      exists: false,
      uploadUrl: 'https://r2.test/put',
    }),
    putUpload: async (): Promise<void> => {},
    commitTrack: async (): Promise<void> => {},
    projects: async (): Promise<readonly ProjectSummary[]> => [],
    project: async (id: string): Promise<ProjectBody> => ({
      id,
      name: 'Project',
      json: {},
      version: 1,
    }),
    createProject: async (): Promise<{ id: string; version: number }> => ({
      id: 'p1',
      version: 1,
    }),
    updateProject: async (_id, _name, _json, expectedVersion): Promise<number> =>
      expectedVersion + 1,
    deleteProject: async (): Promise<void> => {},
    addProjectTrack: async (): Promise<void> => {},
    removeProjectTrack: async (): Promise<boolean> => false,
    deleteTrack: async (): Promise<void> => {},
    putMarks: async (): Promise<void> => {},
    logout: async (): Promise<void> => {},
    loginUrl: (next: string): string => `https://api.test/auth/google?next=${next}`,
    ...over,
  };
}
