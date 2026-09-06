import { afterEach, describe, expect, it, vi } from 'vitest';

const callLocal = vi.fn();
vi.mock('../platform/local-invoke', () => ({ callLocal: (...args: unknown[]) => callLocal(...args) }));

import { SoundCloudApi } from './api';
import { desktopTransport } from './desktop-transport';

describe('desktopTransport (SoundCloud lewat Rust)', () => {
  afterEach(() => { callLocal.mockReset(); });

  it('json → soundcloud_json dengan URL utuh; status diteruskan apa adanya', async () => {
    callLocal.mockResolvedValueOnce({ status: 200, body: { collection: [{ id: 7, title: 'X', permalink_url: 'https://soundcloud.com/a/x', artwork_url: null, duration: 1000, user: { username: 'A' } }] } });
    const api = new SoundCloudApi('https://sc.example', desktopTransport);
    const page = await api.search('x');
    expect(page.tracks[0]?.id).toBe(7);
    expect(callLocal).toHaveBeenCalledWith('soundcloud_json', { url: 'https://sc.example/v1/search?q=x&kind=tracks&limit=20&offset=0' });
  });

  it('status galat memakai pesan server, seperti di web', async () => {
    callLocal.mockResolvedValueOnce({ status: 404, body: { message: 'track tidak ada' } });
    const api = new SoundCloudApi('https://sc.example', desktopTransport);
    await expect(api.track('https://soundcloud.com/a/hilang')).rejects.toThrow('track tidak ada');
  });

  it('health: 200 → true, galat transport → false (bukan throw)', async () => {
    callLocal.mockResolvedValueOnce({ status: 200, body: { ok: true } });
    const api = new SoundCloudApi('https://sc.example', desktopTransport);
    expect(await api.health()).toBe(true);
    callLocal.mockRejectedValueOnce(new Error('HTTP: koneksi ditolak'));
    expect(await api.health()).toBe(false);
  });

  it('audio → soundcloud_bytes mengembalikan ArrayBuffer', async () => {
    const buf = new Uint8Array([1, 2, 3]).buffer;
    callLocal.mockResolvedValueOnce(buf);
    const api = new SoundCloudApi('https://sc.example', desktopTransport);
    expect(await api.audio('https://soundcloud.com/a/x')).toBe(buf);
    expect(callLocal).toHaveBeenCalledWith('soundcloud_bytes', { url: 'https://sc.example/v1/stream?url=https%3A%2F%2Fsoundcloud.com%2Fa%2Fx' });
  });

  it('sinyal yang sudah dibatalkan: hasil dibuang, tidak ada panggilan ke Rust', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(desktopTransport.json('https://sc.example/health', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(callLocal).not.toHaveBeenCalled();
  });
});
