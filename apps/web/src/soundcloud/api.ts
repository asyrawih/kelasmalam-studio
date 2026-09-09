import { getPlatformHost } from '../platform';
import { desktopTransport } from './desktop-transport';

export interface SoundCloudTrack {
  readonly id: number;
  readonly title: string;
  readonly permalinkUrl: string;
  readonly artworkUrl: string | null;
  readonly avatarUrl: string | null;
  readonly username: string;
  readonly durationMs: number | null;
  readonly description: string;
}

export interface SoundCloudProfile {
  readonly id: number;
  readonly username: string;
  readonly permalinkUrl: string;
  readonly avatarUrl: string | null;
  readonly followers: number | null;
  readonly trackCount: number | null;
}

export interface SoundCloudSearchPage {
  readonly tracks: readonly SoundCloudTrack[];
  readonly total: number | null;
  readonly hasNext: boolean;
  readonly offset: number;
}

export type SoundCloudResolved =
  | { readonly kind: 'track'; readonly title: string; readonly tracks: readonly SoundCloudTrack[] }
  | { readonly kind: 'playlist'; readonly title: string; readonly tracks: readonly SoundCloudTrack[] }
  | { readonly kind: 'user'; readonly title: string; readonly tracks: readonly []; readonly profile: SoundCloudProfile }
  | { readonly kind: 'unknown'; readonly title: string; readonly tracks: readonly SoundCloudTrack[] };

interface UnknownRecord { readonly [key: string]: unknown }
function record(value: unknown): UnknownRecord { return value !== null && typeof value === 'object' ? value as UnknownRecord : {}; }
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function number(value: unknown): number | null { const parsed = typeof value === 'number' ? value : Number(value); return Number.isFinite(parsed) ? parsed : null; }

function trackOf(value: unknown): SoundCloudTrack | null {
  const wrapper = record(value);
  const nested = record(wrapper.track);
  const item = Object.keys(nested).length > 0 ? nested : wrapper;
  const id = number(item.id);
  const title = text(item.title);
  const permalinkUrl = text(item.permalink_url) || text(item.permalinkUrl);
  if (id === null || title === '' || permalinkUrl === '') return null;
  const user = record(item.user);
  return {
    id,
    title,
    permalinkUrl,
    artworkUrl: text(item.artwork_url) || null,
    avatarUrl: text(user.avatar_url) || null,
    username: text(user.username) || text(item.username) || 'Unknown artist',
    durationMs: number(item.duration),
    description: text(item.description),
  };
}

function tracksOf(payload: unknown): readonly SoundCloudTrack[] {
  const body = record(payload);
  const source = Array.isArray(body.collection) ? body.collection : Array.isArray(body.tracks) ? body.tracks : [];
  return source.map(trackOf).filter((item): item is SoundCloudTrack => item !== null);
}

function profileOf(value: unknown): SoundCloudProfile | null {
  const item = record(value); const id = number(item.id); const username = text(item.username);
  if (id === null || username === '') return null;
  return { id, username, permalinkUrl: text(item.permalink_url), avatarUrl: text(item.avatar_url) || null, followers: number(item.followers_count), trackCount: number(item.track_count) };
}

/**
 * Cara satu permintaan berangkat. Web: `fetch` (bawaan). Desktop: command
 * Tauri lewat Rust (`./desktop-transport`), karena `fetch` dari WebView mati di
 * CORS — origin `tauri://localhost` tidak dikenal server. Bentuknya sengaja
 * sekecil ini: dua kata kerja, status diteruskan apa adanya, supaya kedua
 * implementasi bisa diuji dengan cara yang sama.
 */
export interface SoundCloudTransport {
  json(url: string, signal?: AbortSignal): Promise<{ readonly status: number; readonly body: unknown }>;
  bytes(url: string, signal?: AbortSignal): Promise<ArrayBuffer>;
}

