/**
 * Worker KEPUSTAKAAN — implementasi `docs/16 §4`.
 *
 *   GET    /health
 *   GET    /auth/google            redirect ke consent (PKCE)
 *   GET    /auth/callback          tukar code → sesi → redirect balik ke app
 *   POST   /auth/logout
 *   GET    /me
 *   GET    /tracks
 *   POST   /tracks/init            {exists:true} ATAU {uploadUrl}
 *   POST   /tracks/commit
 *   GET    /tracks/:hash/blob      lewat Worker, bukan presigned (§5a)
 *   PUT    /tracks/:hash/marks
 *   DELETE /tracks/:hash           lepas klaim, bukan hapus objek (§8d)
 *   GET    /projects
 *   POST   /projects
 *   GET    /projects/:id
 *   PUT    /projects/:id           If-Match: version (§8c)
 *   DELETE /projects/:id
 *
 * ## Asimetri yang paling mudah dikira bug
 *
 * **Upload langsung ke R2** (presigned PUT), **unduhan lewat Worker.** Bukan
 * ketidakkonsistenan: aplikasi ini berjalan dengan COEP `require-corp` — syarat
 * `crossOriginIsolated`, syarat `SharedArrayBuffer`, syarat seluruh engine.
 * Respons R2 tidak membawa `Cross-Origin-Resource-Policy`, jadi audio yang
 * diunduh langsung darinya DITOLAK browser, dengan pesan galat yang tidak
 * menyebut CORP sama sekali. Unduhan karena itu harus lewat sesuatu yang bisa
 * menambahkan header itu. Upload tidak punya masalah yang sama, dan punya
 * masalah lain (batas badan permintaan Worker) yang membuatnya harus langsung.
 */

import { decideCors, parseOrigins, preflight, withCors } from '../http/cors';
import type { Env } from './bindings';
import { authorizeUrl, exchangeCode, newPkce } from './oauth';
import { presignPut } from './presign';
import {
  OAUTH_COOKIE,
  SESSION_COOKIE,
  buildCookie,
  clearCookie,
  hashToken,
  newToken,
  readCookie,
} from './session';
import { Store, type UserRow } from './store';

/** Disuntik tes: penukaran code memanggil Google, dan tes tidak boleh. */
export interface Deps {
  readonly fetchImpl?: typeof fetch;
}

const HASH_RE = /^[0-9a-f]{64}$/;
const MIME_ALLOW = new Set(['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/flac']);

/** Batas bawaan satu berkas: di atas ini butuh multipart, yang belum ada (§5c). */
const DEFAULT_MAX_TRACK_BYTES = 100 * 1024 * 1024;
const DEFAULT_SESSION_TTL_DAYS = 30;
const UPLOAD_URL_TTL_SECONDS = 15 * 60;
/** Cue + grid satu lagu. Longgar, tapi bukan tanpa batas. */
const MAX_MARKS_BYTES = 256 * 1024;
const MAX_PROJECT_BYTES = 8 * 1024 * 1024;

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}

const fail = (status: number, code: string, message: string): Response =>
  json({ code, message }, status);

const num = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export async function handleRequest(request: Request, env: Env, deps: Deps = {}): Promise<Response> {
  /*
   * `??` TIDAK cukup di sini: ia hanya jatuh ke cadangan saat nilainya
   * `undefined`, sementara `wrangler.toml` mengirim STRING KOSONG untuk var
   * yang sengaja dikosongkan. Dengan `??`, `ALLOWED_ORIGINS = ""` berarti
   * "tidak ada origin yang diizinkan" — Worker menolak aplikasinya sendiri,
   * dan gejalanya hanya galat CORS di browser yang tidak menyebut var ini.
   */
  const configured = parseOrigins(env.ALLOWED_ORIGINS);
  const allowed = configured.length > 0 ? configured : parseOrigins(env.APP_ORIGIN);
  const cors = decideCors(request.headers.get('origin'), allowed);

  if (request.method === 'OPTIONS') return preflight(cors.allowOrigin, { credentials: true });
  if (cors.rejected) return fail(403, 'ORIGIN_DITOLAK', 'origin ini tidak diizinkan');

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  const res = await route(request, env, deps, url, path);
  /*
   * `credentials: true` di SETIAP balasan, bukan hanya di preflight: tanpa
   * `Access-Control-Allow-Credentials` pada respons sungguhan, browser
   * membuang balasannya — dan yang terlihat di sisi app adalah galat jaringan
   * tanpa sebab, bukan pesan CORS.
   */
  return withCors(res, cors.allowOrigin, { credentials: true });
}

