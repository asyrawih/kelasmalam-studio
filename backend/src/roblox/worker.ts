/**
 * Worker unggah asset audio Roblox.
 *
 * Tiga endpoint, dan tidak lebih:
 *
 *   GET  /health                  → { ok, service }         probe kesiapan dari UI
 *   POST /roblox/uploads          → { operationId, done }    kirim satu berkas
 *   GET  /roblox/operations/{id}  → { done, assetId }        tanya sudah selesai belum
 *
 * ## Kenapa Worker ini ada sama sekali
 *
 * Bukan karena browser tidak bisa menyusun multipart. Dua alasan yang keduanya
 * mengikat: `apis.roblox.com` tidak mengirim header CORS, jadi panggilan dari
 * halaman akan diblokir browser sebelum sempat berangkat — dan API key Open
 * Cloud tidak punya bentuk yang aman untuk dipakai langsung dari halaman.
 *
 * ## Kunci milik user, bukan milik Worker
 *
 * `x-roblox-api-key` datang dari pemanggil pada SETIAP permintaan, dipakai
 * sekali, lalu hilang bersama permintaannya. Ia tidak disimpan, tidak di-cache,
 * dan tidak pernah masuk log. Alternatifnya — satu kunci milik server di
 * `wrangler secret` — akan membuat Worker ini jadi lumbung kredensial yang
 * mengunggah atas nama SATU akun untuk siapa pun yang bisa memanggilnya.
 * Rinciannya di README §Kunci.
 */

import { decideCors, parseOrigins, preflight, withCors } from '../http/cors';
import { createAudioAsset, getOperation, type OpenCloudConfig } from './open-cloud';
import { parseUpload } from './upload-request';

export interface Env {
  /** Origin yang boleh memanggil dari browser, dipisah koma. */
  readonly ALLOWED_ORIGINS?: string;
  /** Basis Open Cloud. Ditimpa di tes untuk menunjuk server palsu. */
  readonly ROBLOX_API_BASE?: string;
}

/** Disuntik tes; di produksi keduanya adalah bawaan runtime. */
export interface Deps {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

const DEFAULT_BASE = 'https://apis.roblox.com';
const SERVICE = 'dawonweb-roblox';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

const fail = (status: number, code: string, message: string): Response =>
  json({ code, message }, status);

export async function handleRequest(request: Request, env: Env, deps: Deps = {}): Promise<Response> {
  const allowed = parseOrigins(env.ALLOWED_ORIGINS);
  const cors = decideCors(request.headers.get('origin'), allowed);

  if (request.method === 'OPTIONS') return preflight(cors.allowOrigin);
  if (cors.rejected) {
    // Ditolak lebih awal DAN tanpa header CORS: balasan yang tetap membawa
    // `Allow-Origin` untuk origin asing membuat penolakan ini hiasan.
    return fail(403, 'ORIGIN_DITOLAK', 'origin ini tidak ada di ALLOWED_ORIGINS');
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const res = await safeRoute(request, env, deps, path);
  return withCors(res, cors.allowOrigin);
}

/** Lihat catatan kembar di `library/worker.ts`: lemparan tidak boleh lolos. */
async function safeRoute(
  request: Request,
  env: Env,
  deps: Deps,
  path: string,
): Promise<Response> {
  try {
    return await route(request, env, deps, path);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${request.method} ${path}]`, message);
    return fail(500, 'GALAT_INTERNAL', message);
  }
}

async function route(request: Request, env: Env, deps: Deps, path: string): Promise<Response> {
  if (path === '/health' || path === '/') {
    if (request.method !== 'GET') return fail(405, 'METODE', 'pakai GET');
    return json({ ok: true, service: SERVICE });
  }

  const apiKey = request.headers.get('x-roblox-api-key')?.trim() ?? '';

  if (path === '/roblox/uploads') {
    if (request.method !== 'POST') return fail(405, 'METODE', 'pakai POST');
    if (apiKey === '') return fail(401, 'KUNCI_HILANG', 'header x-roblox-api-key wajib diisi');

    const parsed = await parseUpload(request);
    if (!parsed.ok) return fail(400, parsed.code, parsed.message);

    const created = await createAudioAsset(cfg(env, apiKey, deps), parsed.value);
    if (!created.ok) return fail(statusFor(created.status), created.code, created.message);

    /*
     * 202, bukan 200: byte-nya sudah diterima Roblox, tapi asset-nya BELUM ada.
     * Kode yang mengatakan "selesai" untuk sesuatu yang masih diproses adalah
     * cara termurah membuat pemanggil berhenti menanyakan hasilnya.
     */
    return json(created.value, created.value.done ? 200 : 202);
  }

  const op = path.match(/^\/roblox\/operations\/(.+)$/);
  if (op !== null) {
    if (request.method !== 'GET') return fail(405, 'METODE', 'pakai GET');
    if (apiKey === '') return fail(401, 'KUNCI_HILANG', 'header x-roblox-api-key wajib diisi');

    const state = await getOperation(cfg(env, apiKey, deps), decodeURIComponent(op[1] ?? ''));
    if (!state.ok) return fail(statusFor(state.status), state.code, state.message);
    return json(state.value);
  }

  return fail(404, 'TIDAK_ADA', `tidak ada endpoint ${path}`);
}

function cfg(env: Env, apiKey: string, deps: Deps): OpenCloudConfig {
  return {
    base: env.ROBLOX_API_BASE ?? DEFAULT_BASE,
    apiKey,
    ...(deps.fetchImpl === undefined ? null : { fetchImpl: deps.fetchImpl }),
    ...(deps.timeoutMs === undefined ? null : { timeoutMs: deps.timeoutMs }),
  };
}

/**
 * Status Roblox diteruskan APA ADANYA kalau ia berarti bagi pemanggil (401,
 * 403, 429, …), tapi 5xx dari Roblox TIDAK boleh jadi 5xx dari kami: pemanggil
 * akan membaca kegagalan pihak ketiga sebagai Worker yang rusak, dan monitor
 * mana pun yang menghitung 5xx kami akan menyalahkan yang salah. 502 mengatakan
 * yang sebenarnya — hulu yang bermasalah.
 */
function statusFor(robloxStatus: number): number {
  if (robloxStatus >= 500) return 502;
  if (robloxStatus === 400) return 400;
  return robloxStatus;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