/** Transport web: `fetch` global — tetap bisa di-stub di tes seperti sebelumnya. */
export const fetchTransport: SoundCloudTransport = {
  async json(url, signal) {
    const response = await fetch(url, { signal });
    let body: unknown = null;
    try { body = await response.json(); } catch { /* badan bukan JSON */ }
    return { status: response.status, body };
  },
  async bytes(url, signal) {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Audio SoundCloud tidak tersedia (${response.status})`);
    return response.arrayBuffer();
  },
};

const ok = (status: number): boolean => status >= 200 && status < 300;

export interface SoundCloudHealth {
  readonly online: boolean;
  /** Kalimat sebab saat `online === false`; `null` saat online. */
  readonly reason: string | null;
}

export class SoundCloudApi {
  constructor(private readonly baseUrl: string, private readonly transport: SoundCloudTransport = fetchTransport) {}

  private url(path: string, params: Record<string, string | number | boolean>): URL {
    const url = new URL(path, this.baseUrl);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    return url;
  }

  private async json(path: string, params: Record<string, string | number | boolean>, fallback: string, signal?: AbortSignal): Promise<unknown> {
    const { status, body } = await this.transport.json(this.url(path, params).toString(), signal);
    if (!ok(status)) throw new Error(errorMessage(status, body, fallback));
    return body;
  }

  async health(signal?: AbortSignal): Promise<boolean> {
    return (await this.healthDetail(signal)).online;
  }

  /**
   * Seperti `health()`, tapi membawa SEBABNYA saat offline. "API OFFLINE"
   * tanpa alasan pernah menyembunyikan tiga hal yang berbeda sama sekali:
   * server yang lambat menjawab, CORS dari WebView, dan command Tauri yang
   * belum ada di binari lama — dan ketiganya diperbaiki dengan cara berbeda.
   */
  async healthDetail(signal?: AbortSignal): Promise<SoundCloudHealth> {
    try {
      const { status } = await this.transport.json(this.url('/health', {}).toString(), signal);
      return ok(status) ? { online: true, reason: null } : { online: false, reason: `server menjawab ${status}` };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      return { online: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  async search(query: string, offset = 0, signal?: AbortSignal): Promise<SoundCloudSearchPage> {
    const payload = await this.json('/v1/search', { q: query, kind: 'tracks', limit: 20, offset }, 'Pencarian SoundCloud gagal', signal);
    const body = record(payload);
    return { tracks: tracksOf(payload), total: number(body.total_results), hasNext: text(body.next_href) !== '', offset };
  }

  async track(trackUrl: string, signal?: AbortSignal): Promise<SoundCloudTrack> {
    const payload = await this.json('/v1/track', { url: trackUrl }, 'Detail track gagal dimuat', signal);
    const track = trackOf(payload); if (track === null) throw new Error('Response detail track tidak dikenali');
    return track;
  }

  async playlist(playlistUrl: string, signal?: AbortSignal): Promise<SoundCloudResolved> {
    const payload = await this.json('/v1/set', { url: playlistUrl }, 'Playlist gagal dimuat', signal);
    return { kind: 'playlist', title: text(record(payload).title) || 'Playlist', tracks: tracksOf(payload) };
  }

  async profile(profileUrl: string, signal?: AbortSignal): Promise<SoundCloudProfile> {
    const payload = await this.json('/v1/user', { url: profileUrl }, 'Profil gagal dimuat', signal);
    const profile = profileOf(payload); if (profile === null) throw new Error('Response profil tidak dikenali');
    return profile;
  }

  async resolve(soundCloudUrl: string, signal?: AbortSignal): Promise<SoundCloudResolved> {
    const raw = record(await this.json('/v1/resolve', { url: soundCloudUrl }, 'URL SoundCloud gagal di-resolve', signal));
    const kind = text(raw.kind);
    if (kind === 'track') { const track = await this.track(soundCloudUrl, signal); return { kind: 'track', title: track.title, tracks: [track] }; }
    if (kind === 'playlist' || kind === 'system-playlist') return this.playlist(soundCloudUrl, signal);
    // SoundCloud menormalisasi URL `/nama/tracks` ke objek user, tetapi pada
    // payload resolve tertentu field `kind` hilang. Bentuk profil tetap bisa
    // dikenali dari username tanpa title.
    if (kind === 'user' || (text(raw.username) !== '' && text(raw.title) === '')) {
      const profile = await this.profile(soundCloudUrl, signal);
      return { kind: 'user', title: profile.username, tracks: [], profile };
    }
    const direct = trackOf(raw);
    return { kind: 'unknown', title: text(raw.title) || 'SoundCloud URL', tracks: direct === null ? tracksOf(raw) : [direct] };
  }

  async related(trackId: number, signal?: AbortSignal): Promise<readonly SoundCloudTrack[]> {
    return tracksOf(await this.json('/v1/related', { id: trackId, limit: 20 }, 'Related tracks gagal dimuat', signal));
  }

  async likes(profileUrl: string, signal?: AbortSignal): Promise<readonly SoundCloudTrack[]> {
    return tracksOf(await this.json('/v1/likes', { url: profileUrl, limit: 40, playlists: false }, 'Likes gagal dimuat', signal));
  }

  streamUrl(trackUrl: string): string { return this.url('/v1/stream', { url: trackUrl }).toString(); }
  downloadUrl(trackUrl: string): string { return this.url('/v1/download', { url: trackUrl }).toString(); }

  async audio(trackUrl: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    return this.transport.bytes(this.streamUrl(trackUrl), signal);
  }
}

function errorMessage(status: number, payload: unknown, fallback: string): string {
  const body = record(payload);
  return text(body.message) || text(body.error) || text(body.kind) || `${fallback} (${status})`;
}

/** Server discovery yang dipakai kalau `VITE_SOUNDCLAUDE_API` tidak diisi. */
export const SOUNDCLOUD_API_DEFAULT = 'https://soundcloud.kelasmalam.app';

/**
 * Basis URL server discovery SoundCloud.
 *
 * Dulu mode dev jatuh ke `http://localhost:8080` — dengan asumsi siapa pun
 * yang menjalankan Vite juga menjalankan `soundclaude-server` di mesinnya.
 * Asumsi itu salah di dua tempat sekaligus: `bun run dev:desktop` (jendela
 * Tauri memuat Vite dev) dan `bun run dev` biasa, keduanya menembak port yang
 * kosong dan dialognya berkata "tidak tersambung" seolah servernya mati.
 * Sekarang bawaannya server produksi di semua mode; yang mengembangkan
 * server-nya sendiri cukup mengisi `VITE_SOUNDCLAUDE_API=http://localhost:8080`.
 */
export function soundCloudApiBase(configured = import.meta.env.VITE_SOUNDCLAUDE_API): string | null {
  const value = configured?.trim() ?? '';
  if (value !== '') return value.replace(/\/$/, '');
  return SOUNDCLOUD_API_DEFAULT;
}

/**
 * Client siap pakai: transport dipilih dari platform. Desktop → Rust
 * (`desktop-transport`), web → `fetch`. Impornya statis: pembungkus `invoke`
 * sudah ada di bundel lewat `platform/`, jadi tidak ada byte baru untuk web.
 */
export function createSoundCloudApi(base = soundCloudApiBase()): SoundCloudApi {
  if (base === null) throw new Error('VITE_SOUNDCLAUDE_API belum dikonfigurasi untuk build production');
  return getPlatformHost().kind === 'desktop'
    ? new SoundCloudApi(base, desktopTransport)
    : new SoundCloudApi(base);
}
