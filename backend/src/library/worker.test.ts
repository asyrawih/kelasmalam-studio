/**
 * Worker kepustakaan dari ujung ke ujung, di atas SQLite sungguhan.
 *
 * Yang dijaga di sini bukan "endpoint-nya menjawab 200" melainkan janji-janji
 * yang kalau meleset akan berbentuk data orang lain yang terbaca atau tulisan
 * yang hilang tanpa jejak:
 *
 *   - tanpa sesi, tidak ada satu pun endpoint kepustakaan yang menjawab
 *   - kepustakaan user A tidak pernah terlihat oleh user B, walau hash-nya sama
 *   - dedup: objek yang sudah ada TIDAK pernah diunggah ulang
 *   - simpan bersamaan: yang kalah versi DIBERI TAHU, bukan ditimpa
 *   - hapus lagu yang masih dipakai project: ditolak, dengan menyebut project-nya
 */

import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleRequest, type Deps } from './worker';
import type { Env } from './bindings';
import { openTestDb, type TestDb } from '../test-support/d1-sqlite';
import { fakeR2, type FakeR2 } from '../test-support/fake-r2';

/**
 * SEMUA migrasi, urut — bukan hanya yang pertama.
 *
 * Skema yang dites harus sama dengan yang benar-benar dijalankan di produksi;
 * memuat satu berkas saja berarti tabel yang ditambahkan migrasi berikutnya
 * tidak pernah teruji, dan bug-nya baru muncul sesudah deploy.
 */
const SCHEMA = readdirSync(new URL('../../migrations/', import.meta.url))
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(new URL(`../../migrations/${f}`, import.meta.url), 'utf8'))
  .join('\n');

const APP = 'https://app.test';
const API = 'https://api.test';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

let db: TestDb;
let r2: FakeR2;
let env: Env;

