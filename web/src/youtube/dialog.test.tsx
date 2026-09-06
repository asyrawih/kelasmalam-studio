/**
 * Dialog impor YouTube (docs/23).
 *
 * Yang dijaga: perkakas yang belum ada terlihat dan diunduh HANYA lewat
 * tombol SIAPKAN; LIHAT hanya hidup untuk URL YouTube dan menampilkan judul
 * sebelum apa pun diunduh; + LANE mengunduh lalu menaruh clip bernama
 * judul.ekstensi di lane yang dipilih dan menutup dialog.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = {
  youtubeStatus: vi.fn(),
  youtubeSetup: vi.fn(),
  youtubeUpdate: vi.fn(),
  youtubeInfo: vi.fn(),
  youtubeAudio: vi.fn(),
  subscribeYoutubeProgress: vi.fn((_cb: unknown) => () => {}),
};
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  youtubeStatus: () => api.youtubeStatus(),
  youtubeSetup: () => api.youtubeSetup(),
  youtubeUpdate: () => api.youtubeUpdate(),
  youtubeInfo: (url: string) => api.youtubeInfo(url),
  youtubeAudio: (url: string) => api.youtubeAudio(url),
  subscribeYoutubeProgress: (cb: unknown) => api.subscribeYoutubeProgress(cb),
}));

const importBytesToLane = vi.fn();
vi.mock('../studio/timeline/audio-import', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../studio/timeline/audio-import')>()),
  importBytesToLane: (...args: unknown[]) => importBytesToLane(...args),
}));

import { studioActions, studioStore } from '../studio/store';
import { YouTubeDialog } from './YouTubeDialog';

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
  studioActions.__resetForTest?.('empty');
  api.youtubeStatus.mockResolvedValue({ ready: true, ytDlpVersion: '2026.08.19' });
  api.youtubeSetup.mockResolvedValue({ ready: true, ytDlpVersion: '2026.08.19' });
  api.youtubeInfo.mockResolvedValue(INFO);
  api.youtubeAudio.mockResolvedValue(new Uint8Array([1]).buffer);
  importBytesToLane.mockResolvedValue({ ok: true });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const status = (): HTMLElement => screen.getByRole('status');
const urlBox = (): HTMLInputElement => screen.getByLabelText('URL YouTube') as HTMLInputElement;
const button = (name: RegExp): HTMLButtonElement => screen.getByRole('button', { name }) as HTMLButtonElement;

describe('perkakas', () => {
  it('belum ada: badge merah + SIAPKAN; sesudah ditekan, status dibaca dari jawaban setup', async () => {
    api.youtubeStatus.mockResolvedValue({ ready: false, ytDlpVersion: null });
    render(<YouTubeDialog onClose={() => {}} />);
    await waitFor(() => expect(status().textContent).toMatch(/PERKAKAS BELUM ADA/));
    expect(button(/LIHAT/).disabled).toBe(true);

    fireEvent.click(button(/SIAPKAN/));
    await waitFor(() => expect(status().textContent).toMatch(/SIAP · yt-dlp 2026\.08\.19/));
    expect(api.youtubeSetup).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/yt-dlp 2026\.08\.19 terpasang/)).toBeDefined();
  });

  it('sudah ada: PERBARUI, dan jawabannya disebut', async () => {
    api.youtubeUpdate.mockResolvedValue(false);
    render(<YouTubeDialog onClose={() => {}} />);
    await waitFor(() => expect(status().textContent).toMatch(/SIAP/));
    fireEvent.click(button(/PERBARUI/));
    await waitFor(() => expect(screen.getByText(/sudah yang terbaru/)).toBeDefined());
  });
});

describe('lihat lalu + LANE', () => {
  it('LIHAT hanya hidup untuk URL YouTube; kartunya tampil sebelum ada unduhan', async () => {
    render(<YouTubeDialog onClose={() => {}} />);
    await waitFor(() => expect(status().textContent).toMatch(/SIAP/));

    fireEvent.change(urlBox(), { target: { value: 'https://soundcloud.com/a/b' } });
    expect(button(/LIHAT/).disabled).toBe(true);

    fireEvent.change(urlBox(), { target: { value: 'https://youtu.be/abc' } });
    expect(button(/LIHAT/).disabled).toBe(false);
    fireEvent.click(button(/LIHAT/));

    await waitFor(() => expect(screen.getByText('Lagu Malam')).toBeDefined());
    expect(api.youtubeInfo).toHaveBeenCalledWith('https://youtu.be/abc');
    expect(api.youtubeAudio).not.toHaveBeenCalled();
    expect(screen.getByText(/Kanal · 3:11 · M4A · 3\.0 MB/)).toBeDefined();
  });

  it('+ LANE: unduh, taruh sebagai judul.ekstensi di lane terpilih pada playhead, tutup', async () => {
    const onClose = vi.fn();
    render(<YouTubeDialog onClose={onClose} />);
    await waitFor(() => expect(status().textContent).toMatch(/SIAP/));
    fireEvent.change(urlBox(), { target: { value: 'https://youtu.be/abc' } });
    fireEvent.click(button(/LIHAT/));
    await waitFor(() => expect(screen.getByText('Lagu Malam')).toBeDefined());

    await act(async () => {
      fireEvent.click(button(/\+ LANE/));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

    expect(api.youtubeAudio).toHaveBeenCalledWith(INFO.webpageUrl);
    const laneId = studioStore.getState().lanes[0]!.id;
    const [, name, lane, start] = importBytesToLane.mock.calls[0]!;
    expect(name).toBe('Lagu Malam.m4a');
    expect(lane).toBe(laneId);
    expect(start).toBe(studioStore.getState().playhead);
    expect(studioStore.getState().selectedLaneId).toBe(laneId);
  });

  it('galat yt-dlp tampil apa adanya dan dialog tetap terbuka', async () => {
    api.youtubeInfo.mockRejectedValue(new Error('YouTube: Video unavailable'));
    const onClose = vi.fn();
    render(<YouTubeDialog onClose={onClose} />);
    await waitFor(() => expect(status().textContent).toMatch(/SIAP/));
    fireEvent.change(urlBox(), { target: { value: 'https://youtu.be/abc' } });
    fireEvent.click(button(/LIHAT/));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('YouTube: Video unavailable'));
    expect(onClose).not.toHaveBeenCalled();
  });
});
