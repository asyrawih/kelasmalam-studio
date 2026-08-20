/**
 * Presigned PUT.
 *
 * **Yang tidak diuji di sini, dan kenapa:** apakah R2 menerima tanda tangannya.
 * Itu hanya bisa dijawab R2. Konstanta tanda tangan dari ingatan lebih buruk
 * daripada tidak ada tes sama sekali — ia terlihat berwibawa dan tidak
 * membuktikan apa pun.
 *
 * Yang BISA diuji, dan diuji: bahan yang masuk ke HMAC. Bentuk canonical
 * request dan string-to-sign disalin dari dokumentasi AWS baris per baris, dan
 * kalau keduanya benar sementara tanda tangannya ditolak, yang salah tinggal
 * satu hal (kredensial) alih-alih lima.
 */

import { describe, expect, it } from 'vitest';

import { amzDates, deriveSigningKey, hex, presignPut, uriEncode } from './presign';

const BASE = {
  accountId: 'akun123',
  bucket: 'ember',
  accessKeyId: 'AKIA-CONTOH',
  secretAccessKey: 'rahasia',
  key: 'tracks/abc',
  expiresInSeconds: 900,
  now: new Date('2026-08-20T11:30:00.000Z'),
};

describe('uriEncode', () => {
  it('meng-encode yang TIDAK di-encode `encodeURIComponent`', () => {
    // Selisih inilah yang muncul sebagai SignatureDoesNotMatch tanpa petunjuk.
    expect(uriEncode("!'()*")).toBe('%21%27%28%29%2A');
    expect(encodeURIComponent("!'()*")).toBe("!'()*");
  });

  it('membiarkan karakter tak-terpesan apa adanya', () => {
    expect(uriEncode('Aa0-._~')).toBe('Aa0-._~');
  });

  it('spasi jadi %20, bukan +', () => {
    expect(uriEncode('a b')).toBe('a%20b');
  });

  it('heksadesimalnya huruf BESAR', () => {
    expect(uriEncode('ÿ')).toBe('%C3%BF');
  });

  it('slash di nama objek boleh dibiarkan', () => {
    expect(uriEncode('tracks/abc', false)).toBe('tracks/abc');
    expect(uriEncode('tracks/abc')).toBe('tracks%2Fabc');
  });
});

describe('amzDates', () => {
  it('membuang tanda baca dan milidetik', () => {
    expect(amzDates(new Date('2026-08-20T11:30:00.000Z'))).toEqual({
      amzDate: '20260820T113000Z',
      dateStamp: '20260820',
    });
  });
});

describe('canonical request', () => {
  it('berbentuk persis seperti yang ditulis dokumentasi AWS', async () => {
    const signed = await presignPut(BASE);
    expect(signed.canonicalRequest).toBe(
      [
        'PUT',
        '/ember/tracks/abc',
        'X-Amz-Algorithm=AWS4-HMAC-SHA256' +
          '&X-Amz-Credential=AKIA-CONTOH%2F20260820%2Fauto%2Fs3%2Faws4_request' +
          '&X-Amz-Date=20260820T113000Z' +
          '&X-Amz-Expires=900' +
          '&X-Amz-SignedHeaders=host',
        'host:akun123.r2.cloudflarestorage.com',
        '',
        'host',
        'UNSIGNED-PAYLOAD',
      ].join('\n'),
    );
  });

  it('string-to-sign berisi empat baris: algoritma, waktu, scope, hash', async () => {
    const signed = await presignPut(BASE);
    const lines = signed.stringToSign.split('\n');
    expect(lines[0]).toBe('AWS4-HMAC-SHA256');
    expect(lines[1]).toBe('20260820T113000Z');
    expect(lines[2]).toBe('20260820/auto/s3/aws4_request');
    expect(lines[3]).toMatch(/^[0-9a-f]{64}$/);
    expect(lines).toHaveLength(4);
  });

  it('query-nya terurut menurut hasil encode', async () => {
    const signed = await presignPut(BASE);
    const keys = signed.canonicalRequest.split('\n')[2]?.split('&').map((p) => p.split('=')[0]);
    expect(keys).toEqual([...(keys ?? [])].sort());
  });
});

describe('URL hasil', () => {
  it('menunjuk host R2 akun yang benar dan membawa tanda tangan', async () => {
    const { url } = await presignPut(BASE);
    expect(url.startsWith('https://akun123.r2.cloudflarestorage.com/ember/tracks/abc?')).toBe(true);
    expect(url).toMatch(/X-Amz-Signature=[0-9a-f]{64}$/);
  });

  it('tidak pernah memuat secret access key', async () => {
    const { url, canonicalRequest, stringToSign } = await presignPut(BASE);
    for (const s of [url, canonicalRequest, stringToSign]) {
      expect(s).not.toContain(BASE.secretAccessKey);
    }
  });
});

describe('kepekaan tanda tangan', () => {
  const sigOf = async (over: Partial<typeof BASE>): Promise<string> =>
    (await presignPut({ ...BASE, ...over })).url.split('X-Amz-Signature=')[1] ?? '';

  it('sama untuk masukan yang sama — presign tidak boleh acak', async () => {
    expect(await sigOf({})).toBe(await sigOf({}));
  });

  it('berubah kalau kunci objek, secret, waktu, bucket, atau masa berlaku berubah', async () => {
    const base = await sigOf({});
    expect(await sigOf({ key: 'tracks/lain' })).not.toBe(base);
    expect(await sigOf({ secretAccessKey: 'lain' })).not.toBe(base);
    expect(await sigOf({ now: new Date('2026-08-21T11:30:00.000Z') })).not.toBe(base);
    expect(await sigOf({ bucket: 'lain' })).not.toBe(base);
    expect(await sigOf({ expiresInSeconds: 60 })).not.toBe(base);
  });
});

describe('kunci penandatangan', () => {
  it('dirantai empat kali dan panjangnya 32 byte', async () => {
    const key = await deriveSigningKey('rahasia', '20260820');
    expect(key.byteLength).toBe(32);
    expect(hex(key)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('terikat pada TANGGAL — kunci kemarin tidak sama dengan kunci hari ini', async () => {
    const a = hex(await deriveSigningKey('rahasia', '20260820'));
    const b = hex(await deriveSigningKey('rahasia', '20260821'));
    expect(a).not.toBe(b);
  });
});