/** Google palsu: satu profil, satu penukaran code. */
function googleFetch(profile: { sub: string; email: string; name: string }): typeof fetch {
  const payload = btoa(
    JSON.stringify({ sub: profile.sub, email: profile.email, name: profile.name, aud: 'client-id' }),
  )
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const idToken = `header.${payload}.signature`;
  return (async () =>
    new Response(JSON.stringify({ id_token: idToken }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
}

const call = (
  path: string,
  init: RequestInit & { cookie?: string; origin?: string; bearer?: string } = {},
  deps: Deps = {},
): Promise<Response> => {
  const headers = new Headers(init.headers);
  headers.set('origin', init.origin ?? APP);
  if (init.cookie !== undefined) headers.set('cookie', init.cookie);
  if (init.bearer !== undefined) headers.set('authorization', `Bearer ${init.bearer}`);
  return handleRequest(new Request(`${API}${path}`, { ...init, headers }), env, deps);
};

/** Origin aplikasi desktop — keduanya, karena bug-nya hanya muncul di OS yang tidak dipakai (docs/20 §5c). */
const DESKTOP_ORIGINS = ['tauri://localhost', 'http://tauri.localhost'] as const;

/** Jalani seluruh alur login dan kembalikan cookie sesinya. */
async function login(profile = { sub: 'sub-1', email: 'a@test', name: 'Ana' }): Promise<string> {
  const start = await call('/auth/google?next=/dj');
  const oauthCookie = (start.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const state = (oauthCookie.split('=')[1] ?? '').split('.')[0] ?? '';

  const done = await call(
    `/auth/callback?code=kode&state=${state}`,
    { cookie: oauthCookie },
    { fetchImpl: googleFetch(profile) },
  );
  expect(done.status).toBe(302);

  const setCookies = done.headers.getSetCookie();
  const session = setCookies.find((c) => c.startsWith('__Host-lib_session='));
  expect(session).toBeDefined();
  return (session ?? '').split(';')[0] ?? '';
}

/**
 * Alur desktop sampai deep link: `/auth/google?client=desktop` → callback →
 * `kelasmalam://auth?code&state`. Mengembalikan code + state yang dibawa deep
 * link, TANPA menukarnya — tiap tes memutuskan sendiri apa yang terjadi
 * sesudah itu.
 */
async function loginDesktop(
  desktopState = 'state-desktop-1',
  profile = { sub: 'sub-1', email: 'a@test', name: 'Ana' },
): Promise<{ code: string; state: string; location: string; callback: Response }> {
  const start = await call(`/auth/google?client=desktop&state=${encodeURIComponent(desktopState)}&next=/dj`);
  expect(start.status).toBe(302);
  const oauthCookie = (start.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const googleState = (oauthCookie.split('=')[1] ?? '').split('.')[0] ?? '';

  const callback = await call(
    `/auth/callback?code=kode&state=${googleState}`,
    { cookie: oauthCookie },
    { fetchImpl: googleFetch(profile) },
  );
  expect(callback.status).toBe(302);
  const location = callback.headers.get('location') ?? '';
  const q = new URL(location).searchParams;
  return { code: q.get('code') ?? '', state: q.get('state') ?? '', location, callback };
}

/** Tukar code jadi token bearer. */
async function exchange(code: string): Promise<Response> {
  return call('/auth/desktop/exchange', { method: 'POST', body: JSON.stringify({ code }) });
}

/** Unggah + commit satu lagu, mengembalikan hash-nya. */
async function seedTrack(cookie: string, hash: string, bytes = 1024, name = 'Lagu'): Promise<void> {
  await call('/tracks/init', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ hash, name, bytes, mime: 'audio/mpeg' }),
  });
  r2.put(`tracks/${hash}`, new Uint8Array(bytes));
  const res = await call('/tracks/commit', {
    method: 'POST',
    cookie,
    body: JSON.stringify({ hash, name, bytes, mime: 'audio/mpeg', frames: 48_000, sampleRate: 48_000 }),
  });
  expect(res.status).toBe(200);
}

beforeEach(() => {
  db = openTestDb(SCHEMA);
  r2 = fakeR2();
  env = {
    DB: db,
    TRACKS: r2,
    APP_ORIGIN: APP,
    API_ORIGIN: API,
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'rahasia',
    R2_ACCOUNT_ID: 'akun',
    R2_BUCKET: 'ember',
    R2_ACCESS_KEY_ID: 'AKIA-TES',
    R2_SECRET_ACCESS_KEY: 'rahasia-r2',
    CREDENTIAL_ENCRYPTION_KEY: 'test-only-secret-with-at-least-32-characters',
  };
});

afterEach(() => db.close());

describe('pintu masuk', () => {
  it('/health tidak butuh sesi', async () => {
    const res = await call('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it('tanpa sesi, SEMUA endpoint kepustakaan menjawab 401', async () => {
    for (const [path, init] of [
      ['/me', {}],
      ['/tracks', {}],
      ['/tracks/init', { method: 'POST', body: '{}' }],
      ['/tracks/commit', { method: 'POST', body: '{}' }],
      [`/tracks/${HASH_A}/blob`, {}],
      [`/tracks/${HASH_A}/marks`, { method: 'PUT', body: '{}' }],
      [`/tracks/${HASH_A}`, { method: 'DELETE' }],
      ['/projects', {}],
      ['/projects/abc', {}],
      ['/roblox/assets', {}],
      ['/roblox/settings', {}],
      ['/roblox/grants', { method: 'POST', body: '{}' }],
    ] as const) {
      const res = await call(path, init as RequestInit);
      expect([path, res.status]).toEqual([path, 401]);
    }
  });

  it('preflight mengizinkan kredensial — tanpa itu cookie sesi tidak pernah terkirim', async () => {
    const res = await call('/tracks', { method: 'OPTIONS' });
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('access-control-allow-origin')).toBe(APP);
  });

  it('ALLOWED_ORIGINS kosong jatuh ke APP_ORIGIN — bukan menolak semua origin', async () => {
    // `wrangler.toml` mengirim string kosong untuk var yang dikosongkan, dan
    // Worker yang memperlakukannya sebagai "tidak ada yang diizinkan" akan
    // menolak aplikasinya sendiri di deploy pertama.
    env = { ...env, ALLOWED_ORIGINS: '' };
    const res = await call('/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(APP);
  });

  it('ALLOWED_ORIGINS yang terisi menggantikan APP_ORIGIN, bukan menambahinya', async () => {
    env = { ...env, ALLOWED_ORIGINS: 'https://lain.test' };
    const dariApp = await call('/health');
    expect(dariApp.status).toBe(403);
  });

  it('balasan sungguhan juga membawa allow-credentials, bukan cuma preflight', async () => {
    const res = await call('/health');
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });
});

describe('Roblox catalog dan grants', () => {
  it('menyimpan API key terenkripsi dan membukanya lagi untuk user yang sama', async () => {
    const cookie = await login();
    const saved = await call('/roblox/settings', {
      method: 'PUT', cookie,
      body: JSON.stringify({ creatorKind: 'user', creatorId: '2468', apiKey: 'roblox-secret-api-key' }),
    });
    expect(saved.status).toBe(200);
    const row = await db.prepare('SELECT api_key_cipher FROM roblox_credential').first<{ api_key_cipher: string }>();
    expect(row?.api_key_cipher).not.toContain('roblox-secret-api-key');
    const loaded = await call('/roblox/settings', { cookie });
    expect(await loaded.json()).toEqual({ settings: {
      creatorKind: 'user', creatorId: '2468', apiKey: 'roblox-secret-api-key', hasRobloxCookie: false, robloxCookie: '',
    } });
  });

  it('menyinkronkan seluruh halaman audio Roblox ke katalog D1 memakai cookie tersimpan', async () => {
    const cookie = await login();
    await call('/roblox/settings', {
      method: 'PUT', cookie,
      body: JSON.stringify({ creatorKind: 'user', creatorId: '2468', apiKey: 'roblox-secret-api-key', robloxCookie: 'cookie-rahasia-roblox' }),
    });
    expect(await (await call('/roblox/settings', { cookie })).json()).toMatchObject({
      settings: { hasRobloxCookie: true, robloxCookie: 'cookie-rahasia-roblox' },
    });
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('cookie')).toBe('.ROBLOSECURITY=cookie-rahasia-roblox');
      if (String(input).includes('/authenticated')) return new Response(JSON.stringify({ id: 2468 }));
      return new Response(JSON.stringify({ data: [{ assetId: 9876, name: 'Audio Lama' }], nextPageCursor: null }));
    });
    const synced = await call('/roblox/assets/sync', { method: 'POST', cookie }, { fetchImpl: fetchSpy as typeof fetch });
    expect(await synced.json()).toEqual({ ok: true, synced: 1 });
    const list = await call('/roblox/assets', { cookie });
    expect((await list.json()).assets).toMatchObject([{ assetId: '9876', name: 'Audio Lama' }]);
  });

  it('menyimpan katalog di D1 dan mengisolasinya per user', async () => {
    const ana = await login({ sub: 'rbx-a', email: 'a@test', name: 'Ana' });
    const imported = await call('/roblox/assets', {
      method: 'POST', cookie: ana,
      body: JSON.stringify({ assets: [{ assetId: '12345', creatorKind: 'group', creatorId: '99', name: 'Lagu Malam' }] }),
    });
    expect(await imported.json()).toMatchObject({ imported: 1 });
    const list = await call('/roblox/assets?q=Malam', { cookie: ana });
    expect((await list.json()).assets).toMatchObject([{ assetId: '12345', creatorKind: 'group' }]);

    const budi = await login({ sub: 'rbx-b', email: 'b@test', name: 'Budi' });
    expect((await (await call('/roblox/assets', { cookie: budi })).json()).assets).toEqual([]);
  });

  it('menerjemahkan daftar experience dan Place ID dari endpoint publik Roblox', async () => {
    const cookie = await login();
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/games')) return new Response(JSON.stringify({ data: [{ id: 77, name: 'Klub', rootPlace: { id: 88 } }] }));
      return new Response(JSON.stringify({ universeId: 77 }));
    });
    const fetchImpl = fetchSpy as typeof fetch;
    const games = await call('/roblox/experiences?ownerType=group&ownerId=42', { cookie }, { fetchImpl });
    expect((await games.json()).experiences).toEqual([{ universeId: '77', placeId: '88', name: 'Klub' }]);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('/v2/groups/42/gamesV2');
    const place = await call('/roblox/resolve-place?placeId=88', { cookie }, { fetchImpl });
    expect(await place.json()).toEqual({ placeId: '88', universeId: '77' });
  });

  it('mengirim API key dan batch izin Use ke Asset Permissions API', async () => {
    const cookie = await login();
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}'));
    const fetchImpl = fetchSpy as typeof fetch;
    const res = await call('/roblox/grants', {
      method: 'POST', cookie,
      headers: { 'x-roblox-api-key': 'secret-key' },
      body: JSON.stringify({ assetIds: ['123', '456'], subjectType: 'Universe', subjectId: '77' }),
    }, { fetchImpl });
    expect(await res.json()).toEqual({ ok: true, granted: 2 });
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://apis.roblox.com/asset-permissions-api/v1/assets/permissions');
    expect(new Headers(init?.headers).get('x-api-key')).toBe('secret-key');
    expect(JSON.parse(String(init?.body))).toEqual({
      subjectType: 'Universe', subjectId: '77', action: 'Use',
      requests: [{ assetId: '123' }, { assetId: '456' }],
    });
  });
});

