/**
 * Klien Open Cloud, dengan `fetch` palsu.
 *
 * Yang dijaga di sini adalah bentuk permintaan yang BERANGKAT (Roblox menolak
 * dengan pesan yang tidak menyebut sebabnya kalau salah) dan bentuk balasan
 * yang DITERIMA — termasuk dua variasi yang keduanya nyata: `operationId`
 * telanjang, dan `path: "operations/{id}"`.
 */

import { describe, expect, it, vi } from 'vitest';

import { createAudioAsset, describeFailure, getOperation, normalizeBase } from './open-cloud';

const KEY = 'kunci-rahasia';
const BASE = 'https://apis.example.test';

const input = {
  bytes: new Uint8Array([1, 2, 3, 4]).buffer,
  fileName: 'lagu.mp3',
  mime: 'audio/mpeg',
  name: 'LAGU',
  description: 'catatan',
  creatorKind: 'user' as const,
  creatorId: '123',
};

const reply = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * `fetch` palsu dengan tanda tangan EKSPLISIT.
 *
 * `vi.fn(async () => …)` menyimpulkan parameternya kosong, dan `mock.calls[0][0]`
 * lalu gagal ditipe — padahal justru argumen itulah yang diperiksa hampir semua
 * tes di berkas ini.
 */
const spyFetch = (respond: () => Response) =>
  vi.fn(async (_url: string, _init: RequestInit = {}) => respond());

describe('createAudioAsset', () => {
  it('menembak endpoint yang benar dengan kunci di header', async () => {
    const fetchImpl = spyFetch(() => reply({ path: 'operations/op-1', done: false }));
    await createAudioAsset({ base: BASE, apiKey: KEY, fetchImpl: fetchImpl as unknown as typeof fetch }, input);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE}/assets/v1/assets`);
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('x-api-key')).toBe(KEY);
  });

  it('tidak memasang content-type sendiri — boundary multipart milik runtime', async () => {
    const fetchImpl = spyFetch(() => reply({ path: 'operations/op-1' }));
    await createAudioAsset({ base: BASE, apiKey: KEY, fetchImpl: fetchImpl as unknown as typeof fetch }, input);

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get('content-type')).toBeNull();
  });

  it('mengirim `request` sebagai field JSON teks dan `fileContent` sebagai berkas', async () => {
    const fetchImpl = spyFetch(() => reply({ path: 'operations/op-1' }));
    await createAudioAsset({ base: BASE, apiKey: KEY, fetchImpl: fetchImpl as unknown as typeof fetch }, input);

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const form = init.body as FormData;

    const meta = form.get('request');
    expect(typeof meta).toBe('string');
    expect(JSON.parse(meta as string)).toEqual({
      assetType: 'Audio',
      displayName: 'LAGU',
      description: 'catatan',
      creationContext: { creator: { userId: '123' } },
    });

    const content = form.get('fileContent');
    expect(content).toBeInstanceOf(Blob);
    expect((content as Blob).type).toBe('audio/mpeg');
    expect((content as Blob).size).toBe(4);
  });

  it('body multipart yang benar-benar terserialisasi tidak kosong dan tidak memberi filename pada metadata', async () => {
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit = {}) => {
      const wire = new Request('https://wire.test', {
        method: 'POST',
        body: init.body,
      });
      const contentType = wire.headers.get('content-type') ?? '';
      const body = await wire.text();

      expect(contentType).toMatch(/^multipart\/form-data; boundary=/);
      expect(body).toContain('name="request"');
      expect(body).not.toContain('name="request"; filename=');
      expect(body).toContain('name="fileContent"; filename="lagu.mp3"');
      expect(body).toContain('"assetType":"Audio"');
      expect(body.length).toBeGreaterThan(input.bytes.byteLength);
      return reply({ path: 'operations/op-wire' });
    });

    const result = await createAudioAsset(
      { base: BASE, apiKey: KEY, fetchImpl: fetchImpl as unknown as typeof fetch },
      input,
    );
    expect(result).toMatchObject({ ok: true });
  });

  it('grup memakai groupId, bukan userId', async () => {
    const fetchImpl = spyFetch(() => reply({ path: 'operations/op-1' }));
    await createAudioAsset(
      { base: BASE, apiKey: KEY, fetchImpl: fetchImpl as unknown as typeof fetch },
      { ...input, creatorKind: 'group', creatorId: '777' },
    );

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const meta = JSON.parse((init.body as FormData).get('request') as string);
    expect(meta.creationContext.creator).toEqual({ groupId: '777' });
  });

  it('membaca operationId dari `path` maupun dari field telanjangnya', async () => {
    const fromPath = await createAudioAsset(
      { base: BASE, apiKey: KEY, fetchImpl: async () => reply({ path: 'operations/op-9' }) },
      input,
    );
    expect(fromPath).toMatchObject({ ok: true, value: { operationId: 'op-9', done: false } });

    const fromField = await createAudioAsset(
      { base: BASE, apiKey: KEY, fetchImpl: async () => reply({ operationId: 'op-8', done: true }) },
      input,
    );
    expect(fromField).toMatchObject({ ok: true, value: { operationId: 'op-8', done: true } });
  });

  it('balasan tanpa id operasi adalah kegagalan, bukan sukses kosong', async () => {
    const res = await createAudioAsset(
      { base: BASE, apiKey: KEY, fetchImpl: async () => reply({ done: false }) },
      input,
    );
    expect(res).toMatchObject({ ok: false, code: 'BALASAN_TIDAK_DIKENALI' });
  });

  it('slash di ujung base tidak menghasilkan URL berslash ganda', async () => {
    const fetchImpl = spyFetch(() => reply({ path: 'operations/x' }));
    await createAudioAsset(
      { base: `${BASE}//`, apiKey: KEY, fetchImpl: fetchImpl as unknown as typeof fetch },
      input,
    );
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`${BASE}/assets/v1/assets`);
    expect(normalizeBase(`${BASE}///`)).toBe(BASE);
  });

  it('galat jaringan jadi 504 dengan pesan yang menyebut Roblox', async () => {
    const res = await createAudioAsset(
      {
        base: BASE,
        apiKey: KEY,
        fetchImpl: async () => {
          throw new Error('connect ECONNREFUSED');
        },
      },
      input,
    );
    expect(res).toMatchObject({ ok: false, status: 504, code: 'JARINGAN' });
  });
});

