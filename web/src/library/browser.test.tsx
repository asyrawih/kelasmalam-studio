/**
 * Kepustakaan dua panel: kiri project, kanan lagu.
 *
 * Yang dijaga di sini adalah hal-hal yang kalau meleset membuat kepustakaan
 * terlihat kosong padahal isinya ada, atau membuat user mengira ia sedang
 * mengerjakan project yang sebenarnya cuma ia lihat-lihat:
 *
 *  - SEMUA LAGU terpilih sejak awal — ke situlah lagu baru muncul
 *  - memilih project di sidebar hanya MENGGANTI TAMPILAN, bukan membuka project
 *  - isi project diambil saat dipilih, sekali, lalu diingat
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
const sisi = (name: string | RegExp): HTMLElement =>
  screen.getByRole('option', { name });
const lagu = (): HTMLElement[] => screen.queryAllByRole('row');

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

describe('dua panel', () => {
  it('SEMUA LAGU terpilih sejak awal, dan seluruh lagu tampil di kanan', async () => {
    await bukaDok();
    // Kalau yang terpilih adalah project pertama, lagu yang baru diunggah
    // tidak terlihat di mana pun sampai user menebak harus mengklik apa.
    expect(sisi(/SEMUA LAGU/).getAttribute('aria-selected')).toBe('true');
    expect(lagu()).toHaveLength(2);
  });

  it('project tampil di sidebar, dan belum dipilih', async () => {
    await bukaDok();
    expect(sisi(/Set Malam/).getAttribute('aria-selected')).toBe('false');
  });

  it('memilih project menampilkan LAGUNYA di panel kanan', async () => {
    await bukaDok();
    fireEvent.click(sisi(/Set Malam/));

    await waitFor(() => expect(lagu()).toHaveLength(1));
    expect(lagu()[0]?.textContent).toContain('Intro');
  });

  it('memilih project TIDAK membukanya di timeline', async () => {
    const project = vi.fn(async () => ({
      id: 'p1',
      name: 'Set Malam',
      json: { lanes: [{ clips: [{ contentHash: H1 }] }] },
      version: 3,
    }));
    await bukaDok(api({ project: project as unknown as LibraryApi['project'] }));
    fireEvent.click(sisi(/Set Malam/));
    await waitFor(() => expect(project).toHaveBeenCalled());

    // Melihat isi project ≠ mengerjakannya. Yang memuatnya ke timeline adalah
    // tombol BUKA DI TIMELINE, dan itu perbuatan yang jauh lebih besar.
    expect(libraryStore.getState().openProject).toBeNull();
  });

  it('isi project diambil SEKALI — pindah lalu kembali tidak memanggil server', async () => {
    const project = vi.fn(async () => ({
      id: 'p1',
      name: 'Set Malam',
      json: { lanes: [{ clips: [{ contentHash: H1 }] }] },
      version: 3,
    }));
    await bukaDok(api({ project: project as unknown as LibraryApi['project'] }));

    fireEvent.click(sisi(/Set Malam/));
    await waitFor(() => expect(project).toHaveBeenCalledTimes(1));
    fireEvent.click(sisi(/SEMUA LAGU/));
    fireEvent.click(sisi(/Set Malam/));
    await waitFor(() => expect(lagu()).toHaveLength(1));

    expect(project).toHaveBeenCalledTimes(1);
  });

  it('project yang tidak memakai lagu kepustakaan mengatakannya', async () => {
    await bukaDok(
      api({
        project: async () => ({ id: 'p1', name: 'Set Malam', json: { lanes: [] }, version: 3 }),
      }),
    );
    fireEvent.click(sisi(/Set Malam/));
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
    fireEvent.click(sisi(/Set Malam/));
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
  it('aksi project baru muncul SESUDAH project dipilih', async () => {
    await bukaDok();
    // Sebelum ada yang dipilih, "BUKA DI TIMELINE" tidak menunjuk apa pun.
    expect(screen.queryByRole('button', { name: /BUKA DI TIMELINE/i })).toBeNull();

    fireEvent.click(sisi(/Set Malam/));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /BUKA DI TIMELINE/i })).toBeDefined(),
    );
    expect(screen.getByRole('button', { name: /hapus project Set Malam/i })).toBeDefined();
  });
});

describe('seret ke lane', () => {
  it('baris lagu bisa diseret, dan yang dibawa HASH-nya', async () => {
    await bukaDok();
    const row = lagu()[0]!;
    expect(row.getAttribute('draggable')).toBe('true');

    const data: Record<string, string> = {};
    fireEvent.dragStart(row, {
      dataTransfer: {
        setData: (type: string, value: string) => {
          data[type] = value;
        },
        effectAllowed: '',
      },
    });

    // Yang dibawa hash, BUKAN byte-nya: lagunya bisa 25 MB, dan penerima drop
    // toh sudah tahu cara mengambilnya.
    expect(data['application/x-kelasmalam-track']).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('ikon lagu', () => {
  it('tiap baris lagu membawa ikon not balok', async () => {
    await bukaDok();
    for (const row of lagu()) {
      // SVG, bukan karakter `♪`: karakter itu digambar berbeda tiap sistem dan
      // di sebagian Windows jatuh ke kotak kosong.
      expect(row.querySelector('svg')).not.toBeNull();
    }
  });
});
