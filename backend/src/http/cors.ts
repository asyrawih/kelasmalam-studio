/**
 * CORS.
 *
 * ## Ini BUKAN batas keamanan, dan penting untuk tidak salah mengingatnya
 *
 * `Origin` dikirim browser dan dipercaya browser. curl bisa menuliskan apa pun
 * di sana. Jadi allowlist di sini melakukan satu hal saja: mencegah halaman
 * ORANG LAIN memakai Worker ini dari browser korban. Ia tidak menghentikan
 * siapa pun yang memanggil langsung.
 *
 * Yang membuat itu bisa diterima: Worker ini tidak memegang kredensial apa pun.
 * Setiap permintaan membawa API key milik pemanggilnya sendiri, dan tanpa kunci
 * itu ia tidak bisa mengunggah apa-apa. Yang bisa disalahgunakan hanyalah
 * bandwidth kami — bukan akun Roblox siapa pun. Batas sesungguhnya, kalau nanti
 * dibutuhkan, harus berupa autentikasi, bukan pengetatan daftar ini.
 */

export interface CorsDecision {
  /** Nilai untuk `Access-Control-Allow-Origin`, atau `null` kalau tidak boleh. */
  readonly allowOrigin: string | null;
  /** Origin dikirim tapi tidak ada di daftar. */
  readonly rejected: boolean;
}

/**
 * Header yang boleh dikirim pemanggil.
 *
 * Satu daftar untuk kedua Worker: `x-roblox-api-key` hanya berarti bagi yang
 * satu, `if-match` hanya bagi yang lain, dan memisahkannya jadi dua konstanta
 * berarti dua tempat yang bisa tertinggal. Header yang diizinkan tapi tidak
 * pernah dikirim tidak merugikan siapa pun.
 *
 * `authorization` untuk aplikasi desktop (docs/20 §1d): sesinya dikirim
 * sebagai `Bearer`, dan tanpa nama header ini di preflight browser WebView
 * membuang permintaannya sebelum sampai ke Worker.
 */
export const ALLOWED_HEADERS = 'content-type,x-roblox-api-key,if-match,authorization';

export interface CorsExtras {
  /**
   * Balasan boleh dibaca oleh permintaan ber-cookie.
   *
   * WAJIB untuk Worker kepustakaan: tanpa `Access-Control-Allow-Credentials` di
   * respons SUNGGUHAN (bukan cuma di preflight), browser membuang balasannya —
   * dan yang terlihat di sisi app adalah galat jaringan tanpa sebab.
   */
  readonly credentials?: boolean;
}

export function parseOrigins(raw: string | undefined): readonly string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter((s) => s !== '');
}

export function decideCors(origin: string | null, allowed: readonly string[]): CorsDecision {
  // Tanpa `Origin`: permintaan non-browser (curl, server, uji coba). Dibiarkan
  // lewat — menolaknya tidak menambah keamanan (lihat kepala berkas) dan hanya
  // membuat Worker mustahil diperiksa dari terminal.
  if (origin === null) return { allowOrigin: null, rejected: false };
  if (allowed.includes('*')) return { allowOrigin: origin, rejected: false };
  const clean = origin.replace(/\/+$/, '');
  return allowed.includes(clean)
    ? { allowOrigin: origin, rejected: false }
    : { allowOrigin: null, rejected: true };
}

/**
 * Tempelkan header CORS ke satu response.
 *
 * `Vary: Origin` WAJIB: tanpanya cache mana pun di jalur (Cloudflare sendiri
 * termasuk) bisa menyajikan balasan ber-`Allow-Origin` milik satu origin kepada
 * origin lain — dan itu justru melubangi hal yang sedang dijaga.
 */
export function withCors(
  res: Response,
  allowOrigin: string | null,
  extras: CorsExtras = {},
): Response {
  const out = new Response(res.body, res);
  out.headers.set('vary', 'origin');
  if (allowOrigin !== null) {
    out.headers.set('access-control-allow-origin', allowOrigin);
    out.headers.set('access-control-expose-headers', 'content-type,etag');
    if (extras.credentials === true) out.headers.set('access-control-allow-credentials', 'true');
  }
  return out;
}

/** Balasan preflight. */
export function preflight(allowOrigin: string | null, extras: CorsExtras = {}): Response {
  const headers = new Headers({
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': ALLOWED_HEADERS,
    'access-control-max-age': '86400',
    vary: 'origin',
  });
  if (allowOrigin !== null) {
    headers.set('access-control-allow-origin', allowOrigin);
    if (extras.credentials === true) headers.set('access-control-allow-credentials', 'true');
  }
  return new Response(null, { status: 204, headers });
}