describe('getOperation', () => {
  it('menemukan assetId di `response.assetId`', async () => {
    const res = await getOperation(
      {
        base: BASE,
        apiKey: KEY,
        fetchImpl: async () => reply({ done: true, response: { assetId: '556677' } }),
      },
      'op-1',
    );
    expect(res).toMatchObject({ ok: true, value: { done: true, assetId: '556677' } });
  });

  it('juga menemukannya kalau hanya ada sebagai `assets/{id}`', async () => {
    const res = await getOperation(
      {
        base: BASE,
        apiKey: KEY,
        fetchImpl: async () => reply({ done: true, response: { path: 'assets/889' } }),
      },
      'op-1',
    );
    expect(res).toMatchObject({ ok: true, value: { assetId: '889' } });
  });

  it('operasi yang belum selesai bukan kegagalan', async () => {
    const res = await getOperation(
      { base: BASE, apiKey: KEY, fetchImpl: async () => reply({ done: false }) },
      'op-1',
    );
    expect(res).toMatchObject({ ok: true, value: { done: false, assetId: null } });
  });

  it('operasi selesai yang membawa error TIDAK dianggap selesai', async () => {
    const res = await getOperation(
      {
        base: BASE,
        apiKey: KEY,
        fetchImpl: async () =>
          reply({ done: true, error: { code: 'MODERATED', message: 'ditolak moderasi' } }),
      },
      'op-1',
    );
    expect(res).toMatchObject({ ok: false, code: 'MODERATED', message: 'ditolak moderasi' });
  });

  it('id operasi di-encode ke dalam URL', async () => {
    const fetchImpl = spyFetch(() => reply({ done: false }));
    await getOperation(
      { base: BASE, apiKey: KEY, fetchImpl: fetchImpl as unknown as typeof fetch },
      'op/1 aneh',
    );
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`${BASE}/assets/v1/operations/op%2F1%20aneh`);
  });
});

describe('describeFailure', () => {
  it('403 menyebut allowlist IP — jebakan pemasangan yang paling sering kena', () => {
    const d = describeFailure(403, { message: 'Forbidden' }, '');
    expect(d.message).toMatch(/allowlist IP/i);
    expect(d.message).toContain('Forbidden');
  });

  it('menjelaskan 401, 429, dan 5xx dengan kalimat yang berbeda', () => {
    expect(describeFailure(401, null, '').message).toMatch(/tidak dikenali|dicabut/i);
    expect(describeFailure(429, null, '').message).toMatch(/kuota|terlalu cepat/i);
    expect(describeFailure(503, null, '').message).toMatch(/Roblox sedang bermasalah/i);
  });

  it('memakai kode dari badan Roblox kalau ada', () => {
    expect(describeFailure(400, { code: 'INVALID_ARGUMENT' }, '').code).toBe('INVALID_ARGUMENT');
    expect(describeFailure(400, null, '').code).toBe('HTTP_400');
  });
});
