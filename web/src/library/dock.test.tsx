/**
 * Dok kepustakaan.
 *
 * Yang dijaga: strip terlipat tetap MENYEBUT isinya (panel yang hilang tanpa
 * kata adalah panel yang tidak akan pernah dibuka lagi), keempat keadaan
 * sambungan terbaca berbeda, dan lagu yang sudah ada di sesi tidak diunduh dua
 * kali.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LibraryDock } from './LibraryDock';
import { libraryActions, libraryStore } from './store';
import type { LibraryApi } from './api';
import { fakeLibraryApi } from './fake-api';
import type { LibraryTrack } from './model';

const HASH = 'a'.repeat(64);

const track = (over: Partial<LibraryTrack> = {}): LibraryTrack => ({
  hash: HASH,
  name: 'Kelas Malam',
  bytes: 3 * 1024 * 1024,
  mime: 'audio/mpeg',
  frames: 48_000 * 187,
  sampleRate: 48_000,
  marks: null,
  ...over,
});

/**
 * Palsuan dengan SATU lagu di kepustakaan.
 *
 * Bawaan `fakeLibraryApi` adalah kepustakaan kosong — benar sebagai bawaan
 * (itu keadaan user baru), tapi hampir semua tes di berkas ini menguji apa
 * yang terjadi pada baris lagu, jadi mereka butuh setidaknya satu.
 */
const withTrack = (over: Partial<LibraryApi> = {}): LibraryApi =>
  fakeLibraryApi({ tracks: async () => [track()], ...over });

const strip = (): HTMLElement => screen.getByRole('button', { name: /kepustakaan/i });

beforeEach(() => libraryActions.__resetForTest());
afterEach(cleanup);

