/**
 * Klien Open Cloud — satu-satunya berkas yang tahu bentuk API Roblox.
 *
 * Kontraknya (create.roblox.com/docs/cloud/guides/usage-assets):
 *
 *   POST {base}/assets/v1/assets          multipart: `request` (JSON) + `fileContent`
 *     → 200 { "path": "operations/{id}", "operationId": "...", "done": false }
 *   GET  {base}/assets/v1/operations/{id}
 *     → { "done": true, "response": { "assetId": "123", … } }  atau  { "done": false }
 *
 * Keduanya memakai header `x-api-key`.
 *
 * ## Unggahan TIDAK ditunggu sampai selesai di sini
 *
 * Roblox mengembalikan operasi, bukan asset: byte-nya diterima lalu dimoderasi
 * secara asinkron, dan itu bisa makan menit. Worker yang menahan koneksi sampai
 * `done` akan (a) menabrak batas waktu, dan (b) membuat kegagalan jaringan di
 * detik ke-90 tampak seperti unggahan yang gagal padahal asset-nya sudah masuk.
 * Jadi endpoint unggah mengembalikan `operationId`, dan yang menanyakan
 * "sudah selesai belum" adalah UI — status `MODERASI` di antreannya memang ada
 * untuk fase ini.
 */

export interface OpenCloudConfig {
  /** Basis API, tanpa slash di ujung. */
  readonly base: string;
  /** API key milik USER, diteruskan apa adanya. Tidak pernah disimpan/dilog. */
  readonly apiKey: string;
  /** Disuntik di tes. Default `globalThis.fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Batas waktu satu panggilan ke Roblox. */
  readonly timeoutMs?: number;
}

export interface CreateAudioInput {
  readonly bytes: ArrayBuffer;
  readonly fileName: string;
  readonly mime: string;
  readonly name: string;
  readonly description: string;
  readonly creatorKind: 'user' | 'group';
  readonly creatorId: string;
}

/** Hasil satu panggilan: sukses membawa data, gagal membawa alasan yang layak dibaca. */
export type OpenCloudResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly message: string };

export interface CreatedOperation {
  readonly operationId: string;
  readonly done: boolean;
  /** Terisi kalau Roblox kebetulan sudah selesai saat itu juga. */
  readonly assetId: string | null;
}

