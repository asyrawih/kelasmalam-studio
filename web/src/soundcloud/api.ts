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

export class SoundCloudApi {
  constructor(private readonly baseUrl: string) {}

  private url(path: string, params: Record<string, string | number | boolean>): URL {
    const url = new URL(path, this.baseUrl);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    return url;
  }

  private async json(path: string, params: Record<string, string | number | boolean>, fallback: string, signal?: AbortSignal): Promise<unknown> {
    const response = await fetch(this.url(path, params), { signal });
    if (!response.ok) throw new Error(await errorMessage(response, fallback));
    return response.json();
  }

  async health(signal?: AbortSignal): Promise<boolean> {
    const response = await fetch(this.url('/health', {}), { signal });
    return response.ok;
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
    const response = await fetch(this.streamUrl(trackUrl), { signal });
    if (!response.ok) throw new Error(await errorMessage(response, 'Audio SoundCloud tidak tersedia'));
    return response.arrayBuffer();
  }
}

async function errorMessage(response: Response, fallback: string): Promise<string> {
  try { const body = record(await response.json()); return text(body.message) || text(body.error) || text(body.kind) || `${fallback} (${response.status})`; }
  catch { return `${fallback} (${response.status})`; }
}

export function createSoundCloudApi(base = import.meta.env.VITE_SOUNDCLAUDE_API): SoundCloudApi {
  return new SoundCloudApi((base ?? 'http://localhost:8080').replace(/\/$/, ''));
}
