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

export interface LibraryApi {
  readonly base: string;
  /** `null` = belum login (401). Melempar untuk kegagalan lain. */
  me(): Promise<LibraryUser | null>;
  tracks(): Promise<readonly LibraryTrack[]>;
  /** Byte lagu, dengan laporan kemajuan 0..100. */
  blob(hash: string, onProgress?: (percent: number) => void): Promise<ArrayBuffer>;
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

    async logout(): Promise<void> {
      await call('/auth/logout', { method: 'POST' });
    },

    loginUrl(nextPath: string): string {
      return `${base}/auth/google?next=${encodeURIComponent(nextPath)}`;
    },
  };
}