export interface OperationState {
  readonly done: boolean;
  readonly assetId: string | null;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Buang slash di ujung supaya `${base}/assets/...` tidak jadi `//assets`. */
export function normalizeBase(base: string): string {
  return base.replace(/\/+$/, '');
}

/**
 * Kirim satu berkas audio.
 *
 * Bagian `request` dikirim sebagai Blob ber-`type: application/json`, BUKAN
 * string biasa: `FormData.append(name, string)` menghasilkan bagian
 * `text/plain`, dan Open Cloud menolaknya dengan INVALID_ARGUMENT yang tidak
 * menyebut sebabnya. Ini persis padanan `-F 'request=…;type=application/json'`
 * di contoh curl dokumentasinya.
 */
export async function createAudioAsset(
  cfg: OpenCloudConfig,
  input: CreateAudioInput,
): Promise<OpenCloudResult<CreatedOperation>> {
  const creator =
    input.creatorKind === 'group' ? { groupId: input.creatorId } : { userId: input.creatorId };

  const meta = JSON.stringify({
    assetType: 'Audio',
    displayName: input.name,
    description: input.description,
    creationContext: { creator },
  });

  const form = new FormData();
  form.append('request', new Blob([meta], { type: 'application/json' }));
  form.append('fileContent', new Blob([input.bytes], { type: input.mime }), input.fileName);

  const res = await call(cfg, `${normalizeBase(cfg.base)}/assets/v1/assets`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) return res;

  const body = res.value;
  const operationId = readOperationId(body);
  if (operationId === null) {
    return {
      ok: false,
      status: 502,
      code: 'BALASAN_TIDAK_DIKENALI',
      message: 'Roblox menerima berkasnya tapi tidak menyebut id operasinya',
    };
  }
  return {
    ok: true,
    value: { operationId, done: body.done === true, assetId: readAssetId(body) },
  };
}

/** Tanyakan status satu operasi. */
export async function getOperation(
  cfg: OpenCloudConfig,
  operationId: string,
): Promise<OpenCloudResult<OperationState>> {
  const res = await call(
    cfg,
    `${normalizeBase(cfg.base)}/assets/v1/operations/${encodeURIComponent(operationId)}`,
    { method: 'GET' },
  );
  if (!res.ok) return res;

  const body = res.value;
  const assetId = readAssetId(body);

  /*
   * Operasi yang `done` tapi membawa `error` adalah KEGAGALAN, bukan sukses
   * tanpa assetId. Ini jalur yang dilewati audio yang ditolak moderasi, dan
   * memperlakukannya sebagai "selesai" membuat antrean menampilkan SELESAI
   * untuk berkas yang sebetulnya tidak pernah jadi asset.
   */
  const err = body.error;
  if (body.done === true && err !== undefined && err !== null) {
    return {
      ok: false,
      status: 422,
      code: typeof err.code === 'string' ? err.code : 'OPERASI_GAGAL',
      message:
        typeof err.message === 'string' && err.message !== ''
          ? err.message
          : 'Roblox menolak asset ini tanpa menyebut alasannya',
    };
  }

  return { ok: true, value: { done: body.done === true, assetId } };
}

// ── Jalur bersama ────────────────────────────────────────────────────────────

interface LooseBody {
  readonly done?: unknown;
  readonly path?: unknown;
  readonly operationId?: unknown;
  readonly assetId?: unknown;
  readonly response?: { readonly assetId?: unknown; readonly path?: unknown } | null;
  readonly error?: { readonly code?: unknown; readonly message?: unknown } | null;
  readonly code?: unknown;
  readonly message?: unknown;
}

async function call(
  cfg: OpenCloudConfig,
  url: string,
  init: { method: string; body?: BodyInit },
): Promise<OpenCloudResult<LooseBody>> {
  const doFetch = cfg.fetchImpl ?? globalThis.fetch;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let res: Response;
  try {
    res = await doFetch(url, {
      method: init.method,
      // Content-Type SENGAJA tidak dipasang untuk FormData: boundary-nya
      // dihasilkan runtime, dan menuliskannya sendiri menghasilkan boundary
      // yang tidak cocok dengan badan yang benar-benar dikirim.
      headers: { 'x-api-key': cfg.apiKey, accept: 'application/json' },
      ...(init.body === undefined ? null : { body: init.body }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: unknown) {
    const aborted = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      ok: false,
      status: 504,
      code: aborted ? 'WAKTU_HABIS' : 'JARINGAN',
      message: aborted
        ? `Roblox tidak menjawab dalam ${Math.round(timeoutMs / 1000)} detik`
        : `tidak bisa menghubungi Roblox: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const text = await res.text();
  const body = parseJson(text);

  if (!res.ok) return { ok: false, ...describeFailure(res.status, body, text) };
  if (body === null) {
    return {
      ok: false,
      status: 502,
      code: 'BALASAN_TIDAK_DIKENALI',
      message: 'Roblox menjawab dengan sesuatu yang bukan JSON',
    };
  }
  return { ok: true, value: body };
}

function parseJson(text: string): LooseBody | null {
  if (text.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as LooseBody) : null;
  } catch {
    return null;
  }
}

/**
 * Terjemahkan kegagalan Roblox jadi kalimat yang bisa DIKERJAKAN user.
 *
 * "HTTP 403" tidak memberi tahu siapa pun harus berbuat apa. Tiga penyebab
 * paling sering di jalur ini punya perbaikan yang sangat berbeda — kunci salah,
 * izin kurang, atau allowlist IP kunci tidak mengizinkan Worker — dan yang
 * terakhir itu jebakan yang hampir selalu kena saat pertama kali dipasang,
 * karena IP keluar Cloudflare tidak tetap.
 */
export function describeFailure(
  status: number,
  body: LooseBody | null,
  raw: string,
): { status: number; code: string; message: string } {
  const detail =
    (typeof body?.message === 'string' && body.message) ||
    (typeof body?.error?.message === 'string' && body.error.message) ||
    raw.slice(0, 200);
  const code =
    (typeof body?.code === 'string' && body.code) ||
    (typeof body?.error?.code === 'string' && body.error.code) ||
    `HTTP_${status}`;

  const say = (s: string): { status: number; code: string; message: string } => ({
    status,
    code,
    message: detail === '' ? s : `${s} (${detail})`,
  });

  if (status === 400) return say('Roblox menolak metadata unggahan ini');
  if (status === 401) return say('API key tidak dikenali atau sudah dicabut');
  if (status === 403) {
    return say(
      'API key ditolak: pastikan ia punya izin asset (write) untuk pemilik ini, ' +
        'dan allowlist IP-nya mengizinkan 0.0.0.0/0 — IP keluar Worker tidak tetap',
    );
  }
  if (status === 404) return say('endpoint atau operasi tidak ditemukan di Roblox');
  if (status === 413) return say('berkas ditolak Roblox karena terlalu besar');
  if (status === 429) return say('kuota unggah Roblox habis atau permintaan terlalu cepat');
  if (status >= 500) return say('Roblox sedang bermasalah');
  return say(`Roblox menolak permintaan ini (HTTP ${status})`);
}

/** `operationId`, atau ekor dari `path: "operations/{id}"`. */
function readOperationId(body: LooseBody): string | null {
  if (typeof body.operationId === 'string' && body.operationId !== '') return body.operationId;
  if (typeof body.path === 'string') {
    const tail = body.path.split('/').filter((s) => s !== '').pop();
    if (tail !== undefined && tail !== 'operations') return tail;
  }
  return null;
}

/** `assetId` boleh muncul di akar, di `response`, atau cuma sebagai `assets/{id}`. */
function readAssetId(body: LooseBody): string | null {
  const direct = body.response?.assetId ?? body.assetId;
  if (typeof direct === 'string' && direct !== '') return direct;
  if (typeof direct === 'number') return String(direct);

  const path = body.response?.path;
  if (typeof path === 'string' && path.startsWith('assets/')) {
    const tail = path.slice('assets/'.length);
    if (tail !== '') return tail;
  }
  return null;
}
