/**
 * Klien Worker kepustakaan. URL, header, dan penerjemahan balasan — tidak lebih.
 *
 * ## `credentials: 'include'` di SETIAP permintaan
 *
 * Sesi hidup di cookie `__Host-lib_session` yang dipasang Worker, dan app ada
 * di origin yang berbeda. Tanpa `include`, `fetch` tidak mengirim cookie itu
 * sama sekali dan SEMUA panggilan menjawab 401 — dengan app yang tampak
 * "selalu logout" tanpa satu pun pesan yang menyebut cookie.
 *
 * Ini juga sebabnya API harus di subdomain domain yang sama dengan app
 * (docs/16 §5b): sama-site membuat cookie `SameSite=Lax` ikut terkirim, tanpa
 * bergantung pada cookie pihak ketiga yang sedang dimatikan browser.
 *
 * ## Login lewat NAVIGASI, bukan fetch
 *
 * `/auth/google` membalas 302 ke layar consent Google. Mengambilnya dengan
 * `fetch` berarti mengambil halaman Google ke dalam JavaScript — yang tidak
 * pernah berhasil dan memang tidak seharusnya. Yang benar: pindahkan seluruh
 * tab ke sana, dan biarkan Google mengembalikannya.
 */

import type { LibraryTrack, LibraryUser } from './model';

export class LibraryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'LibraryError';
    this.code = code;
  }
}

export interface InitResult {
  /** `true` = byte-nya sudah ada di R2; tidak ada yang perlu naik. */
  readonly exists: boolean;
  readonly uploadUrl: string | null;
}

export interface TrackMeta {
  readonly hash: string;
  readonly name: string;
  readonly bytes: number;
  readonly mime: string;
  readonly frames: number;
  readonly sampleRate: number;
}

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly updatedAt: number;
  readonly version: number;
}

export interface ProjectBody {
  readonly id: string;
  readonly name: string;
  /** Isi `serialize()`, sudah terurai. Server tidak menafsirkannya. */
  readonly json: unknown;
  readonly version: number;
  /** Lagu anggota folder project, terpisah dari clip timeline. */
  readonly tracks?: readonly string[];
}

/** Kalah versi: ada yang menyimpan project ini di tempat lain (docs/16 §8c). */
export class VersionConflict extends Error {
  readonly currentVersion: number | null;
  constructor(message: string, currentVersion: number | null) {
    super(message);
    this.name = 'VersionConflict';
    this.currentVersion = currentVersion;
  }
}

export interface LibraryApi {
  readonly base: string;
  /** `null` = belum login (401). Melempar untuk kegagalan lain. */
  me(): Promise<LibraryUser | null>;
  tracks(): Promise<readonly LibraryTrack[]>;
  /** Byte lagu, dengan laporan kemajuan 0..100. */
  blob(hash: string, onProgress?: (percent: number) => void): Promise<ArrayBuffer>;
  /** Tanya perlu-tidaknya mengunggah. Inti dedup docs/16 §6. */
  initTrack(meta: TrackMeta): Promise<InitResult>;
  /** PUT langsung ke R2 lewat URL bertanda tangan, dengan progres. */
  putUpload(
    uploadUrl: string,
    bytes: ArrayBuffer,
    mime: string,
    onProgress?: (percent: number) => void,
  ): Promise<void>;
  /** Catat klaim sesudah byte-nya ada. */
  commitTrack(meta: TrackMeta): Promise<void>;
  projects(): Promise<readonly ProjectSummary[]>;
  project(id: string): Promise<ProjectBody>;
  createProject(name: string, json: unknown): Promise<{ id: string; version: number }>;
  /** Melempar `VersionConflict` kalau versinya sudah berubah di tempat lain. */
  updateProject(id: string, name: string, json: unknown, expectedVersion: number): Promise<number>;
  deleteProject(id: string): Promise<void>;
  addProjectTrack(projectId: string, hash: string): Promise<void>;
  removeProjectTrack(projectId: string, hash: string): Promise<void>;
  /** Melempar dengan pesan yang menyebut project pemakainya kalau ditolak. */
  deleteTrack(hash: string): Promise<void>;
  /** Cue DJ + koreksi grid satu lagu. Selalu keadaan LENGKAP, bukan tambalan. */
  putMarks(hash: string, marks: unknown): Promise<void>;
  logout(): Promise<void>;
  /** URL yang harus dibuka sebagai NAVIGASI, bukan di-fetch. */
  loginUrl(nextPath: string): string;
}

