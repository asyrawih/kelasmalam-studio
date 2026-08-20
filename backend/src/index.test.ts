/**
 * Worker dari ujung ke ujung, dengan Roblox palsu.
 *
 * Yang dijaga: kunci wajib ada, badan permintaan divalidasi ULANG di server
 * (bukan dipercaya dari UI), 202 dipakai untuk unggahan yang belum jadi asset,
 * dan kegagalan Roblox tidak menyamar jadi kegagalan kami.
 */

import { describe, expect, it, vi } from 'vitest';

import { handleRequest, type Env } from './index';
import { MAX_BYTES, MAX_NAME_LEN } from './roblox/limits';

const ENV: Env = {
  ALLOWED_ORIGINS: 'https://app.test',
  ROBLOX_API_BASE: 'https://apis.example.test',
};

const KEY = 'kunci';

const reply = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Lihat catatan di `roblox/open-cloud.test.ts`: tanda tangannya eksplisit
 *  supaya `mock.calls[0][0]` — URL yang benar-benar ditembak — bisa diperiksa. */
const spyFetch = (respond: () => Response) =>
  vi.fn(async (_url: string, _init: RequestInit = {}) => respond());

function uploadForm(over: Partial<Record<string, string>> = {}, bytes = 8): FormData {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'audio/mpeg' }), over.fileName ?? 'lagu.mp3');
  form.append('name', over.name ?? 'LAGU');
  form.append('description', over.description ?? '');
  form.append('creatorKind', over.creatorKind ?? 'user');
  form.append('creatorId', over.creatorId ?? '123');
  return form;
}

function uploadRequest(form: FormData, headers: Record<string, string> = {}): Request {
  return new Request('https://worker.test/roblox/uploads', {
    method: 'POST',
    body: form,
    headers: { origin: 'https://app.test', 'x-roblox-api-key': KEY, ...headers },
  });
}