describe('login', () => {
  it('menukar code jadi sesi dan mengembalikan user ke halaman asal', async () => {
    const cookie = await login();
    const me = await call('/me', { cookie });
    expect(await me.json()).toMatchObject({ email: 'a@test', name: 'Ana' });
  });

  it('state yang tidak cocok ditolak', async () => {
    const start = await call('/auth/google');
    const oauthCookie = (start.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const res = await call(`/auth/callback?code=kode&state=palsu`, { cookie: oauthCookie });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('STATE_TIDAK_COCOK');
  });

  it('`next` yang berisi origin lain diabaikan — open redirect di alur OAuth adalah cara code dicuri', async () => {
    const start = await call('/auth/google?next=https://jahat.test/x');
    const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const state = (cookie.split('=')[1] ?? '').split('.')[0] ?? '';
    const done = await call(`/auth/callback?code=k&state=${state}`, { cookie }, { fetchImpl: googleFetch({ sub: 's', email: 'e', name: 'n' }) });
    expect(done.headers.get('location')).toBe(`${APP}/`);
  });

  it('id_token untuk aplikasi lain ditolak', async () => {
    const start = await call('/auth/google');
    const cookie = (start.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const state = (cookie.split('=')[1] ?? '').split('.')[0] ?? '';
    const wrongAud = (async () =>
      new Response(
        JSON.stringify({
          id_token: `h.${btoa(JSON.stringify({ sub: 's', aud: 'aplikasi-lain' }))}.s`,
        }),
      )) as typeof fetch;

    const res = await call(`/auth/callback?code=k&state=${state}`, { cookie }, { fetchImpl: wrongAud });
    expect(res.status).toBe(401);
  });

  it('logout mencabut sesinya di server, bukan cuma menghapus cookie', async () => {
    const cookie = await login();
    await call('/auth/logout', { method: 'POST', cookie });
    expect((await call('/me', { cookie })).status).toBe(401);
  });

  it('login kedua dengan sub yang sama memakai user yang sama', async () => {
    const first = await login({ sub: 'sub-1', email: 'a@test', name: 'Ana' });
    await seedTrack(first, HASH_A);
    // Email berganti; `sub` tidak. Kepustakaannya harus ikut.
    const second = await login({ sub: 'sub-1', email: 'baru@test', name: 'Ana Baru' });
    const list = await (await call('/tracks', { cookie: second })).json();
    expect(list.tracks).toHaveLength(1);
  });
});

describe('login desktop', () => {
  beforeEach(() => {
    // Seperti produksi: daftar terisi MENGGANTIKAN APP_ORIGIN, jadi web harus
    // ditulis ulang di dalamnya.
    env = { ...env, ALLOWED_ORIGINS: `${APP},${DESKTOP_ORIGINS.join(',')}` };
  });

  it('alur utuh: google → callback → deep link berisi code+state → exchange → /me dengan bearer', async () => {
    const { code, state, location, callback } = await loginDesktop('acak-123');

    // Deep link, bukan APP_ORIGIN, dan state dikembalikan utuh.
    expect(location.startsWith('kelasmalam://auth?')).toBe(true);
    expect(state).toBe('acak-123');
    expect(code).not.toBe('');

    // Token sesi TIDAK boleh ada di URL, dan tidak ada cookie sesi yang dipasang
    // di browser sistem.
    const setCookies = callback.headers.getSetCookie();
    expect(setCookies.some((c) => c.startsWith('__Host-lib_session='))).toBe(false);
    expect(setCookies.some((c) => c.startsWith('__Host-lib_oauth=;'))).toBe(true);
    const sessions = await db.prepare('SELECT COUNT(*) AS n FROM session').first<{ n: number }>();
    expect(sessions?.n).toBe(0);

    const res = await exchange(code);
    expect(res.status).toBe(200);
    const { token } = await res.json();
    expect(typeof token).toBe('string');
    expect(location).not.toContain(token);

    const me = await call('/me', { bearer: token, origin: 'tauri://localhost' });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: 'a@test', name: 'Ana' });

    // Kepustakaan yang sama dengan jalur web: user-nya satu.
    const web = await login();
    expect((await (await call('/me', { cookie: web })).json()).id).toBe((await (await call('/me', { bearer: token })).json()).id);
  });

  it('code yang dipakai dua kali ditolak 401 — sekali pakai berarti sekali', async () => {
    const { code } = await loginDesktop();
    expect((await exchange(code)).status).toBe(200);
    const again = await exchange(code);
    expect(again.status).toBe(401);
    expect(await again.json()).toMatchObject({ code: 'CODE_TIDAK_SAH' });
    // Barisnya sudah hilang, bukan sekadar ditandai.
    const rows = await db.prepare('SELECT COUNT(*) AS n FROM desktop_auth_code').first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it('code kedaluwarsa sesudah 60 detik', async () => {
    vi.useFakeTimers();
    try {
      const { code } = await loginDesktop();
      vi.setSystemTime(new Date(Date.now() + 61_000));
      const res = await exchange(code);
      expect(res.status).toBe(401);
      expect((await res.json()).code).toBe('CODE_TIDAK_SAH');
    } finally {
      vi.useRealTimers();
    }
  });

  it('code yang masih di dalam 60 detik tetap sah', async () => {
    vi.useFakeTimers();
    try {
      const { code } = await loginDesktop();
      vi.setSystemTime(new Date(Date.now() + 59_000));
      expect((await exchange(code)).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('code acak dan badan yang salah bentuk ditolak', async () => {
    expect((await exchange('bukan-code')).status).toBe(401);
    const noJson = await call('/auth/desktop/exchange', { method: 'POST', body: 'x' });
    expect(noJson.status).toBe(400);
    const noCode = await call('/auth/desktop/exchange', { method: 'POST', body: '{}' });
    expect(noCode.status).toBe(400);
    expect((await call('/auth/desktop/exchange', { method: 'GET' })).status).toBe(405);
  });

  it('bearer acak → 401 di semua endpoint, sama seperti tanpa sesi', async () => {
    for (const path of ['/me', '/tracks', '/projects']) {
      const res = await call(path, { bearer: 'token-ngawur', origin: 'http://tauri.localhost' });
      expect([path, res.status]).toEqual([path, 401]);
    }
  });

  it('skema selain Bearer tidak dianggap sesi', async () => {
    const { code } = await loginDesktop();
    const { token } = await (await exchange(code)).json();
    const res = await call('/me', { headers: { authorization: `Basic ${token}` } });
    expect(res.status).toBe(401);
  });

  it('cookie + bearer sekaligus → cookie yang dipakai', async () => {
    const cookie = await login({ sub: 'web-user', email: 'web@test', name: 'Web' });
    const { code } = await loginDesktop('s', { sub: 'desk-user', email: 'desk@test', name: 'Desk' });
    const { token } = await (await exchange(code)).json();

    const me = await call('/me', { cookie, bearer: token });
    expect(await me.json()).toMatchObject({ email: 'web@test' });

    // Bearer basi di samping cookie yang sah juga tidak mengganggu jalur web.
    const stale = await call('/me', { cookie, bearer: 'basi' });
    expect(stale.status).toBe(200);
  });

  it('logout dengan bearer mencabut sesi itu, tanpa Set-Cookie yang menyesatkan', async () => {
    const { code } = await loginDesktop();
    const { token } = await (await exchange(code)).json();
    expect((await call('/me', { bearer: token })).status).toBe(200);

    const out = await call('/auth/logout', { method: 'POST', bearer: token });
    expect(out.status).toBe(200);
    expect(out.headers.get('set-cookie')).toBeNull();
    expect((await call('/me', { bearer: token })).status).toBe(401);
  });

  it('logout web tetap membersihkan cookie — jalur lama tidak berubah', async () => {
    const cookie = await login();
    const out = await call('/auth/logout', { method: 'POST', cookie });
    expect(out.headers.get('set-cookie')).toContain('__Host-lib_session=;');
  });

  it('client=desktop tanpa state ditolak — tanpa state aplikasi tidak bisa menolak deep link palsu', async () => {
    const res = await call('/auth/google?client=desktop');
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('STATE_DESKTOP');
  });

  it('state desktop dengan karakter apa pun kembali utuh — ia numpang di cookie, bukan di URL Google', async () => {
    const weird = 'a.b/c+d=e f&g?h#ü';
    const { state } = await loginDesktop(weird);
    expect(state).toBe(weird);
  });

  it('state desktop TIDAK dipakai sebagai state Google — CSRF callback tetap dijaga Worker', async () => {
    const start = await call('/auth/google?client=desktop&state=milik-desktop');
    const location = new URL(start.headers.get('location') ?? '');
    expect(location.searchParams.get('state')).not.toBe('milik-desktop');
    // Callback dengan state desktop (bukan state Worker) harus ditolak.
    const oauthCookie = (start.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const res = await call('/auth/callback?code=k&state=milik-desktop', { cookie: oauthCookie });
    expect(res.status).toBe(400);
  });

  it('alur WEB tidak tersentuh: tanpa client=desktop callback tetap ke APP_ORIGIN dengan cookie', async () => {
    const start = await call('/auth/google?next=/dj&state=diabaikan');
    const oauthCookie = (start.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const googleState = (oauthCookie.split('=')[1] ?? '').split('.')[0] ?? '';
    const done = await call(
      `/auth/callback?code=kode&state=${googleState}`,
      { cookie: oauthCookie },
      { fetchImpl: googleFetch({ sub: 's', email: 'e', name: 'n' }) },
    );
    expect(done.headers.get('location')).toBe(`${APP}/dj`);
    expect(done.headers.getSetCookie().some((c) => c.startsWith('__Host-lib_session='))).toBe(true);
  });

  describe('CORS untuk origin desktop', () => {
    for (const origin of DESKTOP_ORIGINS) {
      it(`preflight dari ${origin} mengizinkan Authorization dan Content-Type`, async () => {
        const res = await call('/tracks', {
          method: 'OPTIONS',
          origin,
          headers: { 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
        });
        expect(res.status).toBe(204);
        expect(res.headers.get('access-control-allow-origin')).toBe(origin);
        const allowed = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase();
        expect(allowed).toContain('authorization');
        expect(allowed).toContain('content-type');
      });

      it(`balasan sungguhan untuk ${origin} membawa allow-origin`, async () => {
        const { code } = await loginDesktop();
        const { token } = await (await exchange(code)).json();
        const res = await call('/me', { bearer: token, origin });
        expect(res.status).toBe(200);
        expect(res.headers.get('access-control-allow-origin')).toBe(origin);
      });
    }

    it('origin lain tetap ditolak, dan web masih diizinkan', async () => {
      const asing = await call('/me', { method: 'OPTIONS', origin: 'https://jahat.test' });
      expect(asing.headers.get('access-control-allow-origin')).toBeNull();
      expect((await call('/health', { origin: 'tauri://jahat' })).status).toBe(403);
      expect((await call('/health', { origin: APP })).status).toBe(200);
    });
  });
});

describe('tracks', () => {
  it('init memberi uploadUrl presigned untuk objek yang belum ada', async () => {
    const cookie = await login();
    const res = await call('/tracks/init', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ hash: HASH_A, name: 'Lagu', bytes: 2048, mime: 'audio/mpeg' }),
    });
    const body = await res.json();
    expect(body.exists).toBe(false);
    expect(body.uploadUrl).toContain('X-Amz-Signature=');
    expect(body.uploadUrl).toContain(`/ember/tracks%2F${HASH_A}`.replace('%2F', '/'));
  });

  it('DEDUP: objek yang sudah ada tidak pernah diunggah ulang, oleh user mana pun', async () => {
    const ana = await login({ sub: 'sub-1', email: 'a@test', name: 'Ana' });
    await seedTrack(ana, HASH_A);

    const budi = await login({ sub: 'sub-2', email: 'b@test', name: 'Budi' });
    const res = await call('/tracks/init', {
      method: 'POST',
      cookie: budi,
      body: JSON.stringify({ hash: HASH_A, name: 'Lagu sama', bytes: 1024, mime: 'audio/mpeg' }),
    });
    const body = await res.json();
    expect(body).toEqual({ exists: true });
    expect(body.uploadUrl).toBeUndefined();
  });

  it('kepustakaan satu user tidak terlihat oleh user lain', async () => {
    const ana = await login({ sub: 'sub-1', email: 'a@test', name: 'Ana' });
    await seedTrack(ana, HASH_A);
    const budi = await login({ sub: 'sub-2', email: 'b@test', name: 'Budi' });

    expect((await (await call('/tracks', { cookie: budi })).json()).tracks).toEqual([]);
    // Objeknya ADA di R2 dan hash-nya diketahui — yang menghalangi hanyalah klaim.
    expect((await call(`/tracks/${HASH_A}/blob`, { cookie: budi })).status).toBe(404);
  });

  it('commit menolak hash yang byte-nya belum ada di penyimpanan', async () => {
    const cookie = await login();
    const res = await call('/tracks/commit', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ hash: HASH_A, name: 'x', bytes: 10, mime: 'audio/mpeg' }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('BELUM_TERUNGGAH');
  });

  it('commit menolak ukuran yang tidak cocok dengan yang benar-benar terunggah', async () => {
    const cookie = await login();
    r2.put(`tracks/${HASH_A}`, new Uint8Array(100));
    const res = await call('/tracks/commit', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ hash: HASH_A, bytes: 999, mime: 'audio/mpeg' }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('UKURAN_TIDAK_COCOK');
  });

  it('commit ulang tidak menggandakan barisnya', async () => {
    const cookie = await login();
    await seedTrack(cookie, HASH_A);
    await seedTrack(cookie, HASH_A);
    expect((await (await call('/tracks', { cookie })).json()).tracks).toHaveLength(1);
  });

  it('blob mengalir dengan CORP — tanpanya halaman ber-COEP menolak audionya', async () => {
    const cookie = await login();
    await seedTrack(cookie, HASH_A, 512);

    const res = await call(`/tracks/${HASH_A}/blob`, { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect((await res.arrayBuffer()).byteLength).toBe(512);
  });

  it('marks tersimpan dan ikut muncul di daftar, sudah terurai', async () => {
    const cookie = await login();
    await seedTrack(cookie, HASH_A);
    await call(`/tracks/${HASH_A}/marks`, {
      method: 'PUT',
      cookie,
      body: JSON.stringify({ hotCues: [{ slot: 1, at: 42 }], bpm: 128 }),
    });

    const list = await (await call('/tracks', { cookie })).json();
    expect(list.tracks[0].marks).toEqual({ hotCues: [{ slot: 1, at: 42 }], bpm: 128 });
  });

  it('lagu tanpa marks tampil sebagai null, bukan hilang dari daftar', async () => {
    const cookie = await login();
    await seedTrack(cookie, HASH_A);
    const list = await (await call('/tracks', { cookie })).json();
    expect(list.tracks[0].marks).toBeNull();
  });

  it('init menolak berkas yang lebih besar dari batas, SEBELUM ada byte yang naik', async () => {
    const cookie = await login();
    env = { ...env, MAX_TRACK_BYTES: '1000' };
    const res = await call('/tracks/init', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ hash: HASH_A, name: 'x', bytes: 5000, mime: 'audio/mpeg' }),
    });
    expect(res.status).toBe(413);
    expect((await res.json()).message).toMatch(/multipart/i);
  });

  it('kuota per user ditegakkan di init', async () => {
    const cookie = await login();
    await seedTrack(cookie, HASH_A, 900);
    env = { ...env, MAX_USER_BYTES: '1000' };

    const res = await call('/tracks/init', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ hash: HASH_B, name: 'y', bytes: 500, mime: 'audio/mpeg' }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('KUOTA');
  });

  it('hash dan mime yang tidak masuk akal ditolak', async () => {
    const cookie = await login();
    const badHash = await call('/tracks/init', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ hash: 'pendek', bytes: 10, mime: 'audio/mpeg' }),
    });
    expect((await badHash.json()).code).toBe('HASH');

    const badMime = await call('/tracks/init', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ hash: HASH_A, bytes: 10, mime: 'application/zip' }),
    });
    expect((await badMime.json()).code).toBe('MIME');
  });

  it('hapus melepas klaim TANPA menghapus objek R2 — objeknya milik banyak user', async () => {
    const ana = await login({ sub: 'sub-1', email: 'a@test', name: 'Ana' });
    const budi = await login({ sub: 'sub-2', email: 'b@test', name: 'Budi' });
    await seedTrack(ana, HASH_A);
    await seedTrack(budi, HASH_A);

    expect((await call(`/tracks/${HASH_A}`, { method: 'DELETE', cookie: ana })).status).toBe(200);
    expect((await (await call('/tracks', { cookie: ana })).json()).tracks).toEqual([]);
    // Budi tidak kehilangan apa pun.
    expect((await (await call('/tracks', { cookie: budi })).json()).tracks).toHaveLength(1);
    expect(r2.has(`tracks/${HASH_A}`)).toBe(true);
  });
});

