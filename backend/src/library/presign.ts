/**
 * Presigned PUT ke R2 (AWS Signature Version 4, otentikasi lewat query string).
 *
 * ## Ketegangan yang harus dinyatakan, bukan disembunyikan
 *
 * `docs/16 §1a` memilih Workers+R2 justru karena binding R2 membuat kunci S3
 * tidak perlu ada. `§5c` melarang Worker jadi pipa upload. Keduanya tidak bisa
 * benar sekaligus: menandatangani presigned URL MEMBUTUHKAN kunci S3.
 *
 * Yang dipilih di sini adalah `§5c`, karena batasnya keras — badan permintaan
 * Worker dibatasi (100 MB di paket gratis) dan WAV 27 menit sudah ~285 MB,
 * jadi jalur "lewat Worker" bukan pilihan yang lebih lambat melainkan pilihan
 * yang tidak berfungsi. `§1a` dilunakkan, bukan dibatalkan:
 *
 *   - satu pasang kunci, disimpan sebagai `wrangler secret`
 *   - dipakai HANYA untuk menandatangani PUT; seluruh pembacaan tetap lewat
 *     binding `env.TRACKS`
 *   - token yang sampai ke browser berumur pendek dan terikat pada SATU kunci
 *     objek, bukan pada bucket
 *
 * ## Apa yang diuji, dan apa yang tidak
 *
 * Tanda tangan akhirnya hanya bisa divalidasi oleh R2. Yang bisa — dan yang
 * dijaga tes — adalah bentuk canonical request dan string-to-sign persis
 * seperti yang ditulis dokumentasi AWS, aturan `UriEncode`-nya, dan kepekaan
 * tanda tangan terhadap setiap masukan. Karena itu kedua string antara
 * diekspor: yang diperiksa tes adalah bahan yang masuk ke HMAC, bukan cuma
 * bahwa keluarannya berupa 64 karakter heksadesimal.
 */

const ALGORITHM = 'AWS4-HMAC-SHA256';
/** R2 tidak punya region; S3 API-nya menerima `auto`. */
const REGION = 'auto';
const SERVICE = 's3';
/** Isi badan tidak ikut ditandatangani — browser yang mengirimnya, bukan kami. */
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

export interface PresignInput {
  readonly accountId: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Kunci objek, TANPA slash di depan. */
  readonly key: string;
  readonly expiresInSeconds: number;
  /** Waktu tanda tangan. Disuntik di tes supaya hasilnya bisa diulang. */
  readonly now: Date;
}

export interface Presigned {
  readonly url: string;
  readonly canonicalRequest: string;
  readonly stringToSign: string;
}

/**
 * `UriEncode` versi AWS.
 *
 * `encodeURIComponent` bawaan TIDAK cukup: ia membiarkan `!`, `'`, `(`, `)`,
 * dan `*` apa adanya, sementara AWS menuntut semuanya ter-encode kecuali
 * `A-Za-z0-9-._~`. Selisih itu tidak pernah terlihat sampai ada nama berkas
 * yang memuatnya, lalu muncul sebagai `SignatureDoesNotMatch` yang tidak
 * menyebut karakter mana pun.
 */
export function uriEncode(value: string, encodeSlash = true): string {
  let out = '';
  for (const byte of new TextEncoder().encode(value)) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(ch)) {
      out += ch;
    } else if (ch === '/' && !encodeSlash) {
      out += ch;
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

/** `20260820T113000Z` dan `20260820`. */
export function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

export async function presignPut(input: PresignInput): Promise<Presigned> {
  const { amzDate, dateStamp } = amzDates(input.now);
  const host = `${input.accountId}.r2.cloudflarestorage.com`;
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;

  // Slash di dalam nama objek TIDAK di-encode — aturan eksplisit di
  // dokumentasi AWS untuk canonical URI.
  const canonicalUri = `/${uriEncode(input.bucket)}/${uriEncode(input.key, false)}`;

  const params: readonly (readonly [string, string])[] = [
    ['X-Amz-Algorithm', ALGORITHM],
    ['X-Amz-Credential', `${input.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(input.expiresInSeconds)],
    ['X-Amz-SignedHeaders', 'host'],
  ];

  // Urut MENURUT HASIL ENCODE, bukan menurut nama aslinya — juga aturan
  // eksplisit di dokumentasi, dan bedanya baru terlihat pada nama yang
  // mengandung karakter di luar ASCII alfanumerik.
  const canonicalQuery = params
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalRequest = [
    'PUT',
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    'host',
    UNSIGNED_PAYLOAD,
  ].join('\n');

  const stringToSign = [
    ALGORITHM,
    amzDate,
    scope,
    hex(await sha256(canonicalRequest)),
  ].join('\n');

  const signingKey = await deriveSigningKey(input.secretAccessKey, dateStamp);
  const signature = hex(await hmac(signingKey, stringToSign));

  return {
    url: `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    canonicalRequest,
    stringToSign,
  };
}

/**
 * `AWS4` + secret → tanggal → region → service → `aws4_request`.
 *
 * Rantai inilah yang membuat kunci hasilnya hanya berlaku untuk satu hari,
 * satu region, dan satu layanan.
 */
export async function deriveSigningKey(
  secretAccessKey: string,
  dateStamp: string,
): Promise<ArrayBuffer> {
  const kDate = await hmac(new TextEncoder().encode(`AWS4${secretAccessKey}`), dateStamp);
  const kRegion = await hmac(kDate, REGION);
  const kService = await hmac(kRegion, SERVICE);
  return await hmac(kService, 'aws4_request');
}

async function sha256(data: string): Promise<ArrayBuffer> {
  return await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
}

export function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