describe('/health', () => {
  it('menjawab ok tanpa kunci sama sekali', async () => {
    const res = await handleRequest(new Request('https://worker.test/health'), ENV);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});

describe('CORS', () => {
  it('preflight menyebut header kunci sebagai yang diizinkan', async () => {
    const res = await handleRequest(
      new Request('https://worker.test/roblox/uploads', {
        method: 'OPTIONS',
        headers: { origin: 'https://app.test' },
      }),
      ENV,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-headers')).toContain('x-roblox-api-key');
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.test');
  });

  it('origin asing ditolak TANPA header izin — penolakan yang tidak setengah hati', async () => {
    const res = await handleRequest(
      new Request('https://worker.test/health', { headers: { origin: 'https://jahat.test' } }),
      ENV,
    );
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('balasan selalu ber-Vary: origin supaya cache tidak menyilangkan izin', async () => {
    const res = await handleRequest(
      new Request('https://worker.test/health', { headers: { origin: 'https://app.test' } }),
      ENV,
    );
    expect(res.headers.get('vary')).toBe('origin');
  });

  it('permintaan tanpa origin (curl) tetap dilayani', async () => {
    const res = await handleRequest(new Request('https://worker.test/health'), ENV);
    expect(res.status).toBe(200);
  });
});

describe('POST /roblox/uploads', () => {
  it('menolak tanpa kunci, sebelum menyentuh badan permintaan', async () => {
    const fetchImpl = vi.fn();
    const res = await handleRequest(
      uploadRequest(uploadForm(), { 'x-roblox-api-key': '' }),
      ENV,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(res.status).toBe(401);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('meneruskan ke Roblox dan menjawab 202 selama asset belum jadi', async () => {
    const fetchImpl = spyFetch(() => reply({ path: 'operations/op-1', done: false }));
    const res = await handleRequest(uploadRequest(uploadForm()), ENV, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ operationId: 'op-1', done: false });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://apis.example.test/assets/v1/assets');
  });

  it('200 kalau Roblox kebetulan sudah selesai saat itu juga', async () => {
    const res = await handleRequest(uploadRequest(uploadForm()), ENV, {
      fetchImpl: (async () =>
        reply({ operationId: 'op-2', done: true, response: { assetId: '42' } })) as typeof fetch,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ done: true, assetId: '42' });
  });

  it('memvalidasi ULANG di server: format, nama, dan pemilik', async () => {
    const fetchImpl = vi.fn();
    const deps = { fetchImpl: fetchImpl as unknown as typeof fetch };

    const wav = await handleRequest(uploadRequest(uploadForm({ fileName: 'a.wav' })), ENV, deps);
    expect(wav.status).toBe(400);
    expect(await wav.json()).toMatchObject({ code: 'FORMAT' });

    const noName = await handleRequest(uploadRequest(uploadForm({ name: '  ' })), ENV, deps);
    expect(await noName.json()).toMatchObject({ code: 'NAMA_KOSONG' });

    const longName = await handleRequest(
      uploadRequest(uploadForm({ name: 'x'.repeat(MAX_NAME_LEN + 1) })),
      ENV,
      deps,
    );
    expect(await longName.json()).toMatchObject({ code: 'NAMA_PANJANG' });

    const owner = await handleRequest(uploadRequest(uploadForm({ creatorId: 'abc' })), ENV, deps);
    expect(await owner.json()).toMatchObject({ code: 'PEMILIK' });

    // Tidak satu pun boleh sampai ke Roblox.
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('berkas kosong ditolak — Roblox akan menolaknya juga, tapi lebih lambat', async () => {
    const res = await handleRequest(uploadRequest(uploadForm({}, 0)), ENV, {
      fetchImpl: (() => {
        throw new Error('tidak boleh dipanggil');
      }) as unknown as typeof fetch,
    });
    expect(await res.json()).toMatchObject({ code: 'KOSONG' });
  });

  it('badan yang bukan multipart ditolak dengan pesan yang menyebut caranya', async () => {
    const res = await handleRequest(
      new Request('https://worker.test/roblox/uploads', {
        method: 'POST',
        body: JSON.stringify({ name: 'x' }),
        headers: { 'content-type': 'application/json', 'x-roblox-api-key': KEY },
      }),
      ENV,
    );
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/multipart/i);
  });

  it('403 dari Roblox diteruskan apa adanya, dengan pesan yang bisa dikerjakan', async () => {
    const res = await handleRequest(uploadRequest(uploadForm()), ENV, {
      fetchImpl: (async () => reply({ message: 'Forbidden' }, 403)) as typeof fetch,
    });
    expect(res.status).toBe(403);
    expect((await res.json()).message).toMatch(/allowlist IP/i);
  });

  it('5xx dari Roblox jadi 502, bukan 500 — yang rusak bukan Worker ini', async () => {
    const res = await handleRequest(uploadRequest(uploadForm()), ENV, {
      fetchImpl: (async () => reply({ message: 'oops' }, 503)) as typeof fetch,
    });
    expect(res.status).toBe(502);
  });

  it('GET ke endpoint unggah dijawab 405, bukan 404', async () => {
    const res = await handleRequest(
      new Request('https://worker.test/roblox/uploads', {
        headers: { 'x-roblox-api-key': KEY },
      }),
      ENV,
    );
    expect(res.status).toBe(405);
  });

  it('batas ukuran yang dipakai server adalah batas Roblox, bukan angka lain', () => {
    expect(MAX_BYTES).toBe(20 * 1024 * 1024);
  });
});

describe('GET /roblox/operations/:id', () => {
  it('meneruskan pertanyaan status dan mengembalikan assetId', async () => {
    const fetchImpl = spyFetch(() => reply({ done: true, response: { assetId: '99' } }));
    const res = await handleRequest(
      new Request('https://worker.test/roblox/operations/op-7', {
        headers: { 'x-roblox-api-key': KEY },
      }),
      ENV,
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ done: true, assetId: '99' });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://apis.example.test/assets/v1/operations/op-7',
    );
  });

  it('butuh kunci juga — status operasi bukan informasi publik', async () => {
    const res = await handleRequest(
      new Request('https://worker.test/roblox/operations/op-7'),
      ENV,
    );
    expect(res.status).toBe(401);
  });
});

describe('rute tak dikenal', () => {
  it('dijawab 404 dengan menyebut path-nya', async () => {
    const res = await handleRequest(new Request('https://worker.test/apa-ini'), ENV);
    expect(res.status).toBe(404);
    expect((await res.json()).message).toContain('/apa-ini');
  });
});