describe('projects', () => {
  const projectWith = (hash?: string): unknown => ({
    lanes: [{ clips: hash === undefined ? [] : [{ assetRef: { contentHash: hash } }] }],
  });

  it('simpan lalu buka mengembalikan isi yang sama', async () => {
    const cookie = await login();
    const made = await call('/projects', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: 'Set malam', json: projectWith() }),
    });
    expect(made.status).toBe(201);
    const { id, version } = await made.json();
    expect(version).toBe(1);

    const got = await (await call(`/projects/${id}`, { cookie })).json();
    expect(got).toMatchObject({ name: 'Set malam', version: 1 });
    expect(got.json).toEqual(projectWith());
  });

  it('PUT tanpa If-Match ditolak 428 — simpan tanpa versi berarti menimpa buta', async () => {
    const cookie = await login();
    const { id } = await (await call('/projects', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: 'A', json: {} }),
    })).json();

    const res = await call(`/projects/${id}`, {
      method: 'PUT',
      cookie,
      body: JSON.stringify({ name: 'A', json: {} }),
    });
    expect(res.status).toBe(428);
  });

  it('dua tab: yang kalah versi DIBERI TAHU, bukan ditimpa diam-diam', async () => {
    const cookie = await login();
    const { id } = await (await call('/projects', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: 'A', json: { v: 1 } }),
    })).json();

    const tabA = await call(`/projects/${id}`, {
      method: 'PUT',
      cookie,
      headers: { 'if-match': '"1"' },
      body: JSON.stringify({ name: 'A', json: { v: 2 } }),
    });
    expect(tabA.status).toBe(200);
    expect((await tabA.json()).version).toBe(2);

    // Tab kedua masih memegang versi 1.
    const tabB = await call(`/projects/${id}`, {
      method: 'PUT',
      cookie,
      headers: { 'if-match': '"1"' },
      body: JSON.stringify({ name: 'A', json: { v: 3 } }),
    });
    expect(tabB.status).toBe(412);
    expect(await tabB.json()).toMatchObject({ code: 'VERSI_BASI', currentVersion: 2 });

    // Dan tulisan tab A tetap utuh.
    const now = await (await call(`/projects/${id}`, { cookie })).json();
    expect(now.json).toEqual({ v: 2 });
  });

  it('menolak project yang merujuk lagu yang belum ada di kepustakaan', async () => {
    const cookie = await login();
    const res = await call('/projects', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: 'A', json: projectWith(HASH_A) }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'ASSET_BELUM_TERSIMPAN', missing: [HASH_A] });
  });

  it('menerimanya begitu lagunya ter-commit', async () => {
    const cookie = await login();
    await seedTrack(cookie, HASH_A);
    const res = await call('/projects', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: 'A', json: projectWith(HASH_A) }),
    });
    expect(res.status).toBe(201);
  });

  it('hapus lagu yang dipakai project DITOLAK, dengan menyebut project-nya', async () => {
    const cookie = await login();
    await seedTrack(cookie, HASH_A);
    const { id } = await (await call('/projects', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: 'Set malam', json: projectWith(HASH_A) }),
    })).json() as { id: string };
    await call(`/projects/${id}/tracks/${HASH_A}`, { method: 'POST', cookie });

    const res = await call(`/tracks/${HASH_A}`, { method: 'DELETE', cookie });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('MASIH_DIPAKAI');
    expect(body.message).toContain('Set malam');
  });

  it('project adalah folder: lagu bisa ditambah dan dilepas tanpa mengubah JSON timeline', async () => {
    const cookie = await login();
    await seedTrack(cookie, HASH_A);
    const made = await call('/projects', {
      method: 'POST', cookie,
      body: JSON.stringify({ name: 'BKB', json: { lanes: [] } }),
    });
    const { id } = await made.json() as { id: string };

    expect((await call(`/projects/${id}/tracks/${HASH_A}`, { method: 'POST', cookie })).status).toBe(200);
    const folder = await (await call(`/projects/${id}`, { cookie })).json();
    expect(folder.tracks).toEqual([HASH_A]);
    expect(folder.json).toEqual({ lanes: [] });

    const removed = await call(`/projects/${id}/tracks/${HASH_A}`, { method: 'DELETE', cookie });
    expect(removed.status).toBe(200);
    expect((await removed.json()).deletedFromLibrary).toBe(true);
    expect((await (await call(`/projects/${id}`, { cookie })).json()).tracks).toEqual([]);
    expect((await (await call('/tracks', { cookie })).json()).tracks).toEqual([]);
    expect((await call(`/tracks/${HASH_A}`, { method: 'DELETE', cookie })).status).toBe(404);
  });

  it('membership lagu terisolasi per folder', async () => {
    const cookie = await login();
    await seedTrack(cookie, HASH_A);
    await seedTrack(cookie, HASH_B);
    const buat = async (name: string): Promise<string> => {
      const res = await call('/projects', {
        method: 'POST', cookie, body: JSON.stringify({ name, json: { lanes: [] } }),
      });
      return ((await res.json()) as { id: string }).id;
    };
    const a = await buat('A');
    const b = await buat('B');
    await call(`/projects/${a}/tracks/${HASH_A}`, { method: 'POST', cookie });
    await call(`/projects/${b}/tracks/${HASH_B}`, { method: 'POST', cookie });

    expect((await (await call(`/projects/${a}`, { cookie })).json()).tracks).toEqual([HASH_A]);
    expect((await (await call(`/projects/${b}`, { cookie })).json()).tracks).toEqual([HASH_B]);
    expect((await (await call('/tracks', { cookie })).json()).tracks).toHaveLength(2);

    await call(`/projects/${b}/tracks/${HASH_A}`, { method: 'POST', cookie });
    const removed = await call(`/projects/${a}/tracks/${HASH_A}`, { method: 'DELETE', cookie });
    expect((await removed.json()).deletedFromLibrary).toBe(false);
    expect((await (await call('/tracks', { cookie })).json()).tracks).toHaveLength(2);
  });

  it('folder tidak bisa diberi lagu milik user lain atau project user lain', async () => {
    const ana = await login({ sub: 'sub-folder-a', email: 'a@test', name: 'Ana' });
    const budi = await login({ sub: 'sub-folder-b', email: 'b@test', name: 'Budi' });
    await seedTrack(ana, HASH_A);
    const { id } = await (await call('/projects', {
      method: 'POST', cookie: budi,
      body: JSON.stringify({ name: 'BKB', json: { lanes: [] } }),
    })).json() as { id: string };

    expect((await call(`/projects/${id}/tracks/${HASH_A}`, { method: 'POST', cookie: budi })).status).toBe(404);
    expect((await call(`/projects/${id}/tracks/${HASH_A}`, { method: 'POST', cookie: ana })).status).toBe(404);
  });

  it('anggota folder bisa dilepas tanpa dipengaruhi JSON timeline', async () => {
    const cookie = await login();
    await seedTrack(cookie, HASH_A);
    const { id } = await (await call('/projects', {
      method: 'POST', cookie,
      body: JSON.stringify({ name: 'BKB', json: projectWith(HASH_A) }),
    })).json() as { id: string };

    await call(`/projects/${id}/tracks/${HASH_A}`, { method: 'POST', cookie });
    const res = await call(`/projects/${id}/tracks/${HASH_A}`, { method: 'DELETE', cookie });
    expect(res.status).toBe(200);
    expect((await (await call(`/projects/${id}`, { cookie })).json()).tracks).toEqual([]);
  });

  it('hapus tidak memakai LIKE/GLOB D1 untuk mencari project pemakai', async () => {
    const cookie = await login();
    await seedTrack(cookie, HASH_A);
    const { id } = await (await call('/projects', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: 'Set malam', json: projectWith(HASH_A) }),
    })).json() as { id: string };
    await call(`/projects/${id}/tracks/${HASH_A}`, { method: 'POST', cookie });

    const original = env.DB;
    env = {
      ...env,
      DB: {
        prepare(sql) {
          if (/\b(?:LIKE|GLOB)\b/i.test(sql)) {
            throw new Error('LIKE or GLOB pattern too complex');
          }
          return original.prepare(sql);
        },
      },
    };

    const res = await call(`/tracks/${HASH_A}`, { method: 'DELETE', cookie });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'MASIH_DIPAKAI' });
  });

  it('project user lain tidak bisa dibaca, disimpan, atau dihapus', async () => {
    const ana = await login({ sub: 'sub-1', email: 'a@test', name: 'Ana' });
    const { id } = await (await call('/projects', {
      method: 'POST',
      cookie: ana,
      body: JSON.stringify({ name: 'Rahasia', json: {} }),
    })).json();

    const budi = await login({ sub: 'sub-2', email: 'b@test', name: 'Budi' });
    expect((await call(`/projects/${id}`, { cookie: budi })).status).toBe(404);
    expect((await call(`/projects/${id}`, { method: 'DELETE', cookie: budi })).status).toBe(404);
    const put = await call(`/projects/${id}`, {
      method: 'PUT',
      cookie: budi,
      headers: { 'if-match': '"1"' },
      body: JSON.stringify({ name: 'x', json: {} }),
    });
    expect(put.status).toBe(404);

    // Dan milik Ana tetap utuh.
    expect((await call(`/projects/${id}`, { cookie: ana })).status).toBe(200);
  });

  it('daftar project hanya berisi milik sendiri', async () => {
    const ana = await login({ sub: 'sub-1', email: 'a@test', name: 'Ana' });
    await call('/projects', { method: 'POST', cookie: ana, body: JSON.stringify({ name: 'A', json: {} }) });
    const budi = await login({ sub: 'sub-2', email: 'b@test', name: 'Budi' });
    expect((await (await call('/projects', { cookie: budi })).json()).projects).toEqual([]);
  });
});