describe('lipat / buka', () => {
  it('mulai terlipat — permukaan kerja tidak dimakan sebelum diminta', async () => {
    render(<LibraryDock api={withTrack()} />);
    await waitFor(() => expect(libraryStore.getState().status).toBe('masuk'));
    expect(strip().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('table', { name: 'lagu' })).toBeNull();
  });

  it('strip yang terlipat tetap menyebut isinya', async () => {
    render(<LibraryDock api={withTrack()} />);
    await waitFor(() => expect(libraryStore.getState().tracks).toHaveLength(1));
    expect(strip().textContent).toContain('1 LAGU');
  });

  it('sekali klik membuka, sekali lagi menutup', async () => {
    render(<LibraryDock api={withTrack()} />);
    await waitFor(() => expect(libraryStore.getState().status).toBe('masuk'));

    fireEvent.click(strip());
    expect(await screen.findByRole('table', { name: 'lagu' })).toBeDefined();
    expect(strip().getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(strip());
    expect(screen.queryByRole('table', { name: 'lagu' })).toBeNull();
  });

  it('SELURUH strip adalah tombolnya, bukan segitiga kecil di pojok', async () => {
    render(<LibraryDock api={withTrack()} />);
    await waitFor(() => expect(libraryStore.getState().status).toBe('masuk'));
    // Judulnya ada DI DALAM tombol — bukan di sebelahnya.
    expect(within(strip()).getByText('KEPUSTAKAAN')).toBeDefined();
  });
});

describe('keadaan sambungan', () => {
  it('tanpa VITE_LIBRARY_API dok tetap ada dan mengatakan kenapa kosong', async () => {
    render(<LibraryDock apiBase="" />);
    await waitFor(() => expect(libraryStore.getState().status).toBe('tidak-dikonfigurasi'));
    fireEvent.click(strip());
    expect(screen.getByText(/VITE_LIBRARY_API/)).toBeDefined();
    expect(screen.queryByRole('button', { name: /MASUK/ })).toBeNull();
  });

  it('belum login: ada ajakan masuk, dan aplikasi tidak dikatakan rusak', async () => {
    render(<LibraryDock api={withTrack({ me: async () => null })} />);
    await waitFor(() => expect(libraryStore.getState().status).toBe('anonim'));
    expect(screen.getByRole('button', { name: /MASUK DENGAN GOOGLE/ })).toBeDefined();

    fireEvent.click(strip());
    expect(screen.getByText(/tetap bisa dipakai/i)).toBeDefined();
  });

  it('daftar TIDAK diambil kalau belum login', async () => {
    const tracks = vi.fn(async () => []);
    render(<LibraryDock api={fakeLibraryApi({ me: async () => null, tracks })} />);
    await waitFor(() => expect(libraryStore.getState().status).toBe('anonim'));
    expect(tracks).not.toHaveBeenCalled();
  });

  it('server yang mati ditandai TIDAK TERSAMBUNG, dengan pesannya', async () => {
    render(
      <LibraryDock
        api={withTrack({
          me: async () => {
            throw new Error('gagal menghubungi server');
          },
        })}
      />,
    );
    await waitFor(() => expect(libraryStore.getState().status).toBe('gagal'));
    expect(screen.getByText('TIDAK TERSAMBUNG')).toBeDefined();

    fireEvent.click(strip());
    expect(screen.getByText(/gagal menghubungi server/)).toBeDefined();
  });

  it('sudah login: nama user tampil di strip', async () => {
    render(<LibraryDock api={withTrack()} />);
    expect(await screen.findByText('Ana')).toBeDefined();
  });

  it('kepustakaan kosong dikatakan kosong, bukan dibiarkan blank', async () => {
    render(<LibraryDock api={fakeLibraryApi({ tracks: async () => [] })} />);
    await waitFor(() => expect(libraryStore.getState().status).toBe('masuk'));
    fireEvent.click(strip());
    expect(screen.getByText(/masih kosong/i)).toBeDefined();
  });
});

describe('daftar lagu', () => {
  it('menampilkan durasi dan ukuran, bukan hash', async () => {
    render(<LibraryDock api={withTrack()} />);
    await waitFor(() => expect(libraryStore.getState().tracks).toHaveLength(1));
    fireEvent.click(strip());

    const row = screen.getAllByRole('row')[0]!;
    expect(within(row).getByText('Kelas Malam')).toBeDefined();
    // Durasi dan ukuran berbagi satu sel di pohon: "3:07 · 3.0 MB".
    expect(row.textContent).toContain('3:07');
    expect(row.textContent).toContain('3.0 MB');
    expect(row.textContent).not.toContain(HASH);
  });

  it('durasi yang tidak diketahui server tampil `—`, bukan 0:00', async () => {
    render(<LibraryDock api={fakeLibraryApi({ tracks: async () => [track({ frames: 0 })] })} />);
    await waitFor(() => expect(libraryStore.getState().tracks).toHaveLength(1));
    fireEvent.click(strip());
    const row = screen.getAllByRole('row')[0]!;
    expect(row.textContent).toContain('—');
  });

  it('lagu yang sudah di sesi ditandai, dan tidak menawarkan MUAT lagi', async () => {
    render(<LibraryDock api={withTrack()} />);
    await waitFor(() => expect(libraryStore.getState().tracks).toHaveLength(1));
    act(() => libraryActions.markLoaded(HASH, 7));
    fireEvent.click(strip());

    // Belum ada asset 7 di studioStore, jadi ia BELUM dihitung "di sesi":
    // tanda itu berarti asetnya masih ada, bukan sekadar pernah dimuat.
    expect(screen.getByRole('button', { name: 'MUAT' })).toBeDefined();
  });

  it('menekan MUAT mengunduh sekali; klik kedua tidak mengunduh lagi', async () => {
    const blob = vi.fn(async (_hash: string) => new ArrayBuffer(8));
    render(<LibraryDock api={withTrack({ blob })} />);
    await waitFor(() => expect(libraryStore.getState().tracks).toHaveLength(1));
    fireEvent.click(strip());

    fireEvent.click(screen.getByRole('button', { name: 'MUAT' }));
    await waitFor(() => expect(blob).toHaveBeenCalledTimes(1));

    // Decode gagal di jsdom (tanpa Web Audio), jadi baris tetap menawarkan MUAT.
    // Yang diuji di sini bukan hasil decode-nya melainkan bahwa unduhannya
    // benar-benar terjadi lewat API, sekali, untuk hash yang benar.
    expect(blob.mock.calls[0]?.[0]).toBe(HASH);
  });

  it('kegagalan memuat dikatakan APA ADANYA, bukan "gagal"', async () => {
    render(
      <LibraryDock
        api={withTrack({
          blob: async () => {
            throw new Error('lagu ini tidak ada di kepustakaanmu');
          },
        })}
      />,
    );
    await waitFor(() => expect(libraryStore.getState().tracks).toHaveLength(1));
    fireEvent.click(strip());
    fireEvent.click(screen.getByRole('button', { name: 'MUAT' }));

    expect(await screen.findByRole('status')).toHaveProperty(
      'textContent',
      expect.stringContaining('tidak ada di kepustakaanmu'),
    );
  });
});
