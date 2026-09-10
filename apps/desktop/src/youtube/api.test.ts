/**
 * Pembungkus command YouTube (docs/23): nama command yang dipanggil, bentuk
 * argumennya, pengenal URL, dan langganan progres yang aman dicabut sebelum
 * terpasang.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocalCommandError } from '../platform/local-invoke';

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
  forgetYoutubeStatus,
  forgetYoutubeStatusIfToolsBroken,
  formatYoutubeDuration,
  isYoutubeUrl,
  peekYoutubeStatus,
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
  // Cache-nya hidup di modul, bukan per tes.
  forgetYoutubeStatus();
});

const READY = { ready: true, ytDlpVersion: '2026.08.19' } as const;
const NOT_READY = { ready: false, ytDlpVersion: null } as const;

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

/**
 * Cache status perkakas: `yt-dlp --version` adalah PyInstaller yang 1–3
 * detik, dan yang menanyakannya (dialog tiap dibuka, drop link tiap kali)
 * tidak boleh membayarnya berulang. Yang dijaga di sini: jawaban `ready`
 * dipakai ulang, "belum terpasang" TIDAK, dua pemanggil bersamaan hanya satu
 * IPC, dan setiap hal yang mengubah kenyataan membuang cache-nya.
 */
describe('cache status', () => {
  it('jawaban ready dipakai ulang: pemeriksaan kedua tidak menyentuh Rust', async () => {
    callLocal.mockResolvedValue(READY);
    expect(peekYoutubeStatus()).toBeNull();

    expect(await youtubeStatus()).toEqual(READY);
    expect(await youtubeStatus()).toEqual(READY);
    expect(callLocal).toHaveBeenCalledTimes(1);
    expect(peekYoutubeStatus()).toEqual(READY);
  });

  it('belum terpasang TIDAK di-cache — SIAPKAN dari luar dialog tetap terbaca', async () => {
    callLocal.mockResolvedValue(NOT_READY);
    expect(await youtubeStatus()).toEqual(NOT_READY);
    expect(peekYoutubeStatus()).toBeNull();

    callLocal.mockResolvedValue(READY);
    expect(await youtubeStatus()).toEqual(READY);
    expect(callLocal).toHaveBeenCalledTimes(2);
  });

  it('dua pemanggil bersamaan ikut satu pemeriksaan yang sama', async () => {
    let settle: (s: unknown) => void = () => {};
    callLocal.mockReturnValue(new Promise((resolve) => (settle = resolve)));

    const a = youtubeStatus();
    const b = youtubeStatus();
    expect(callLocal).toHaveBeenCalledTimes(1);
    settle(READY);
    expect(await a).toEqual(READY);
    expect(await b).toEqual(READY);

    // Sesudah selesai, pemeriksaan berikutnya dijawab cache (bukan promise lama).
    callLocal.mockResolvedValue(NOT_READY);
    expect(await youtubeStatus()).toEqual(READY);
    expect(callLocal).toHaveBeenCalledTimes(1);
  });

  it('pemeriksaan yang GAGAL tidak meninggalkan promise nyangkut', async () => {
    callLocal.mockRejectedValueOnce(new LocalCommandError({ code: 'IO', message: 'gagal' }));
    await expect(youtubeStatus()).rejects.toThrow('gagal');
    expect(peekYoutubeStatus()).toBeNull();

    callLocal.mockResolvedValue(READY);
    expect(await youtubeStatus()).toEqual(READY);
    expect(callLocal).toHaveBeenCalledTimes(2);
  });

  it('jawaban youtube_setup langsung menjadi cache — tanpa youtube_status menyusul', async () => {
    callLocal.mockResolvedValue(READY);
    expect(await youtubeSetup()).toEqual(READY);
    expect(callLocal).toHaveBeenCalledTimes(1);
    expect(callLocal).toHaveBeenLastCalledWith('youtube_setup', {});

    expect(await youtubeStatus()).toEqual(READY);
    expect(callLocal).toHaveBeenCalledTimes(1);
  });

  it('setup yang berakhir tidak ready mengosongkan cache', async () => {
    callLocal.mockResolvedValueOnce(READY);
    await youtubeStatus();
    callLocal.mockResolvedValueOnce(NOT_READY);
    expect(await youtubeSetup()).toEqual(NOT_READY);
    expect(peekYoutubeStatus()).toBeNull();
  });

  it('update yang mengganti binari membuang cache; yang tidak mengganti tidak', async () => {
    callLocal.mockResolvedValueOnce(READY);
    await youtubeStatus();

    callLocal.mockResolvedValueOnce(false);
    expect(await youtubeUpdate()).toBe(false);
    expect(peekYoutubeStatus()).toEqual(READY);

    callLocal.mockResolvedValueOnce(true);
    expect(await youtubeUpdate()).toBe(true);
    expect(peekYoutubeStatus()).toBeNull();

    // Versi baru dibaca dari Rust, bukan dari cache lama.
    const NEW = { ready: true, ytDlpVersion: '2026.09.01' };
    callLocal.mockResolvedValueOnce(NEW);
    expect(await youtubeStatus()).toEqual(NEW);
  });

  it('update yang gagal membuang cache — keadaan berkas tidak dijamin', async () => {
    callLocal.mockResolvedValueOnce(READY);
    await youtubeStatus();
    callLocal.mockRejectedValueOnce(new LocalCommandError({ code: 'IO', message: 'unduhan putus' }));
    await expect(youtubeUpdate()).rejects.toThrow('unduhan putus');
    expect(peekYoutubeStatus()).toBeNull();
  });

  it('galat IO (yt-dlp tidak bisa dijalankan) membuang cache; galat YOUTUBE tidak', async () => {
    callLocal.mockResolvedValue(READY);
    await youtubeStatus();

    forgetYoutubeStatusIfToolsBroken(new LocalCommandError({ code: 'YOUTUBE', message: 'Video unavailable' }));
    expect(peekYoutubeStatus()).toEqual(READY);
    forgetYoutubeStatusIfToolsBroken(new Error('bukan LocalError'));
    expect(peekYoutubeStatus()).toEqual(READY);

    forgetYoutubeStatusIfToolsBroken(new LocalCommandError({ code: 'IO', message: 'No such file' }));
    expect(peekYoutubeStatus()).toBeNull();
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