describe('binding hilang', () => {
  /*
   * Kejadian nyata: nama binding di wrangler.toml mengikuti saran dashboard
   * (`dawonweb_library`) alih-alih `DB`. Deploy SUKSES — dan tiap permintaan
   * yang menyentuh database meledak dengan "Cannot read properties of
   * undefined (reading 'prepare')", jauh dari berkas yang salah.
   */
  it('menyebut binding mana yang hilang, bukan meledak di kedalaman kode', async () => {
    env = { ...env, DB: undefined as unknown as Env['DB'] };
    const res = await call('/me', { cookie: '__Host-lib_session=apa-saja' });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe('BINDING_HILANG');
    expect(body.message).toContain('DB');
    expect(body.message).toContain('wrangler.library.toml');
    // Yang TIDAK boleh muncul: jejak kegagalan di kedalaman kode.
    expect(body.message).not.toContain('prepare');
  });

  it('R2 yang hilang juga disebut', async () => {
    env = { ...env, TRACKS: undefined as unknown as Env['TRACKS'] };
    const res = await call('/tracks', { cookie: '__Host-lib_session=apa-saja' });
    expect((await res.json()).message).toContain('TRACKS');
  });

  it('/health TETAP menjawab, dan mengatakan bindingnya tidak lengkap', async () => {
    env = { ...env, DB: undefined as unknown as Env['DB'] };
    const res = await call('/health');

    // Worker salah konfigurasi TIDAK boleh terlihat sama dengan Worker mati:
    // keduanya butuh tindakan yang berbeda.
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, bindings: false });
  });

  it('konfigurasi yang benar melaporkan bindings: true', async () => {
    expect(await (await call('/health')).json()).toMatchObject({ bindings: true });
  });
});

