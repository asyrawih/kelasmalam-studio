import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOUNDCLOUD_API_DEFAULT, SoundCloudApi, soundCloudApiBase } from './api';

const track = { id: 7, title: 'Night Drive', permalink_url: 'https://soundcloud.com/a/night-drive', artwork_url: null, duration: 123000, user: { username: 'A' } };
function json(body: unknown): Response { return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }); }

describe('SoundCloudApi', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('memetakan search, related, dan likes menjadi track', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(json({ collection: [track] }))); vi.stubGlobal('fetch', fetch);
    const api = new SoundCloudApi('https://sc.example');
    expect((await api.search('night')).tracks[0]?.title).toBe('Night Drive');
    expect((await api.related(7))[0]?.id).toBe(7);
    expect((await api.likes('https://soundcloud.com/a'))[0]?.username).toBe('A');
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/v1/search', '/v1/related', '/v1/likes']);
  });

  it('resolve playlist memakai endpoint set agar seluruh stub terhidrasi', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ kind: 'playlist', title: 'Set' }))
      .mockResolvedValueOnce(json({ title: 'Set', tracks: [track] }));
    vi.stubGlobal('fetch', fetch); const result = await new SoundCloudApi('https://sc.example').resolve('https://soundcloud.com/a/sets/x');
    expect(result.kind).toBe('playlist'); expect(result.tracks).toHaveLength(1);
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/v1/resolve', '/v1/set']);
  });

  it('mengenali URL /tracks sebagai profil walau resolve tidak mengirim kind', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({ id: 9, username: 'BMB', permalink_url: 'https://soundcloud.com/bmb', track_count: 30 }))
      .mockResolvedValueOnce(json({ id: 9, kind: 'user', username: 'BMB', permalink_url: 'https://soundcloud.com/bmb', track_count: 30 }));
    vi.stubGlobal('fetch', fetch);
    const result = await new SoundCloudApi('https://sc.example').resolve('https://soundcloud.com/bmb/tracks');
    expect(result.kind).toBe('user');
    if (result.kind === 'user') expect(result.profile.trackCount).toBe(30);
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/v1/resolve', '/v1/user']);
  });

  it('menyediakan URL stream dan download yang aman', () => {
    const api = new SoundCloudApi('https://sc.example'); const source = 'https://soundcloud.com/a/a & b';
    expect(new URL(api.streamUrl(source)).searchParams.get('url')).toBe(source);
    expect(new URL(api.downloadUrl(source)).pathname).toBe('/v1/download');
  });
});

describe('soundCloudApiBase', () => {
  it('bawaan = server produksi di mode apa pun, bukan localhost', () => {
    expect(soundCloudApiBase(undefined)).toBe(SOUNDCLOUD_API_DEFAULT);
    expect(soundCloudApiBase('')).toBe(SOUNDCLOUD_API_DEFAULT);
    expect(soundCloudApiBase('   ')).toBe(SOUNDCLOUD_API_DEFAULT);
    expect(SOUNDCLOUD_API_DEFAULT).not.toContain('localhost');
  });

  it('env yang diisi menang, tanpa slash di ujung', () => {
    expect(soundCloudApiBase('http://localhost:8080/')).toBe('http://localhost:8080');
    expect(soundCloudApiBase('https://sc.example')).toBe('https://sc.example');
  });
});