async function route(
  request: Request,
  env: Env,
  deps: Deps,
  url: URL,
  path: string,
): Promise<Response> {
  const store = new Store(env.DB);
  const method = request.method;

  if (path === '/health' || path === '/') {
    return json({ ok: true, service: 'dawonweb-library' });
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  if (path === '/auth/google') {
    if (method !== 'GET') return fail(405, 'METODE', 'pakai GET');
    const { verifier, challenge } = await newPkce();
    const state = newToken();
    // Ke mana user dikembalikan sesudah login. Hanya path relatif yang
    // diterima: nilai dari query string yang boleh berisi origin adalah open
    // redirect, dan open redirect di alur OAuth adalah cara code dicuri.
    const back = safePath(url.searchParams.get('next'));

    return new Response(null, {
      status: 302,
      headers: {
        location: authorizeUrl({
          clientId: env.GOOGLE_CLIENT_ID,
          redirectUri: `${env.API_ORIGIN}/auth/callback`,
          state,
          challenge,
        }),
        'set-cookie': buildCookie(OAUTH_COOKIE, `${state}.${verifier}.${btoa(back)}`, {
          maxAgeSeconds: 600,
        }),
      },
    });
  }

  if (path === '/auth/callback') {
    if (method !== 'GET') return fail(405, 'METODE', 'pakai GET');
    const cookie = readCookie(request.headers.get('cookie'), OAUTH_COOKIE);
    if (cookie === null) return fail(400, 'STATE_HILANG', 'alur login kedaluwarsa — ulangi');

    const [state, verifier, backB64] = cookie.split('.');
    if (state === undefined || verifier === undefined) {
      return fail(400, 'STATE_RUSAK', 'alur login tidak bisa dilanjutkan — ulangi');
    }
    if (url.searchParams.get('state') !== state) {
      return fail(400, 'STATE_TIDAK_COCOK', 'state tidak cocok — permintaan ditolak');
    }
    const code = url.searchParams.get('code');
    if (code === null) {
      const err = url.searchParams.get('error') ?? 'tanpa alasan';
      return fail(400, 'DIBATALKAN', `Google tidak memberi code (${err})`);
    }

    const exchanged = await exchangeCode(
      {
        code,
        verifier,
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        redirectUri: `${env.API_ORIGIN}/auth/callback`,
      },
      deps.fetchImpl ?? globalThis.fetch,
    );
    if (!exchanged.ok) return fail(401, 'LOGIN_GAGAL', exchanged.message);

    const user = await store.upsertUser(exchanged.profile);
    const token = newToken();
    const ttlMs = num(env.SESSION_TTL_DAYS, DEFAULT_SESSION_TTL_DAYS) * 86_400_000;
    await store.createSession(await hashToken(token), user.id, ttlMs);

    const back = backB64 === undefined ? '/' : safePath(safeAtob(backB64));
    const headers = new Headers({ location: `${env.APP_ORIGIN}${back}` });
    headers.append('set-cookie', buildCookie(SESSION_COOKIE, token, { maxAgeSeconds: ttlMs / 1000 }));
    headers.append('set-cookie', clearCookie(OAUTH_COOKIE));
    return new Response(null, { status: 302, headers });
  }

  if (path === '/auth/logout') {
    if (method !== 'POST') return fail(405, 'METODE', 'pakai POST');
    const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
    if (token !== null) await store.revokeSession(await hashToken(token));
    return json({ ok: true }, 200, { 'set-cookie': clearCookie(SESSION_COOKIE) });
  }

  // ── Mulai dari sini semuanya butuh sesi ───────────────────────────────────

  const user = await currentUser(request, store);
  if (path === '/me') {
    if (method !== 'GET') return fail(405, 'METODE', 'pakai GET');
    return user === null
      ? fail(401, 'BELUM_LOGIN', 'belum login')
      : json({ id: user.id, email: user.email, name: user.name });
  }
  if (user === null) return fail(401, 'BELUM_LOGIN', 'belum login');

  // ── Tracks ────────────────────────────────────────────────────────────────

  if (path === '/tracks') {
    if (method !== 'GET') return fail(405, 'METODE', 'pakai GET');
    const rows = await store.listTracks(user.id);
    return json({
      tracks: rows.map((t) => ({
        hash: t.hash,
        name: t.name,
        bytes: t.bytes,
        mime: t.mime,
        frames: t.frames,
        sampleRate: t.sample_rate,
        // Marks dikirim SUDAH terurai, bukan sebagai string JSON di dalam JSON.
        // Pemanggil yang harus mem-parse dua kali pasti suatu saat lupa.
        marks: t.marks === null ? null : safeParse(t.marks),
      })),
    });
  }

  if (path === '/tracks/init') {
    if (method !== 'POST') return fail(405, 'METODE', 'pakai POST');
    const body = await readJson<{ hash?: unknown; name?: unknown; bytes?: unknown; mime?: unknown }>(request);
    if (body === null) return fail(400, 'JSON', 'badan permintaan bukan JSON');

    const hash = String(body.hash ?? '');
    if (!HASH_RE.test(hash)) return fail(400, 'HASH', 'hash harus SHA-256 heksadesimal 64 karakter');

    const bytes = Number(body.bytes);
    if (!Number.isFinite(bytes) || bytes <= 0) return fail(400, 'UKURAN', 'ukuran tidak masuk akal');

    const maxTrack = num(env.MAX_TRACK_BYTES, DEFAULT_MAX_TRACK_BYTES);
    if (bytes > maxTrack) {
      // Ditolak DI SINI, sebelum satu byte pun naik — bukan gagal di tengah
      // upload sesudah user menunggu tiga menit (§5c).
      return fail(
        413,
        'TERLALU_BESAR',
        `berkas ${bytes} byte melewati batas ${maxTrack} byte; unggahan sebesar itu butuh multipart yang belum ada`,
      );
    }

    const mime = String(body.mime ?? '');
    if (!MIME_ALLOW.has(mime)) return fail(400, 'MIME', `jenis berkas ${mime || '?'} tidak didukung`);

    const quota = Number(env.MAX_USER_BYTES);
    if (Number.isFinite(quota) && quota > 0) {
      const used = await store.bytesUsed(user.id);
      if (used + bytes > quota) {
        return fail(
          409,
          'KUOTA',
          `kepustakaan kamu sudah memakai ${used} dari ${quota} byte — hapus lagu lain dulu`,
        );
      }
    }

    // Inti dedup: objeknya sudah ada, jadi tidak ada yang perlu naik. Baris
    // klaimnya tetap ditulis lewat /tracks/commit, sama seperti jalur biasa.
    const existing = await env.TRACKS.head(objectKey(hash));
    if (existing !== null) return json({ exists: true });

    const signed = await presignPut({
      accountId: env.R2_ACCOUNT_ID,
      bucket: env.R2_BUCKET,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      key: objectKey(hash),
      expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
      now: new Date(),
    });
    return json({ exists: false, uploadUrl: signed.url, expiresIn: UPLOAD_URL_TTL_SECONDS });
  }

  if (path === '/tracks/commit') {
    if (method !== 'POST') return fail(405, 'METODE', 'pakai POST');
    const body = await readJson<Record<string, unknown>>(request);
    if (body === null) return fail(400, 'JSON', 'badan permintaan bukan JSON');

    const hash = String(body.hash ?? '');
    if (!HASH_RE.test(hash)) return fail(400, 'HASH', 'hash harus SHA-256 heksadesimal 64 karakter');

    /*
     * Objeknya diperiksa ke R2, bukan dipercaya dari pemanggil. Tanpa ini
     * siapa pun bisa mendaftarkan baris untuk hash yang tidak pernah ada, dan
     * kepustakaannya penuh lagu yang gagal diunduh dengan 404 yang membingungkan
     * jauh dari tempat kesalahannya dibuat.
     */
    const head = await env.TRACKS.head(objectKey(hash));
    if (head === null) {
      return fail(409, 'BELUM_TERUNGGAH', 'byte-nya belum ada di penyimpanan — ulangi unggahannya');
    }

    const bytes = Number(body.bytes);
    if (Number.isFinite(bytes) && bytes > 0 && head.size !== bytes) {
      return fail(
        409,
        'UKURAN_TIDAK_COCOK',
        `yang terunggah ${head.size} byte, yang dicatatkan ${bytes} byte`,
      );
    }

    await store.claimTrack(user.id, {
      hash,
      name: String(body.name ?? 'Tanpa nama').slice(0, 200),
      bytes: head.size,
      mime: String(body.mime ?? 'application/octet-stream'),
      frames: Math.max(0, Math.trunc(Number(body.frames) || 0)),
      sampleRate: Math.max(0, Math.trunc(Number(body.sampleRate) || 0)),
    });
    return json({ ok: true, hash });
  }

  const blob = path.match(/^\/tracks\/([0-9a-f]{64})\/blob$/);
  if (blob !== null) {
    if (method !== 'GET') return fail(405, 'METODE', 'pakai GET');
    const hash = blob[1] ?? '';
    // Klaim diperiksa: hash memang tidak bisa ditebak, tapi "sulit ditebak"
    // bukan kontrol akses. Yang boleh mengunduh adalah yang punya barisnya.
    if (!(await store.hasClaim(user.id, hash))) {
      return fail(404, 'TIDAK_ADA', 'lagu ini tidak ada di kepustakaanmu');
    }
    const object = await env.TRACKS.get(objectKey(hash));
    if (object === null || object.body === null) {
      return fail(404, 'HILANG', 'byte-nya tidak ada di penyimpanan');
    }

    return new Response(object.body, {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(object.size),
        // Inti §5a. Tanpa baris ini, halaman ber-COEP require-corp menolak
        // hasil unduhan ini tanpa menyebut CORP sama sekali.
        'cross-origin-resource-policy': 'cross-origin',
        // Isinya ditentukan oleh hash-nya, jadi ia tidak akan pernah berubah.
        'cache-control': 'private, max-age=31536000, immutable',
        etag: `"${hash}"`,
      },
    });
  }

  const marks = path.match(/^\/tracks\/([0-9a-f]{64})\/marks$/);
  if (marks !== null) {
    if (method !== 'PUT') return fail(405, 'METODE', 'pakai PUT');
    const hash = marks[1] ?? '';
    if (!(await store.hasClaim(user.id, hash))) {
      return fail(404, 'TIDAK_ADA', 'lagu ini tidak ada di kepustakaanmu');
    }
    const text = await request.text();
    if (text.length > MAX_MARKS_BYTES) return fail(413, 'TERLALU_BESAR', 'cue/grid terlalu besar');
    if (safeParse(text) === null) return fail(400, 'JSON', 'badan permintaan bukan JSON');

    await store.putMarks(user.id, hash, text);
    return json({ ok: true });
  }

  const track = path.match(/^\/tracks\/([0-9a-f]{64})$/);
  if (track !== null) {
    if (method !== 'DELETE') return fail(405, 'METODE', 'pakai DELETE');
    const hash = track[1] ?? '';

    /*
     * Menolak menghapus lagu yang masih dipakai project, DENGAN MENYEBUT
     * project mana. Ini kriteria "done" L7, dan alasannya: project yang
     * merujuk asset hilang tidak gagal saat dihapus melainkan saat DIBUKA,
     * berminggu-minggu kemudian, tanpa petunjuk apa yang hilang.
     */
    const used = await store.projectsReferencing(user.id, hash);
    if (used.length > 0) {
      return json(
        {
          code: 'MASIH_DIPAKAI',
          message: `lagu ini masih dipakai ${used.length} project: ${used.map((p) => p.name).join(', ')}`,
          projects: used,
        },
        409,
      );
    }

    const removed = await store.releaseTrack(user.id, hash);
    return removed
      ? json({ ok: true })
      : fail(404, 'TIDAK_ADA', 'lagu ini tidak ada di kepustakaanmu');
  }

  // ── Projects ──────────────────────────────────────────────────────────────

  if (path === '/projects') {
    if (method === 'GET') {
      const rows = await store.listProjects(user.id);
      return json({
        projects: rows.map((p) => ({
          id: p.id,
          name: p.name,
          updatedAt: p.updated_at,
          version: p.version,
        })),
      });
    }
    if (method === 'POST') {
      const parsed = await readProjectBody(request);
      if ('error' in parsed) return parsed.error;
      const missing = await missingClaims(store, user.id, parsed.json);
      if (missing.length > 0) return missingResponse(missing);

      const made = await store.createProject(user.id, parsed.name, parsed.json);
      return json({ id: made.id, version: made.version }, 201);
    }
    return fail(405, 'METODE', 'pakai GET atau POST');
  }

  const project = path.match(/^\/projects\/([A-Za-z0-9-]+)$/);
  if (project !== null) {
    const id = project[1] ?? '';

    if (method === 'GET') {
      const row = await store.getProject(user.id, id);
      if (row === null) return fail(404, 'TIDAK_ADA', 'project tidak ditemukan');
      return json(
        { id: row.id, name: row.name, json: safeParse(row.json), version: row.version },
        200,
        { etag: `"${row.version}"` },
      );
    }

    if (method === 'PUT') {
      /*
       * `If-Match` WAJIB, bukan opsional.
       *
       * Simpan tanpa versi berarti "timpa apa pun yang ada di sana", dan itu
       * persis kejadian yang §8c ingin cegah: dua tab, yang belakangan menang
       * diam-diam. 428 adalah kode yang tepat — bukan 400 — karena yang kurang
       * bukan bentuk permintaannya melainkan prasyaratnya.
       */
      const ifMatch = request.headers.get('if-match');
      if (ifMatch === null) {
        return fail(428, 'BUTUH_VERSI', 'sertakan If-Match berisi versi yang kamu suntik');
      }
      const expected = Number(ifMatch.replace(/"/g, ''));
      if (!Number.isFinite(expected)) return fail(400, 'VERSI', 'If-Match harus berisi angka versi');

      const parsed = await readProjectBody(request);
      if ('error' in parsed) return parsed.error;
      const missing = await missingClaims(store, user.id, parsed.json);
      if (missing.length > 0) return missingResponse(missing);

      const saved = await store.updateProject(user.id, id, parsed.name, parsed.json, expected);
      if (saved.ok) return json({ ok: true, version: saved.version }, 200, { etag: `"${saved.version}"` });
      if (saved.current === null) return fail(404, 'TIDAK_ADA', 'project tidak ditemukan');
      return json(
        {
          code: 'VERSI_BASI',
          message: 'project ini sudah berubah di tempat lain — muat ulang sebelum menyimpan',
          currentVersion: saved.current,
        },
        412,
      );
    }

    if (method === 'DELETE') {
      const gone = await store.deleteProject(user.id, id);
      return gone ? json({ ok: true }) : fail(404, 'TIDAK_ADA', 'project tidak ditemukan');
    }

    return fail(405, 'METODE', 'pakai GET, PUT, atau DELETE');
  }

  return fail(404, 'TIDAK_ADA', `tidak ada endpoint ${path}`);
}

// ── Bagian bersama ───────────────────────────────────────────────────────────

/** Kunci R2. Hash-nya, bukan `<user>/<nama>` — dua user berbagi satu objek (§3). */
function objectKey(hash: string): string {
  return `tracks/${hash}`;
}

async function currentUser(request: Request, store: Store): Promise<UserRow | null> {
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  if (token === null) return null;
  return await store.userForSession(await hashToken(token));
}

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    const parsed: unknown = await request.json();
    return typeof parsed === 'object' && parsed !== null ? (parsed as T) : null;
  } catch {
    return null;
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function safeAtob(value: string): string {
  try {
    return atob(value);
  } catch {
    return '/';
  }
}

/** Hanya path relatif satu garis miring. Segalanya yang lain jadi `/`. */
function safePath(value: string | null): string {
  if (value === null || !value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

async function readProjectBody(
  request: Request,
): Promise<{ name: string; json: string } | { error: Response }> {
  const text = await request.text();
  if (text.length > MAX_PROJECT_BYTES) {
    return { error: fail(413, 'TERLALU_BESAR', 'project terlalu besar') };
  }
  const body = safeParse(text) as { name?: unknown; json?: unknown } | null;
  if (body === null) return { error: fail(400, 'JSON', 'badan permintaan bukan JSON') };
  if (body.json === undefined || body.json === null) {
    return { error: fail(400, 'KOSONG', 'field `json` wajib ada') };
  }
  return {
    name: String(body.name ?? 'Tanpa judul').slice(0, 200),
    // Disimpan sebagai TEXT apa adanya. Bentuknya milik `serialize()` di sisi
    // web, dan server tidak punya pendapat tentang isinya (§3).
    json: JSON.stringify(body.json),
  };
}

/**
 * Hash yang disebut project tapi tidak diklaim user ini.
 *
 * Kriteria "done" L6: menolak menyimpan project yang merujuk asset yang belum
 * ter-commit. Kalau lolos, yang tersimpan adalah project yang PASTI gagal
 * dibuka nanti — dan gagalnya jauh dari sini.
 *
 * Yang dicari adalah field bernama `contentHash`/`content_hash`, bukan setiap
 * string 64-heksadesimal di mana pun: pemindaian buta akan menuduh nama lagu
 * yang kebetulan berbentuk hash. Saat L1 mengunci bentuk serialisasinya,
 * fungsi ini yang ikut menyempit.
 */
async function missingClaims(store: Store, userId: string, projectJson: string): Promise<readonly string[]> {
  const hashes = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    for (const [key, value] of Object.entries(node)) {
      if ((key === 'contentHash' || key === 'content_hash') && typeof value === 'string' && HASH_RE.test(value)) {
        hashes.add(value);
      } else {
        walk(value);
      }
    }
  };
  walk(safeParse(projectJson));

  const missing: string[] = [];
  for (const hash of hashes) {
    if (!(await store.hasClaim(userId, hash))) missing.push(hash);
  }
  return missing;
}

function missingResponse(missing: readonly string[]): Response {
  return json(
    {
      code: 'ASSET_BELUM_TERSIMPAN',
      message: `${missing.length} lagu yang dipakai project ini belum ada di kepustakaan — unggah dulu`,
      missing,
    },
    409,
  );
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
