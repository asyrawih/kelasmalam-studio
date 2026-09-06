/**
 * Pembungkus command YouTube (docs/23): nama command yang dipanggil, bentuk
 * argumennya, pengenal URL, dan langganan progres yang aman dicabut sebelum
 * terpasang.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const callLocal = vi.fn();
vi.mock('../platform/local-invoke', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../platform/local-invoke')>()),
  callLocal: (...args: unknown[]) => callLocal(...args),
}));

type Listener = (event: { payload: unknown }) => void;
const listeners: Listener[] = [];
const unlisten = vi.fn();
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (_name: string, cb: Listener) => {
    listeners.push(cb);
    return unlisten;
  },
}));

import {
  formatYoutubeDuration,
  isYoutubeUrl,
  subscribeYoutubeProgress,
  youtubeAudio,
  youtubeFileName,
  youtubeInfo,
  youtubeSetup,
  youtubeStatus,
  youtubeUpdate,
} from './api';

afterEach(() => {
  callLocal.mockReset();
  unlisten.mockReset();
  listeners.length = 0;
});

describe('isYoutubeUrl', () => {
  it('mengenali youtube.com, youtu.be, music.youtube.com, youtube-nocookie.com', () => {
    for (const url of [
      'https://www.youtube.com/watch?v=abc',
      'https://youtube.com/shorts/abc',
      'https://youtu.be/abc',
      'https://music.youtube.com/watch?v=abc',
      'https://www.youtube-nocookie.com/embed/abc',
      '  https://YOUTU.BE/abc  ',
    ]) {
      expect(isYoutubeUrl(url), url).toBe(true);
    }
  });

  it('menolak host lain, teks biasa, dan skema selain http(s)', () => {
    for (const text of [
      'https://soundcloud.com/a/b',
      'https://notyoutube.com/x',
      'https://youtube.com.evil.example/x',
      'youtube.com/watch?v=abc',
      'lagu malam',
      '',
      'ftp://youtube.com/x',
    ]) {
      expect(isYoutubeUrl(text), text).toBe(false);
    }
  });
});

describe('command', () => {
  it('memetakan ke nama command kontrak dengan argumen apa adanya', async () => {
    callLocal.mockResolvedValue({ ready: true, ytDlpVersion: '2026.08.19' });
    expect(await youtubeStatus()).toEqual({ ready: true, ytDlpVersion: '2026.08.19' });
    expect(callLocal).toHaveBeenLastCalledWith('youtube_status', {});

    await youtubeSetup();
    expect(callLocal).toHaveBeenLastCalledWith('youtube_setup', {});

    callLocal.mockResolvedValue(true);
    expect(await youtubeUpdate()).toBe(true);
    expect(callLocal).toHaveBeenLastCalledWith('youtube_update', {});

    callLocal.mockResolvedValue({ id: 'abc' });
    await youtubeInfo('https://youtu.be/abc');
    expect(callLocal).toHaveBeenLastCalledWith('youtube_info', { url: 'https://youtu.be/abc' });

    const buf = new Uint8Array([1, 2]).buffer;
    callLocal.mockResolvedValue(buf);
    expect(await youtubeAudio('https://youtu.be/abc')).toBe(buf);
    expect(callLocal).toHaveBeenLastCalledWith('youtube_bytes', { url: 'https://youtu.be/abc' });
  });
});

describe('subscribeYoutubeProgress', () => {
  it('meneruskan payload event, dan berhenti sesudah dicabut', async () => {
    const seen: unknown[] = [];
    const off = subscribeYoutubeProgress((p) => seen.push(p));
    // Modul event Tauri di-import dinamis: pendengarnya terpasang beberapa
    // tick kemudian, bukan sinkron.
    await vi.waitFor(() => expect(listeners).toHaveLength(1));

    listeners[0]!({ payload: { phase: 'audio', name: 'abc', done: 1, total: 2 } });
    expect(seen).toEqual([{ phase: 'audio', name: 'abc', done: 1, total: 2 }]);

    off();
    expect(unlisten).toHaveBeenCalledTimes(1);
    listeners[0]!({ payload: { phase: 'audio', name: 'abc', done: 2, total: 2 } });
    expect(seen).toHaveLength(1);
  });

  it('dicabut SEBELUM terpasang: pendengar yang datang telat langsung dilepas', async () => {
    const off = subscribeYoutubeProgress(() => {});
    off();
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  });
});

describe('penyajian', () => {
  it('durasi: detik → m:ss, jam bila perlu, — bila tidak diketahui', () => {
    expect(formatYoutubeDuration(191)).toBe('3:11');
    expect(formatYoutubeDuration(3600 + 5)).toBe('1:00:05');
    expect(formatYoutubeDuration(0)).toBe('—');
  });

  it('nama berkas clip = judul + ekstensi format; judul kosong jatuh ke id', () => {
    const base = { id: 'abc', uploader: '', durationSec: 0, thumbnail: null, webpageUrl: '', bytes: 0 };
    expect(youtubeFileName({ ...base, title: 'Lagu Malam', ext: 'm4a' })).toBe('Lagu Malam.m4a');
    expect(youtubeFileName({ ...base, title: '  ', ext: '' })).toBe('abc.m4a');
  });
});
