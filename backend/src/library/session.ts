/**
 * Cookie sesi.
 *
 * ## Kenapa `SameSite=Lax` cukup, dan kenapa itu keputusan domain
 *
 * App di Vercel, API di Worker — beda origin. Kalau keduanya juga beda
 * *registrable domain*, cookie sesi harus `SameSite=None`, yaitu cookie pihak
 * ketiga: sudah diblokir Safari dan sedang dimatikan Chrome. Karena itu
 * `docs/16 §5b` menuntut API berada di subdomain domain yang sama dengan app
 * (`app.contoh.com` + `api.contoh.com`). Beda origin, tapi SAMA SITE — jadi
 * `Lax` ikut terkirim pada `fetch` dari app, dan tidak ada yang bergantung
 * pada cookie yang sedang punah.
 *
 * Kalau suatu saat API dipindah ke domain lain, yang rusak bukan cookie ini
 * melainkan seluruh alur login — dan rusaknya senyap: berjalan di Chrome hari
 * ini, mati di Safari. Itu sebabnya keputusan domain ada di dokumen, bukan di
 * konfigurasi.
 *
 * ## `__Host-`
 *
 * Prefiks itu membuat browser menolak cookie yang tidak `Secure`, yang punya
 * atribut `Domain`, atau yang `Path`-nya bukan `/`. Artinya cookie ini tidak
 * bisa dipasang oleh subdomain lain — perlindungan yang gratis dan tidak bisa
 * dilupakan belakangan.
 *
 * ## Token disimpan sebagai hash
 *
 * Yang masuk D1 adalah SHA-256 dari tokennya. Bocornya isi tabel sesi karena
 * itu tidak memberi siapa pun sesi yang bisa dipakai — sama alasannya dengan
 * kenapa password tidak pernah disimpan apa adanya.
 */

export const SESSION_COOKIE = '__Host-lib_session';
export const OAUTH_COOKIE = '__Host-lib_oauth';

/** Ambil satu cookie dari header `Cookie`. */
export function readCookie(header: string | null, name: string): string | null {
  if (header === null) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export interface CookieOptions {
  readonly maxAgeSeconds: number;
  readonly path?: string;
}

export function buildCookie(name: string, value: string, opts: CookieOptions): string {
  const path = opts.path ?? '/';
  return [
    `${name}=${value}`,
    `Path=${path}`,
    `Max-Age=${opts.maxAgeSeconds}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
  ].join('; ');
}

/** Cookie yang menghapus dirinya sendiri. */
export function clearCookie(name: string, path = '/'): string {
  return `${name}=; Path=${path}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/** Token acak 32 byte, base64url. */
export function newToken(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