describe('galat internal', () => {
  it('D1 yang melempar jadi 500 BER-JSON, bukan halaman 1101 tanpa kata', async () => {
    /*
     * Kejadian nyata yang membuat tes ini ada: tabel belum dimigrasi, dan
     * SETIAP permintaan ber-sesi menjawab `error code: 1101` — halaman
     * Cloudflare tanpa sebab dan tanpa header CORS. Dari sisi app, itu tidak
     * bisa dibedakan dari Worker yang tidak ter-deploy.
     */
    const meledak = {
      prepare: () => {
        throw new Error('no such table: user');
      },
    };
    env = { ...env, DB: meledak as unknown as Env['DB'] };

    const res = await call('/me', { cookie: '__Host-lib_session=apa-saja' });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      code: 'GALAT_INTERNAL',
      message: 'no such table: user',
    });
  });

  it('balasan galat tetap membawa header CORS — kalau tidak, app melihat "server mati"', async () => {
    const meledak = {
      prepare: () => {
        throw new Error('meledak');
      },
    };
    env = { ...env, DB: meledak as unknown as Env['DB'] };

    const res = await call('/me', { cookie: '__Host-lib_session=apa-saja' });
    expect(res.headers.get('access-control-allow-origin')).toBe(APP);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });
});

describe('lagu yang masih dipakai project', () => {
  /*
   * Bug produksi yang melahirkan tes ini: `json LIKE '%hash%'` atas project
   * yang besar membuat D1 menjawab
   *
   *     D1_ERROR: LIKE or GLOB pattern too complex
   *
   * dan yang terlihat user adalah lagu yang tidak bisa dihapus, tanpa satu pun
   * petunjuk soal SQL. Sekarang jawabannya datang dari `project_track`, yang
   * punya indeks untuk persis pertanyaan ini.
   *
   * YANG TIDAK DIBUKTIKAN TES INI: galat D1 itu sendiri. SQLite di sini tidak
   * menolak pola 66 karakter, jadi versi lama pun akan LULUS. Bug-nya hilang
   * karena `LIKE` sudah tidak ada sama sekali, bukan karena tes ini menangkapnya.
   * Yang benar-benar dijaga di sini adalah jalur BARU-nya: daftar yang ikut
   * berubah saat project disimpan ulang, dihapus, dan diisi susulan untuk
   * project lama.
   */
  it('project BESAR tidak lagi menjatuhkan penghapusan lagu', async () => {
    const cookie = await login();
    await seedTrack(cookie, HASH_A);

    // ~2 MB JSON: ukuran yang membuat pemindaian LIKE jatuh.
    const besar = {
      lanes: [{ clips: [{ contentHash: HASH_A }] }],
      sampah: 'x'.repeat(2 * 1024 * 1024),
    };
    const { id } = await (await call('/projects', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: 'Besar', json: besar }),
    })).json() as { id: string };
    await call(`/projects/${id}/tracks/${HASH_A}`, { method: 'POST', cookie });

    const res = await call(`/tracks/${HASH_A}`, { method: 'DELETE', cookie });
    expect(res.status).toBe(409);
    expect((await res.json()).message).toContain('Besar');
  });

  it('lagu yang tidak dipakai siapa pun tetap bisa dihapus', async () => {
    const cookie = await login();
    await seedTrack(cookie, HASH_A);
    await seedTrack(cookie, HASH_B);
    await call('/projects', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: 'A', json: { lanes: [{ clips: [{ contentHash: HASH_A }] }] } }),
    });

    expect((await call(`/tracks/${HASH_B}`, { method: 'DELETE', cookie })).status).toBe(200);
  });

  it('mengganti timeline tidak membuang anggota folder project', async () => {
    const cookie = await login();
    await seedTrack(cookie, HASH_A);
    await seedTrack(cookie, HASH_B);

    const { id } = await (await call('/projects', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: 'A', json: { lanes: [{ clips: [{ contentHash: HASH_A }] }] } }),
    })).json();
    await call(`/projects/${id}/tracks/${HASH_A}`, { method: 'POST', cookie });

    // Disimpan ulang tanpa HASH_A.
    await call(`/projects/${id}`, {
      method: 'PUT',
      cookie,
      headers: { 'if-match': '"1"' },
      body: JSON.stringify({ name: 'A', json: { lanes: [{ clips: [{ contentHash: HASH_B }] }] } }),
    });

    // Project adalah folder: menghapus clip bukan berarti mengeluarkan lagunya
    // dari folder. Keduanya baru lepas lewat endpoint membership yang sadar.
    expect((await call(`/tracks/${HASH_A}`, { method: 'DELETE', cookie })).status).toBe(409);
    expect((await call(`/tracks/${HASH_B}`, { method: 'DELETE', cookie })).status).toBe(200);
    await call(`/projects/${id}/tracks/${HASH_A}`, { method: 'DELETE', cookie });
    expect((await call(`/tracks/${HASH_A}`, { method: 'DELETE', cookie })).status).toBe(404);
  });

  it('project yang dihapus melepas semua lagunya', async () => {
    const cookie = await login();
    await seedTrack(cookie, HASH_A);
    const { id } = await (await call('/projects', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: 'A', json: { lanes: [{ clips: [{ contentHash: HASH_A }] }] } }),
    })).json();
    await call(`/projects/${id}/tracks/${HASH_A}`, { method: 'POST', cookie });

    await call(`/projects/${id}`, { method: 'DELETE', cookie });
    expect((await call(`/tracks/${HASH_A}`, { method: 'DELETE', cookie })).status).toBe(404);
  });

  it('JSON project lama tidak otomatis mencemari membership folder', async () => {
    const cookie = await login();
    await seedTrack(cookie, HASH_A);
    const { id } = await (await call('/projects', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: 'Lama', json: { lanes: [{ clips: [{ contentHash: HASH_A }] }] } }),
    })).json();

    // Membership folder hanya berasal dari aksi folder yang eksplisit, bukan
    // hasil menyisir JSON timeline lama.
    db.exec(`DELETE FROM project_track WHERE project_id = '${id}'`);
    db.exec(`UPDATE project SET tracks_indexed = 0 WHERE id = '${id}'`);

    const res = await call(`/tracks/${HASH_A}`, { method: 'DELETE', cookie });
    expect(res.status).toBe(200);
  });
});

