/**
 * Link YouTube yang di-drop/di-paste ke lane (docs/23).
 *
 * Yang dijaga: di WEB link YouTube tetap ditolak dengan pesan lama (unduh
 * dulu, drop berkasnya) tanpa menyentuh command apa pun; di DESKTOP ia
 * dibelokkan ke yt-dlp — perkakas yang belum ada TIDAK diunduh diam-diam,
 * nama clip = judul + ekstensi, dan progres unduhan sampai ke bar lane.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = {
  youtubeStatus: vi.fn(),
  youtubeInfo: vi.fn(),
  youtubeAudio: vi.fn(),
  subscribeYoutubeProgress: vi.fn(),
};
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  youtubeStatus: () => api.youtubeStatus(),
  youtubeInfo: (url: string) => api.youtubeInfo(url),
  youtubeAudio: (url: string) => api.youtubeAudio(url),
  subscribeYoutubeProgress: (cb: unknown) => api.subscribeYoutubeProgress(cb),
}));

const importBytesToLane = vi.fn();
vi.mock('../studio/timeline/audio-import', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../studio/timeline/audio-import')>()),
  importBytesToLane: (...args: unknown[]) => importBytesToLane(...args),
}));

import { setPlatformHostForTests, type PlatformHost } from '../platform';
import { LocalCommandError } from '../platform/local-invoke';
import { importUrlToLane } from '../studio/timeline/url-to-lane';
import { importYoutubeToLane, YOUTUBE_TOOLS_MISSING } from './import';

const URL_YT = 'https://youtu.be/abc';
const INFO = {
  id: 'abc',
  title: 'Lagu Malam',
  uploader: 'Kanal',
  durationSec: 191,
  thumbnail: null,
  webpageUrl: 'https://www.youtube.com/watch?v=abc',
  ext: 'm4a',
  bytes: 3_000_000,
};

beforeEach(() => {
  api.youtubeStatus.mockResolvedValue({ ready: true, ytDlpVersion: '2026.08.19' });
  api.youtubeInfo.mockResolvedValue(INFO);
  api.youtubeAudio.mockResolvedValue(new Uint8Array([9]).buffer);
  api.subscribeYoutubeProgress.mockReturnValue(() => {});
  importBytesToLane.mockResolvedValue({ ok: true });
});
afterEach(() => {
  vi.clearAllMocks();
  setPlatformHostForTests(null);
});

const asDesktop = (): void => setPlatformHostForTests({ kind: 'desktop' } as PlatformHost);
const asWeb = (): void => setPlatformHostForTests({ kind: 'web' } as PlatformHost);

describe('importYoutubeToLane', () => {
  it('info → audio → importBytesToLane dengan nama judul.ekstensi', async () => {
    const r = await importYoutubeToLane(URL_YT, 'lane-1', 480, 48_000, { avoidOverlap: true });
    expect(r).toEqual({ ok: true });
    expect(api.youtubeInfo).toHaveBeenCalledWith(URL_YT);
    expect(api.youtubeAudio).toHaveBeenCalledWith(URL_YT);
    const [bytes, name, laneId, start, sr, opts] = importBytesToLane.mock.calls[0]!;
    expect(new Uint8Array(bytes as ArrayBuffer)).toEqual(new Uint8Array([9]));
    expect(name).toBe('Lagu Malam.m4a');
    expect([laneId, start, sr]).toEqual(['lane-1', 480, 48_000]);
    expect((opts as { avoidOverlap?: boolean }).avoidOverlap).toBe(true);
  });

  it('perkakas belum ada: gagal dengan petunjuk ke dialog, tanpa mengunduh apa pun', async () => {
    api.youtubeStatus.mockResolvedValue({ ready: false, ytDlpVersion: null });
    const r = await importYoutubeToLane(URL_YT, 'lane-1', 0, 48_000);
    expect(r).toEqual({ ok: false, reason: YOUTUBE_TOOLS_MISSING });
    expect(api.youtubeInfo).not.toHaveBeenCalled();
    expect(api.youtubeAudio).not.toHaveBeenCalled();
  });

  it('progres unduhan video INI menjadi tahap reading berasio; video lain diabaikan; langganan dicabut', async () => {
    const unsubscribe = vi.fn();
    let emit: ((p: unknown) => void) | null = null;
    api.subscribeYoutubeProgress.mockImplementation((cb: unknown) => {
      emit = cb as (p: unknown) => void;
      return unsubscribe;
    });
    api.youtubeAudio.mockImplementation(async () => {
      emit!({ phase: 'audio', name: 'abc', done: 1_500_000, total: 3_000_000 });
      emit!({ phase: 'audio', name: 'lain', done: 1, total: 1 });
      emit!({ phase: 'tools', name: 'yt-dlp', done: 1, total: 1 });
      emit!({ phase: 'audio', name: 'abc', done: 10, total: 0 });
      return new ArrayBuffer(1);
    });
    const seen: unknown[] = [];
    await importYoutubeToLane(URL_YT, 'lane-1', 0, 48_000, { onProgress: (p) => seen.push(p) });
    expect(seen).toEqual([
      { stage: 'reading', ratio: null },
      { stage: 'reading', ratio: 0.5 },
      { stage: 'reading', ratio: null },
    ]);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('galat yt-dlp sampai sebagai kalimatnya sendiri', async () => {
    api.youtubeInfo.mockRejectedValue(
      new LocalCommandError({ code: 'YOUTUBE', message: 'YouTube: Video unavailable' }),
    );
    const r = await importYoutubeToLane(URL_YT, 'lane-1', 0, 48_000);
    expect(r).toEqual({ ok: false, reason: 'YouTube: Video unavailable' });
    expect(importBytesToLane).not.toHaveBeenCalled();
  });
});

describe('importUrlToLane: YouTube dibelokkan hanya di desktop', () => {
  it('desktop: link YouTube lewat yt-dlp, bukan fetch', async () => {
    asDesktop();
    const r = await importUrlToLane(URL_YT, 'lane-1', 0, 48_000);
    expect(r).toEqual({ ok: true });
    expect(api.youtubeAudio).toHaveBeenCalledWith(URL_YT);
  });

  it('web: pesan lama (unduh dulu, drop berkasnya), tanpa menyentuh command', async () => {
    asWeb();
    const r = await importUrlToLane(URL_YT, 'lane-1', 0, 48_000);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/link YouTube tidak bisa diunduh langsung dari browser/);
    expect(api.youtubeStatus).not.toHaveBeenCalled();
    expect(api.youtubeAudio).not.toHaveBeenCalled();
  });

  it('desktop: host lain yang butuh server (SoundCloud) TIDAK ikut dibelokkan', async () => {
    asDesktop();
    const r = await importUrlToLane('https://soundcloud.com/a/b', 'lane-1', 0, 48_000);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/SoundCloud/);
    expect(api.youtubeStatus).not.toHaveBeenCalled();
  });
});
