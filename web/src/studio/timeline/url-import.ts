/**
 * Import audio dari URL — hasil drop link atau tempel dari clipboard.
 *
 * BATAS YANG NYATA, dan kenapa pesannya harus spesifik:
 *
 * Browser hanya bisa mengambil URL yang mengizinkan CORS. Untuk file audio di
 * CDN sendiri, S3/Dropbox direct link, atau file server, itu biasanya jalan.
 * Untuk YouTube/SoundCloud/Spotify TIDAK: tidak ada URL audio mentah yang
 * publik, dan domainnya tidak mengizinkan CORS. Ekstraksinya butuh proses di
 * sisi server, yang tidak ada di aplikasi ini.
 *
 * Karena itu host semacam itu dikenali LEBIH DULU dan dijelaskan apa adanya.
 * Membiarkannya jatuh ke `fetch` hanya menghasilkan "Failed to fetch" — pesan
 * yang membuat user mengira ada bug, lalu mencoba berkali-kali.
 */

/** Host yang ekstraksinya butuh server; tidak akan pernah berhasil dari browser. */
const NEEDS_SERVER = [
  { match: /(^|\.)youtube\.com$|(^|\.)youtu\.be$|(^|\.)youtube-nocookie\.com$/, name: 'YouTube' },
  { match: /(^|\.)soundcloud\.com$|(^|\.)snd\.sc$/, name: 'SoundCloud' },
  { match: /(^|\.)spotify\.com$|(^|\.)spoti\.fi$/, name: 'Spotify' },
  { match: /(^|\.)music\.apple\.com$/, name: 'Apple Music' },
  { match: /(^|\.)bandcamp\.com$/, name: 'Bandcamp' },
  { match: /(^|\.)mixcloud\.com$/, name: 'Mixcloud' },
];

export type UrlKind =
  | { readonly kind: 'fetchable'; readonly url: URL }
  | { readonly kind: 'needs-server'; readonly service: string }
  | { readonly kind: 'not-a-url' };

export function classifyUrl(text: string): UrlKind {
  const trimmed = text.trim();
  if (trimmed === '' || /\s/.test(trimmed)) return { kind: 'not-a-url' };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { kind: 'not-a-url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { kind: 'not-a-url' };

  const host = url.hostname.toLowerCase();
  for (const s of NEEDS_SERVER) {
    if (s.match.test(host)) return { kind: 'needs-server', service: s.name };
  }
  return { kind: 'fetchable', url };
}

/** Nama file yang layak dari sebuah URL, untuk label clip. */
export function nameFromUrl(url: URL): string {
  const last = url.pathname.split('/').filter(Boolean).pop();
  if (last !== undefined && last !== '') return decodeURIComponent(last);
  return url.hostname;
}

export interface UrlFetchResult {
  readonly ok: boolean;
  readonly bytes?: ArrayBuffer;
  readonly name?: string;
  readonly reason?: string;
}

/**
 * Ambil byte audio dari URL. TIDAK men-decode — itu tugas `importBytesToLane`,
 * supaya jalur file dan jalur URL memakai sniffing & decoder yang sama persis.
 */
export async function fetchAudioUrl(text: string): Promise<UrlFetchResult> {
  const cls = classifyUrl(text);

  if (cls.kind === 'not-a-url') {
    return { ok: false, reason: 'bukan URL yang valid' };
  }
  if (cls.kind === 'needs-server') {
    return {
      ok: false,
      reason:
        `link ${cls.service} tidak bisa diunduh langsung dari browser — ` +
        'audionya tidak tersedia sebagai berkas dan domainnya memblokir CORS. ' +
        'Unduh dulu ke komputer, lalu drag file-nya ke lane.',
    };
  }

  let res: Response;
  try {
    res = await fetch(cls.url.href, { mode: 'cors', redirect: 'follow' });
  } catch {
    // TypeError dari fetch lintas origin tidak membedakan "jaringan mati" dari
    // "CORS ditolak" — sengaja begitu demi keamanan. Jadi sebutkan keduanya.
    return {
      ok: false,
      reason:
        'gagal mengambil URL: server tidak mengizinkan akses lintas origin (CORS), ' +
        'atau jaringan bermasalah. URL audio langsung dari CDN/S3 biasanya bisa.',
    };
  }
  if (!res.ok) {
    return { ok: false, reason: `server menjawab HTTP ${res.status}` };
  }

  // Content-Type hanya PETUNJUK, bukan keputusan: banyak server mengirim
  // `application/octet-stream` untuk file audio yang sah. Penentu sebenarnya
  // adalah magic bytes di `sniff.ts`. Yang ditolak di sini cuma yang jelas
  // bukan audio, mis. halaman HTML — supaya pesannya tetap enak dibaca.
  const type = (res.headers.get('content-type') ?? '').toLowerCase();
  if (type.includes('text/html')) {
    return {
      ok: false,
      reason: 'URL ini mengembalikan halaman web, bukan berkas audio',
    };
  }

  try {
    const bytes = await res.arrayBuffer();
    return { ok: true, bytes, name: nameFromUrl(cls.url) };
  } catch {
    return { ok: false, reason: 'gagal membaca isi respons' };
  }
}