describe('rute tak dikenal', () => {
  it('404 menyebut path-nya', async () => {
    const cookie = await login();
    const res = await call('/apa-ini', { cookie });
    expect(res.status).toBe(404);
    expect((await res.json()).message).toContain('/apa-ini');
  });

  it('metode yang salah dijawab 405 — path-nya ADA, cara memanggilnya yang salah', async () => {
    const cookie = await login();
    for (const [path, method] of [
      ['/tracks', 'POST'],
      ['/tracks/init', 'GET'],
      ['/tracks/commit', 'GET'],
      ['/projects', 'PATCH'],
      ['/auth/logout', 'GET'],
      [`/tracks/${HASH_A}/blob`, 'POST'],
    ] as const) {
      const res = await call(path, { method, cookie });
      expect([path, res.status]).toEqual([path, 405]);
    }
  });
});

describe('waktu', () => {
  it('sesi kedaluwarsa tidak lagi berlaku', async () => {
    vi.useFakeTimers();
    try {
      const cookie = await login();
      expect((await call('/me', { cookie })).status).toBe(200);
      // TTL bawaan 30 hari.
      vi.setSystemTime(new Date(Date.now() + 31 * 86_400_000));
      expect((await call('/me', { cookie })).status).toBe(401);
    } finally {
      vi.useRealTimers();
    }
  });
});
