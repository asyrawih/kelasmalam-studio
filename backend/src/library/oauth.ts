/**
 * Google OAuth — authorization code + PKCE.
 *
 * ## `client_secret` ada di Worker, PKCE tetap dipakai
 *
 * Keduanya sekaligus terlihat berlebihan (PKCE lahir untuk klien publik yang
 * tidak bisa menyimpan rahasia), tapi yang dijaga PKCE bukan kerahasiaan
 * melainkan **pencurian authorization code**: code yang tercuri dari log,
 * riwayat browser, atau Referer tidak bisa ditukar tanpa `code_verifier`-nya.
 * `docs/16 §1b` sudah memutuskannya, dan ongkosnya satu hash.
 *
 * ## `state` dan `code_verifier` numpang di cookie, bukan di D1
 *
 * Keduanya hanya perlu bertahan dari satu redirect ke redirect berikutnya —
 * hitungan detik. Menaruhnya di tabel berarti baris sampah untuk setiap
 * percobaan login yang ditinggalkan user di layar consent, plus pembersih yang
 * harus menghapusnya. Cookie-nya `SameSite=Lax`, dan callback dari Google
 * adalah navigasi top-level, jadi ia ikut terkirim.
 *
 * ## Tanda tangan `id_token` tidak diverifikasi, dan itu benar
 *
 * Token ini diambil LANGSUNG dari endpoint token Google lewat TLS, bukan
 * diterima dari browser. OpenID Connect Core §3.1.3.7 menyatakan verifikasi
 * tanda tangan boleh dilewati persis dalam keadaan itu. Yang TIDAK boleh
 * dilewati — dan tidak dilewati di sini — adalah memeriksa bahwa `aud` memang
 * client kita: token Google yang sah milik aplikasi lain tetap token Google
 * yang sah.
 */

import { base64url } from './session';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export interface GoogleProfile {
  readonly sub: string;
  readonly email: string;
  readonly name: string;
}

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

export async function newPkce(): Promise<PkcePair> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

export function authorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
}): string {
  const q = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
    // Tidak ada `access_type=offline`: kami tidak pernah memanggil API Google
    // atas nama user setelah login, jadi refresh token adalah rahasia yang
    // tidak dibutuhkan siapa pun di sini.
    prompt: 'select_account',
  });
  return `${AUTH_ENDPOINT}?${q.toString()}`;
}

export type ExchangeResult =
  | { readonly ok: true; readonly profile: GoogleProfile }
  | { readonly ok: false; readonly message: string };

export async function exchangeCode(
  input: {
    code: string;
    verifier: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  },
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ExchangeResult> {
  let res: Response;
  try {
    res = await fetchImpl(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: input.code,
        client_id: input.clientId,
        client_secret: input.clientSecret,
        redirect_uri: input.redirectUri,
        grant_type: 'authorization_code',
        code_verifier: input.verifier,
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err: unknown) {
    return { ok: false, message: `tidak bisa menghubungi Google: ${String(err)}` };
  }

  const text = await res.text();
  if (!res.ok) return { ok: false, message: `Google menolak penukaran code: ${text.slice(0, 200)}` };

  let idToken: unknown;
  try {
    idToken = (JSON.parse(text) as { id_token?: unknown }).id_token;
  } catch {
    return { ok: false, message: 'balasan Google bukan JSON' };
  }
  if (typeof idToken !== 'string') return { ok: false, message: 'Google tidak mengirim id_token' };

  const claims = decodeJwtPayload(idToken);
  if (claims === null) return { ok: false, message: 'id_token tidak bisa dibaca' };

  if (claims.aud !== input.clientId) {
    return { ok: false, message: 'id_token ini bukan untuk aplikasi ini' };
  }
  if (typeof claims.sub !== 'string' || claims.sub === '') {
    return { ok: false, message: 'id_token tanpa `sub`' };
  }

  return {
    ok: true,
    profile: {
      sub: claims.sub,
      email: typeof claims.email === 'string' ? claims.email : '',
      // Google tidak selalu mengirim `name` (akun tanpa profil publik). Email
      // adalah cadangan yang jauh lebih berguna daripada string kosong di
      // topbar.
      name:
        typeof claims.name === 'string' && claims.name !== ''
          ? claims.name
          : typeof claims.email === 'string'
            ? claims.email
            : 'Tanpa nama',
    },
  };
}

interface JwtClaims {
  readonly sub?: unknown;
  readonly aud?: unknown;
  readonly email?: unknown;
  readonly name?: unknown;
}

/** Bagian tengah JWT, tanpa memverifikasi tanda tangan (lihat kepala berkas). */
export function decodeJwtPayload(jwt: string): JwtClaims | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  const payload = parts[1];
  if (payload === undefined) return null;
  try {
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
    // `atob` menghasilkan string byte; nama non-ASCII (mis. アキラ) rusak kalau
    // tidak didekode ulang sebagai UTF-8.
    const bytes = Uint8Array.from(json, (c) => c.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof parsed === 'object' && parsed !== null ? (parsed as JwtClaims) : null;
  } catch {
    return null;
  }
}
