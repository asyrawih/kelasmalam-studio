export interface SoundCloudTrack {
  readonly id: number;
  readonly title: string;
  readonly permalinkUrl: string;
  readonly artworkUrl: string | null;
  readonly username: string;
  readonly durationMs: number | null;
}

interface UnknownRecord { readonly [key: string]: unknown }

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === 'object' ? value as UnknownRecord : {};
}

function text(value: unknown): string { return typeof value === 'string' ? value : ''; }

function trackOf(value: unknown): SoundCloudTrack | null {
  const item = record(value);
  const id = typeof item.id === 'number' ? item.id : Number(item.id);
  const title = text(item.title);
  const permalinkUrl = text(item.permalink_url) || text(item.permalinkUrl);
  if (!Number.isFinite(id) || title === '' || permalinkUrl === '') return null;
  const user = record(item.user);
  const duration = typeof item.duration === 'number' ? item.duration : Number(item.duration);
  return {
    id,
    title,
    permalinkUrl,
    artworkUrl: text(item.artwork_url) || null,
    username: text(user.username) || text(item.username) || 'Unknown artist',
    durationMs: Number.isFinite(duration) ? duration : null,
  };
}

export class SoundCloudApi {
  constructor(private readonly baseUrl: string) {}

  async search(query: string, signal?: AbortSignal): Promise<readonly SoundCloudTrack[]> {
    const url = new URL('/v1/search', this.baseUrl);
    url.searchParams.set('q', query);
    url.searchParams.set('kind', 'tracks');
    url.searchParams.set('limit', '20');
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(await errorMessage(response, 'Pencarian SoundCloud gagal'));
    const payload = record(await response.json());
    const collection = Array.isArray(payload.collection) ? payload.collection : [];
    return collection.map(trackOf).filter((item): item is SoundCloudTrack => item !== null);
  }

  async audio(trackUrl: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    const url = new URL('/v1/stream', this.baseUrl);
    url.searchParams.set('url', trackUrl);
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(await errorMessage(response, 'Audio SoundCloud tidak tersedia'));
    return response.arrayBuffer();
  }
}

async function errorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = record(await response.json());
    return text(body.message) || text(body.error) || `${fallback} (${response.status})`;
  } catch { return `${fallback} (${response.status})`; }
}

export function createSoundCloudApi(base = import.meta.env.VITE_SOUNDCLAUDE_API): SoundCloudApi {
  return new SoundCloudApi((base ?? 'http://localhost:8080').replace(/\/$/, ''));
}
