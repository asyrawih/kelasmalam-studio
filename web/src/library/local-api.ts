/**
 * `LibraryApi` LOKAL — implementasi kedua di balik antarmuka yang sama
 * (docs/21 §1c, §2c). Dock, `load-track`, `upload`, `projects`, `marks` tidak
 * tahu bedanya: yang di web memanggil Worker, yang di sini memanggil command
 * Tauri, dan bentuk jawabannya sama persis.
 *
 * ## Peta metode → command
 *
 *   me()                → —                     `{ id: 'lokal', name: 'KEPUSTAKAAN LOKAL' }`
 *   tracks()            → library_tracks
 *   blob()              → library_blob          biner mentah; `onProgress(100)` sekali
 *   initTrack()         → library_has           `uploadUrl` = `local:<hash>`, hanya penanda
 *   putUpload()         → library_put_bytes     ext dari MIME; `url` cuma dicek bentuknya
 *   commitTrack()       → library_commit
 *   projects/project    → library_projects / library_project
 *   createProject()     → library_project_create   `tracks: []` — folder mulai kosong,
 *                                                  sama dengan Worker (anggota folder ≠ clip)
 *   updateProject()     → library_project_update   VERSION_CONFLICT → `VersionConflict`
 *   deleteProject()     → library_project_delete
 *   add/removeProjectTrack → library_project_add_track / _remove_track
 *   deleteTrack()       → library_delete_track  IN_USE menyebut project pemakainya
 *   putMarks()          → library_put_marks
 *   importPath()        → library_import_path   jalur cepat drop Finder (khusus lokal)
 *   storeInfo()         → store_info            (khusus lokal)
 *   logout/loginUrl     → MELEMPAR — tidak ada sesi; `PlatformHost.login` tidak ada
 *                          di desktop (PR #46), jadi dok tidak pernah memanggilnya.
 *
 * ## Galat
 *
 * `LocalError` dari Rust diterjemahkan ke `LibraryError(code, message)` —
 * kelas yang sama yang dilempar klien Worker, jadi pemanggil yang sudah
 * menangani `LibraryError` tidak perlu cabang baru. Satu-satunya pengecualian
 * `VERSION_CONFLICT`, yang jadi `VersionConflict` persis seperti HTTP 412:
 * kalah versi butuh KEPUTUSAN user, bukan pesan merah.
 */

import { MIME_OF_FORMAT } from '../studio/timeline/content-hash';
import type { ImportedTrack, LocalTrack, StoreInfo } from '../platform/local-commands';
import { callLocal, putLocalBytes, toLocalError } from '../platform/local-invoke';
import {
  LibraryError,
  VersionConflict,
  type InitResult,
  type LibraryApi,
  type ProjectBody,
  type ProjectSummary,
  type TrackMeta,
} from './api';
import type { LibraryTrack, LibraryUser } from './model';

export const LOCAL_USER: LibraryUser = { id: 'lokal', email: '', name: 'KEPUSTAKAAN LOKAL' };

/** Awalan `uploadUrl` palsu: `initTrack` memberinya, `putUpload` membacanya kembali. */
export const LOCAL_UPLOAD_PREFIX = 'local:';

/**
 * Ekstensi berkas di `tracks/<hash>.<ext>` dari MIME yang dikirim jalur unggah.
 * Kebalikan `MIME_OF_FORMAT`, supaya daftar format yang bisa masuk kepustakaan
 * hidup di SATU tempat — yang di sini cuma cara membacanya terbalik.
 */
const EXT_OF_MIME: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(MIME_OF_FORMAT).map(([format, mime]) => [mime, format.toLowerCase()]),
);

export function extOfMime(mime: string): string | null {
  return EXT_OF_MIME[mime] ?? null;
}

function toTrack(t: LocalTrack): LibraryTrack {
  return {
    hash: t.hash,
    name: t.name,
    bytes: t.bytes,
    mime: t.mime,
    frames: t.frames,
    sampleRate: t.sampleRate,
    marks: t.marks,
  };
}

/** Bungkus satu panggilan: `LocalError` → `LibraryError` (atau `VersionConflict`). */
async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (reason: unknown) {
    const err = toLocalError(reason);
    if (err.code === 'VERSION_CONFLICT') {
      throw new VersionConflict(err.message, err.currentVersion ?? null);
    }
    throw new LibraryError(err.code, err.message);
  }
}

