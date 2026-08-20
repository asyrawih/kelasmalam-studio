/**
 * Pohon kepustakaan: folder = project, isinya lagu.
 *
 * Yang dijaga di sini adalah tiga hal yang kalau meleset membuat kepustakaan
 * terlihat kosong padahal isinya ada:
 *
 *  - "Tanpa project" TERBUKA sejak awal — ke situlah lagu baru mendarat
 *  - isi folder diambil saat dibuka, sekali, lalu diingat
 *  - lagu yang dipakai project TIDAK muncul dua kali
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LibraryDock } from './LibraryDock';
import { fakeLibraryApi } from './fake-api';
import { libraryActions, libraryStore } from './store';
import type { LibraryApi } from './api';
import type { LibraryTrack } from './model';

const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);

const track = (hash: string, name: string): LibraryTrack => ({
  hash,
  name,
  bytes: 1024 * 1024,
  mime: 'audio/mpeg',
  frames: 48_000 * 90,
  sampleRate: 48_000,
  marks: null,
});

const api = (over: Partial<LibraryApi> = {}): LibraryApi =>
  fakeLibraryApi({
    tracks: async () => [track(H1, 'Intro'), track(H2, 'Kelas Malam')],
    projects: async () => [{ id: 'p1', name: 'Set Malam', updatedAt: 1, version: 3 }],
    project: async () => ({
      id: 'p1',
      name: 'Set Malam',
      json: { lanes: [{ clips: [{ contentHash: H1 }] }] },
      version: 3,
    }),
    ...over,
  });

const strip = (): HTMLElement => screen.getByRole('button', { name: /kepustakaan/i });
const items = (): HTMLElement[] => screen.getAllByRole('treeitem');
const folder = (name: string): HTMLElement =>
  items().find((el) => el.textContent?.includes(name)) as HTMLElement;

async function bukaDok(a: LibraryApi = api()): Promise<void> {
  render(<LibraryDock api={a} />);
  // Ditunggu sampai daftar SELESAI diambil — bukan sampai isinya sekian:
  // sebagian tes sengaja memakai kepustakaan kosong.
  await waitFor(() => expect(libraryStore.getState().listing).toBe(false));
  await waitFor(() => expect(libraryStore.getState().status).toBe('masuk'));
  fireEvent.click(strip());
}

beforeEach(() => libraryActions.__resetForTest());
afterEach(cleanup);

describe('bentuk pohon', () => {
  it('project tampil sebagai folder, dan mulai TERTUTUP', async () => {
    await bukaDok();
    const f = folder('Set Malam');
    expect(f.getAttribute('aria-expanded')).toBe('false');
    // Isinya belum diambil selama belum dibuka — "Intro" hanya muncul sekali,
    // di "Tanpa project", karena belum ada folder yang mengklaimnya.
    expect(within(f).queryByText('Intro')).toBeNull();
    expect(screen.getAllByText('Intro')).toHaveLength(1);
  });

  it('"Tanpa project" TERBUKA sejak awal — lagu baru mendarat di sana', async () => {
    await bukaDok();
    // Kalau ini tertutup, unggahan yang berhasil terlihat seperti tidak
    // terjadi apa-apa: dok terbuka, daftarnya kosong.
    expect(folder('Tanpa project').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Kelas Malam')).toBeDefined();
  });

  it('membuka folder mengambil isinya, dan lagunya muncul di dalamnya', async () => {
    await bukaDok();
    fireEvent.click(folder('Set Malam'));

    await waitFor(() => expect(screen.getByText('Intro')).toBeDefined());
    expect(folder('Set Malam').getAttribute('aria-expanded')).toBe('true');
  });

  it('lagu yang dipakai project TIDAK muncul lagi di "Tanpa project"', async () => {
    await bukaDok();
    fireEvent.click(folder('Set Malam'));
    await waitFor(() => expect(screen.getByText('Intro')).toBeDefined());

    // Satu-satunya tempat "Intro" boleh muncul adalah di dalam foldernya.
    expect(screen.getAllByText('Intro')).toHaveLength(1);
    expect(folder('Tanpa project').textContent).toContain('1');
  });

  it('isi folder diambil SEKALI — tutup lalu buka lagi tidak memanggil server', async () => {
    const project = vi.fn(async () => ({
      id: 'p1',
      name: 'Set Malam',
      json: { lanes: [{ clips: [{ contentHash: H1 }] }] },
      version: 3,
    }));
    await bukaDok(api({ project: project as unknown as LibraryApi['project'] }));

    fireEvent.click(folder('Set Malam'));
    await waitFor(() => expect(project).toHaveBeenCalledTimes(1));
    fireEvent.click(folder('Set Malam'));
    fireEvent.click(folder('Set Malam'));
    await waitFor(() => expect(screen.getByText('Intro')).toBeDefined());

    expect(project).toHaveBeenCalledTimes(1);
  });

  it('project yang tidak memakai lagu kepustakaan mengatakannya', async () => {
    await bukaDok(
      api({
        project: async () => ({ id: 'p1', name: 'Set Malam', json: { lanes: [] }, version: 3 }),
      }),
    );
    fireEvent.click(folder('Set Malam'));
    await waitFor(() =>
      expect(screen.getByText(/tidak memakai lagu dari kepustakaan/i)).toBeDefined(),
    );
  });

  it('lagu yang dipakai project tapi sudah dihapus tetap DISEBUT', async () => {
    await bukaDok(
      api({
        tracks: async () => [track(H2, 'Kelas Malam')],
        project: async () => ({
          id: 'p1',
          name: 'Set Malam',
          json: { lanes: [{ clips: [{ contentHash: H1 }] }] },
          version: 3,
        }),
      }),
    );
    fireEvent.click(folder('Set Malam'));
    // Menyembunyikannya membuat project terlihat utuh padahal ada yang hilang.
    await waitFor(() => expect(screen.getByText(/sudah dihapus/i)).toBeDefined());
  });

  it('kepustakaan kosong dikatakan kosong, bukan "sudah dipakai project"', async () => {
    await bukaDok(api({ tracks: async () => [], projects: async () => [] }));
    expect(screen.getByText(/masih kosong/i)).toBeDefined();
  });
});

describe('menambah lagu', () => {
  it('ada pintu yang kelihatan, bukan cuma lewat timeline', async () => {
    await bukaDok();
    // Pertanyaan "gimana cara masukin audio" harus punya jawaban yang terlihat
    // di dok itu sendiri.
    expect(screen.getByRole('button', { name: /TAMBAH LAGU/i })).toBeDefined();
    expect(screen.getByLabelText('tambah lagu ke kepustakaan')).toBeDefined();
  });
});

describe('project', () => {
  it('tombol BUKA dan HAPUS ada di baris foldernya', async () => {
    await bukaDok();
    const f = folder('Set Malam');
    expect(within(f).getByRole('button', { name: 'BUKA' })).toBeDefined();
    expect(within(f).getByRole('button', { name: /hapus project Set Malam/i })).toBeDefined();
  });

  it('menekan BUKA tidak ikut membuka/menutup foldernya', async () => {
    await bukaDok();
    const f = folder('Set Malam');
    expect(f.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(within(f).getByRole('button', { name: 'BUKA' }));
    // Klik tombol di dalam baris tidak boleh merembet jadi klik barisnya.
    expect(folder('Set Malam').getAttribute('aria-expanded')).toBe('false');
  });
});
