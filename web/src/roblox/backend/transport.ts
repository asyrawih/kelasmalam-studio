/**
 * Lapisan angkut ke Worker unggah (`backend/`). Tidak ada aturan bisnis di
 * sini — hanya URL, header, dan penerjemahan balasan jadi objek/lemparan.
 *
 * ## Unggahannya memakai XMLHttpRequest, bukan fetch
 *
 * `fetch` tidak melaporkan kemajuan pengiriman BADAN permintaan. Yang ada
 * hanyalah progres unduhan, dan itu bukan yang ditunggu orang saat mengirim
 * berkas 18 MB lewat sambungan rumah. `XMLHttpRequest.upload.onprogress`
 * melaporkannya, dan itu satu-satunya alasan API lama ini masih dipakai di
 * repo yang sudah sepenuhnya fetch.
 *
 * Alternatifnya — bar palsu yang bergerak sendiri — akan membuat UI mengarang
 * angka yang tidak ia ketahui, dan angka yang mengarang lebih buruk daripada
 * tidak ada angka.
 */

import type { QueueItem, RobloxTarget } from '../model';

/** Kegagalan yang sudah punya kalimat untuk user. */
export class UploadError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'UploadError';
    this.code = code;
  }
}

export interface StartedUpload {
  readonly operationId: string;
  readonly done: boolean;
  readonly assetId: string | null;
  readonly moderationState?: ModerationState | null;
}

export type ModerationState = 'reviewing' | 'approved' | 'rejected';

export interface OperationState {
  readonly done: boolean;
  readonly assetId: string | null;
  readonly moderationState?: ModerationState | null;
}

export interface Transport {
  /** `true` kalau Worker menjawab. Dipakai untuk badge SIAP/UI ONLY. */
  health(): Promise<boolean>;
  upload(
    item: QueueItem,
    file: File,
    target: RobloxTarget,
    onProgress: (percent: number) => void,
  ): Promise<StartedUpload>;
  operation(operationId: string, apiKey: string): Promise<OperationState>;
}

const KEY_HEADER = 'x-roblox-api-key';
const UPLOAD_TIMEOUT_MS = 60_000;

/** Buang slash di ujung supaya `${base}/roblox/...` tidak jadi `//roblox`. */
export function normalizeBase(base: string): string {
  return base.replace(/\/+$/, '');
}

export function createHttpTransport(baseUrl: string): Transport {
  const base = normalizeBase(baseUrl);

  return {
    async health(): Promise<boolean> {
      try {
        const res = await fetch(`${base}/health`, {
          method: 'GET',
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) return false;
        const body: unknown = await res.json();
        return typeof body === 'object' && body !== null && (body as { ok?: unknown }).ok === true;
      } catch {
        // Worker mati, DNS salah, offline — semuanya berarti hal yang sama bagi
        // halaman: belum tersambung. Yang membedakannya tidak bisa diperbaiki
        // user dari sini, jadi tidak ada gunanya dipisah.
        return false;
      }
    },

    upload(item, file, target, onProgress): Promise<StartedUpload> {
      const form = new FormData();
      form.append('file', file, item.fileName);
      form.append('name', item.name);
      form.append('description', item.description);
      form.append('creatorKind', target.creatorKind);
      form.append('creatorId', target.creatorId.trim());

      return xhrPost(`${base}/roblox/uploads`, form, target.apiKey, onProgress);
    },

    async operation(operationId, apiKey): Promise<OperationState> {
      const res = await fetch(
        `${base}/roblox/operations/${encodeURIComponent(operationId)}`,
        {
          method: 'GET',
          headers: { [KEY_HEADER]: apiKey },
          signal: AbortSignal.timeout(15_000),
        },
      );
      const body = await readJson(res);
      if (!res.ok) throw failureOf(res.status, body);
      return {
        done: body?.done === true,
        assetId: typeof body?.assetId === 'string' ? body.assetId : null,
        moderationState: moderationStateOf(body?.moderationState),
      };
    },
  };
}

// ── Bagian bawah ─────────────────────────────────────────────────────────────

interface LooseBody {
  readonly done?: unknown;
  readonly assetId?: unknown;
  readonly operationId?: unknown;
  readonly code?: unknown;
  readonly message?: unknown;
  readonly moderationState?: unknown;
}

async function readJson(res: Response): Promise<LooseBody | null> {
  try {
    const parsed: unknown = await res.json();
    return typeof parsed === 'object' && parsed !== null ? (parsed as LooseBody) : null;
  } catch {
    return null;
  }
}

function failureOf(status: number, body: LooseBody | null): UploadError {
  const code = typeof body?.code === 'string' ? body.code : `HTTP_${status}`;
  const message =
    typeof body?.message === 'string' && body.message !== ''
      ? body.message
      : `server unggah menjawab HTTP ${status}`;
  return new UploadError(code, message);
}

/**
 * POST multipart dengan progres.
 *
 * Sengaja sedangkal mungkin: tidak ada retry, tidak ada penafsiran, tidak ada
 * keputusan. Semua itu ada di `runner.ts`, yang bisa diuji tanpa XHR sama
 * sekali — dan berkas ini tinggal jadi kabel yang benar atau salah, bukan
 * tempat logika bersembunyi.
 */
function xhrPost(
  url: string,
  form: FormData,
  apiKey: string,
  onProgress: (percent: number) => void,
): Promise<StartedUpload> {
  return new Promise<StartedUpload>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader(KEY_HEADER, apiKey);
    xhr.responseType = 'text';
    xhr.timeout = UPLOAD_TIMEOUT_MS;

    xhr.upload.onprogress = (e: ProgressEvent): void => {
      // `lengthComputable` false terjadi pada sambungan yang tidak menyebut
      // total. Membagi dengan nol menghasilkan NaN, dan NaN di lebar bar
      // membuat elemennya hilang sama sekali.
      if (!e.lengthComputable || e.total === 0) return;
      onProgress(Math.round((e.loaded / e.total) * 100));
    };

    xhr.onerror = (): void => {
      reject(new UploadError('JARINGAN', 'tidak bisa menghubungi server unggah'));
    };
    xhr.ontimeout = (): void => {
      reject(new UploadError('WAKTU_HABIS', 'server unggah tidak menjawab'));
    };
    xhr.onload = (): void => {
      let body: LooseBody | null = null;
      try {
        const parsed: unknown = JSON.parse(xhr.responseText);
        body = typeof parsed === 'object' && parsed !== null ? (parsed as LooseBody) : null;
      } catch {
        body = null;
      }

      if (xhr.status < 200 || xhr.status >= 300) {
        reject(failureOf(xhr.status, body));
        return;
      }
      const operationId = typeof body?.operationId === 'string' ? body.operationId : '';
      if (operationId === '') {
        reject(
          new UploadError(
            'BALASAN_TIDAK_DIKENALI',
            'server unggah tidak menyebut id operasinya',
          ),
        );
        return;
      }
      resolve({
        operationId,
        done: body?.done === true,
        assetId: typeof body?.assetId === 'string' ? body.assetId : null,
        moderationState: moderationStateOf(body?.moderationState),
      });
    };

    xhr.send(form);
  });
}

function moderationStateOf(value: unknown): ModerationState | null {
  return value === 'reviewing' || value === 'approved' || value === 'rejected' ? value : null;
}