function tidakAdaSesi(apa: string): never {
  throw new LibraryError(
    'TIDAK_ADA_SESI',
    `${apa} tidak ada di kepustakaan lokal: tidak ada akun, semua data ada di mesin ini`,
  );
}

export function createLocalLibraryApi(): LibraryApi {
  return {
    base: LOCAL_UPLOAD_PREFIX,

    async me(): Promise<LibraryUser | null> {
      // Tidak pernah `null`: "belum login" bukan keadaan yang ada di sini.
      return LOCAL_USER;
    },

    tracks(): Promise<readonly LibraryTrack[]> {
      return guarded(async () => (await callLocal('library_tracks', {})).map(toTrack));
    },

    blob(hash, onProgress): Promise<ArrayBuffer> {
      return guarded(async () => {
        const bytes = await callLocal('library_blob', { hash });
        // Disk lokal: tidak ada yang layak dilaporkan bertahap, tapi pemanggil
        // yang menunggu angka 100 untuk membersihkan bar-nya tetap mendapatnya.
        onProgress?.(100);
        return bytes;
      });
    },

    initTrack(meta): Promise<InitResult> {
      return guarded(async () => {
        const exists = await callLocal('library_has', { hash: meta.hash });
        return { exists, uploadUrl: exists ? null : LOCAL_UPLOAD_PREFIX + meta.hash };
      });
    },

    putUpload(uploadUrl, bytes, mime, onProgress): Promise<void> {
      return guarded(async () => {
        if (!uploadUrl.startsWith(LOCAL_UPLOAD_PREFIX)) {
          throw new LibraryError('INVALID', `alamat unggah ${uploadUrl} bukan milik kepustakaan lokal`);
        }
        const ext = extOfMime(mime);
        if (ext === null) {
          throw new LibraryError('INVALID', `jenis ${mime} belum didukung kepustakaan`);
        }
        await putLocalBytes(uploadUrl.slice(LOCAL_UPLOAD_PREFIX.length), ext, bytes);
        onProgress?.(100);
      });
    },

    commitTrack(meta: TrackMeta): Promise<void> {
      return guarded(async () => {
        await callLocal('library_commit', {
          hash: meta.hash,
          name: meta.name,
          bytes: meta.bytes,
          mime: meta.mime,
          frames: meta.frames,
          sampleRate: meta.sampleRate,
        });
      });
    },

    projects(): Promise<readonly ProjectSummary[]> {
      return guarded(() => callLocal('library_projects', {}));
    },

    project(id): Promise<ProjectBody> {
      return guarded(async () => {
        const body = await callLocal('library_project', { id });
        return { id: body.id, name: body.name, json: body.json, version: body.version, tracks: body.tracks };
      });
    },

    createProject(name, json): Promise<{ id: string; version: number }> {
      return guarded(() => callLocal('library_project_create', { name, json, tracks: [] }));
    },

    updateProject(id, name, json, expectedVersion): Promise<number> {
      return guarded(() => callLocal('library_project_update', { id, name, json, expectedVersion }));
    },

    deleteProject(id): Promise<void> {
      return guarded(async () => {
        await callLocal('library_project_delete', { id });
      });
    },

    addProjectTrack(projectId, hash): Promise<void> {
      return guarded(async () => {
        await callLocal('library_project_add_track', { projectId, hash });
      });
    },

    removeProjectTrack(projectId, hash): Promise<boolean> {
      return guarded(() => callLocal('library_project_remove_track', { projectId, hash }));
    },

    deleteTrack(hash): Promise<void> {
      return guarded(async () => {
        // `IN_USE` sudah membawa nama project pemakainya di `message` (kontrak
        // `library_delete_track`); `guarded` meneruskannya apa adanya.
        await callLocal('library_delete_track', { hash });
      });
    },

    putMarks(hash, marks): Promise<void> {
      return guarded(async () => {
        await callLocal('library_put_marks', { hash, marks });
      });
    },

    async logout(): Promise<void> {
      tidakAdaSesi('keluar');
    },

    loginUrl(): string {
      return tidakAdaSesi('masuk');
    },

    importPath(path): Promise<ImportedTrack> {
      return guarded(() => callLocal('library_import_path', { path }));
    },

    storeInfo(): Promise<StoreInfo> {
      return guarded(() => callLocal('store_info', {}));
    },
  };
}