export function normalizeBase(base: string): string {
  return base.replace(/\/+$/, '');
}

export function createLibraryApi(baseUrl: string, fetchImpl: typeof fetch = fetch): LibraryApi {
  const base = normalizeBase(baseUrl);

  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const res = await fetchImpl(`${base}${path}`, { credentials: 'include', ...init });
    return res;
  };

  const readError = async (res: Response): Promise<LibraryError> => {
    try {
      const body = (await res.json()) as { code?: unknown; message?: unknown };
      return new LibraryError(
        typeof body.code === 'string' ? body.code : `HTTP_${res.status}`,
        typeof body.message === 'string' ? body.message : `server menjawab ${res.status}`,
      );
    } catch {
      return new LibraryError(`HTTP_${res.status}`, `server menjawab ${res.status}`);
    }
  };

  return {
    base,

    async me(): Promise<LibraryUser | null> {
      const res = await call('/me');
      // 401 adalah JAWABAN, bukan kegagalan: "belum login" adalah keadaan yang
      // sah dan seluruh aplikasi tetap berjalan penuh tanpanya (docs/16 §6).
      if (res.status === 401) return null;
      if (!res.ok) throw await readError(res);
      return (await res.json()) as LibraryUser;
    },

    async tracks(): Promise<readonly LibraryTrack[]> {
      const res = await call('/tracks');
      if (!res.ok) throw await readError(res);
      const body = (await res.json()) as { tracks?: readonly LibraryTrack[] };
      return body.tracks ?? [];
    },

    async blob(hash, onProgress): Promise<ArrayBuffer> {
      const res = await call(`/tracks/${hash}/blob`);
      if (!res.ok) throw await readError(res);

      const total = Number(res.headers.get('content-length') ?? 0);
      const body = res.body;
      // Tanpa `body` yang bisa dibaca bertahap (jsdom, proxy tertentu), unduh
      // tetap jalan — yang hilang hanya bar progresnya, bukan lagunya.
      if (body === null || onProgress === undefined || total <= 0) {
        return await res.arrayBuffer();
      }

      const reader = body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined) {
          chunks.push(value);
          received += value.byteLength;
          onProgress(Math.min(100, Math.round((received / total) * 100)));
        }
      }

      const out = new Uint8Array(received);
      let at = 0;
      for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.byteLength;
      }
      return out.buffer;
    },

    async initTrack(meta): Promise<InitResult> {
      const res = await call('/tracks/init', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          hash: meta.hash,
          name: meta.name,
          bytes: meta.bytes,
          mime: meta.mime,
        }),
      });
      if (!res.ok) throw await readError(res);
      const body = (await res.json()) as { exists?: unknown; uploadUrl?: unknown };
      return {
        exists: body.exists === true,
        uploadUrl: typeof body.uploadUrl === 'string' ? body.uploadUrl : null,
      };
    },

    putUpload(uploadUrl, bytes, mime, onProgress): Promise<void> {
      /*
       * XHR, bukan fetch — alasan yang sama dengan unggah Roblox: `fetch` tidak
       * melaporkan kemajuan pengiriman BADAN permintaan, dan ini justru
       * permintaan terbesar yang pernah dikirim aplikasi ini (puluhan MB).
       *
       * Juga: TANPA `credentials`. URL-nya sudah membawa tanda tangannya
       * sendiri dan tujuannya R2, bukan Worker kami — mengirim cookie sesi ke
       * sana tidak berguna dan hanya memperluas tempat ia bisa bocor.
       */
      return new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', uploadUrl);
        xhr.setRequestHeader('content-type', mime);

        xhr.upload.onprogress = (e: ProgressEvent): void => {
          if (!e.lengthComputable || e.total === 0) return;
          onProgress?.(Math.round((e.loaded / e.total) * 100));
        };
        xhr.onerror = (): void =>
          reject(new LibraryError('JARINGAN', 'tidak bisa mengunggah ke penyimpanan'));
        xhr.ontimeout = (): void =>
          reject(new LibraryError('WAKTU_HABIS', 'penyimpanan tidak menjawab'));
        xhr.onload = (): void => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
            return;
          }
          /*
           * Kegagalan di sini datang dari R2, bukan dari Worker kami, jadi
           * badannya XML S3 — bukan `{code,message}`. Status 403 hampir selalu
           * berarti URL-nya kedaluwarsa (15 menit) atau jam mesin melenceng;
           * itu disebut, karena badan XML-nya tidak akan menyebutnya.
           */
          const sebab =
            xhr.status === 403
              ? 'izin unggah ditolak — URL-nya mungkin sudah kedaluwarsa, coba lagi'
              : `penyimpanan menolak unggahan (HTTP ${xhr.status})`;
          reject(new LibraryError(`HTTP_${xhr.status}`, sebab));
        };
        xhr.send(bytes);
      });
    },

    async commitTrack(meta): Promise<void> {
      const res = await call('/tracks/commit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(meta),
      });
      if (!res.ok) throw await readError(res);
    },

    async projects(): Promise<readonly ProjectSummary[]> {
      const res = await call('/projects');
      if (!res.ok) throw await readError(res);
      const body = (await res.json()) as { projects?: readonly ProjectSummary[] };
      return body.projects ?? [];
    },

    async project(id): Promise<ProjectBody> {
      const res = await call(`/projects/${encodeURIComponent(id)}`);
      if (!res.ok) throw await readError(res);
      return (await res.json()) as ProjectBody;
    },

    async createProject(name, json): Promise<{ id: string; version: number }> {
      const res = await call('/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, json }),
      });
      if (!res.ok) throw await readError(res);
      return (await res.json()) as { id: string; version: number };
    },

    async updateProject(id, name, json, expectedVersion): Promise<number> {
      const res = await call(`/projects/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'if-match': `"${expectedVersion}"` },
        body: JSON.stringify({ name, json }),
      });
      if (res.status === 412) {
        /*
         * Kalah versi bukan galat biasa — ia butuh KEPUTUSAN user, bukan
         * sekadar pesan merah. Karena itu tipenya sendiri: pemanggil yang lupa
         * menanganinya akan terlihat, alih-alih menampilkan "gagal menyimpan"
         * untuk sesuatu yang sebenarnya bisa diselamatkan.
         */
        const body = (await res.json()) as { message?: unknown; currentVersion?: unknown };
        throw new VersionConflict(
          typeof body.message === 'string'
            ? body.message
            : 'project ini sudah berubah di tempat lain',
          typeof body.currentVersion === 'number' ? body.currentVersion : null,
        );
      }
      if (!res.ok) throw await readError(res);
      const body = (await res.json()) as { version?: unknown };
      return typeof body.version === 'number' ? body.version : expectedVersion + 1;
    },

    async deleteProject(id): Promise<void> {
      const res = await call(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok) throw await readError(res);
    },

    async addProjectTrack(projectId, hash): Promise<void> {
      const res = await call(
        `/projects/${encodeURIComponent(projectId)}/tracks/${encodeURIComponent(hash)}`,
        { method: 'POST' },
      );
      if (!res.ok) throw await readError(res);
    },

    async removeProjectTrack(projectId, hash): Promise<void> {
      const res = await call(
        `/projects/${encodeURIComponent(projectId)}/tracks/${encodeURIComponent(hash)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) throw await readError(res);
    },

    async deleteTrack(hash): Promise<void> {
      const res = await call(`/tracks/${hash}`, { method: 'DELETE' });
      // 409 MASIH_DIPAKAI sudah membawa nama project pemakainya di `message`;
      // `readError` meneruskannya apa adanya, dan itu yang perlu dibaca user.
      if (!res.ok) throw await readError(res);
    },

    async putMarks(hash, marks): Promise<void> {
      const res = await call(`/tracks/${hash}/marks`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(marks),
      });
      if (!res.ok) throw await readError(res);
    },

    async logout(): Promise<void> {
      await call('/auth/logout', { method: 'POST' });
    },

    loginUrl(nextPath: string): string {
      return `${base}/auth/google?next=${encodeURIComponent(nextPath)}`;
    },
  };
}
