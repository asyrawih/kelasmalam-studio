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

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleRequest, type Deps } from './worker';
import type { Env } from './bindings';
import { openTestDb, type TestDb } from '../test-support/d1-sqlite';
import { fakeR2, type FakeR2 } from '../test-support/fake-r2';

const SCHEMA = readFileSync(new URL('../../migrations/0001_init.sql', import.meta.url), 'utf8');

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
  init: RequestInit & { cookie?: string } = {},
  deps: Deps = {},
): Promise<Response> => {
  const headers = new Headers(init.headers);
  headers.set('origin', APP);
  if (init.cookie !== undefined) headers.set('cookie', init.cookie);
  return handleRequest(new Request(`${API}${path}`, { ...init, headers }), env, deps);
};

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
    await call('/projects', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: 'Set malam', json: projectWith(HASH_A) }),
    });

    const res = await call(`/tracks/${HASH_A}`, { method: 'DELETE', cookie });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('MASIH_DIPAKAI');
    expect(body.message).toContain('Set malam');
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
