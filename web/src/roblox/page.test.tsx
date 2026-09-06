/**
 * Halaman dari ujung ke ujung, di titik-titik yang paling mudah rusak diam-diam.
 *
 * Yang dijaga: tombol UNGGAH TIDAK BOLEH bisa ditekan selama lapisan unggahnya
 * belum ada, dan alasannya harus terbaca. Itu satu-satunya hal di halaman ini
 * yang, kalau salah, membuat user mengira lagunya sudah terkirim.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { RobloxPage } from './RobloxPage';
import { robloxActions, robloxStore } from './store';
import { MAX_BYTES, type QueueItem } from './model';

const mp3 = (name = 'lagu.mp3', bytes = 1024): File =>
  new File([new Uint8Array(bytes)], name, { type: 'audio/mpeg' });

/** Isi antrean lewat `<input type=file>` — jalur yang sama dengan yang dipakai
 *  user tanpa tetikus. */
function drop(files: readonly File[]): void {
  const input = screen.getByLabelText('pilih berkas audio');
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
}

function verifyDurations(seconds = 60): void {
  fromUploader(() => {
    for (const item of robloxStore.getState().items) robloxActions.setDuration(item.id, seconds);
  });
}

/** Kategori & genre wajib sejak docs/21 §1d — beri semua baris genre bawaan. */
function assignGenre(genreId = 'gen:musik/lo-fi'): void {
  fromUploader(() => {
    robloxActions.setGenre(robloxStore.getState().items.map((it) => it.id), genreId);
  });
}

/**
 * Mutasi store dari LUAR React — persis yang dilakukan lapisan unggah nanti.
 * Dibungkus `act` supaya render yang dipicunya selesai sebelum diperiksa;
 * tanpa itu assertion membaca DOM satu langkah sebelum perubahannya mendarat.
 */
const fromUploader = (fn: () => void): void => {
  act(fn);
};

const uploadButton = (): HTMLButtonElement =>
  screen.getByRole('button', { name: /^UNGGAH/ }) as HTMLButtonElement;

/** Nama berkas yang benar-benar diserahkan ke `onUpload` pada panggilan pertama. */
const sentNames = (spy: Mock): readonly string[] =>
  (spy.mock.calls[0]?.[0] ?? []).map((it: QueueItem) => it.fileName);

beforeEach(() => robloxActions.__resetForTest());
afterEach(cleanup);

describe('tombol unggah', () => {
  it('mati dan mengatakan alasannya selama lapisan unggah belum tersambung', () => {
    render(<RobloxPage />);
    drop([mp3()]);

    expect(uploadButton().disabled).toBe(true);
    expect(screen.getByText(/masih UI saja/i).textContent).toMatch(/UI saja/);
  });

  it('tetap mati kalau backend siap tapi target belum lengkap', () => {
    const onUpload = vi.fn();
    render(<RobloxPage onUpload={onUpload} />);
    fromUploader(() => robloxActions.setBackendReady(true));
    drop([mp3()]);

    expect(uploadButton().disabled).toBe(true);
    fireEvent.click(uploadButton());
    expect(onUpload).not.toHaveBeenCalled();
  });

  it('hidup begitu backend, target, dan satu baris sah semuanya ada', () => {
    const onUpload = vi.fn();
    render(<RobloxPage onUpload={onUpload} />);
    fromUploader(() => robloxActions.setBackendReady(true));
    fromUploader(() => robloxActions.setCreatorId('123'));
    fromUploader(() => robloxActions.setApiKey('kunci'));
    drop([mp3('lagu.mp3')]);
    verifyDurations();
    assignGenre();

    expect(uploadButton().disabled).toBe(false);
    fireEvent.click(uploadButton());
    expect(onUpload).toHaveBeenCalledTimes(1);
    expect(sentNames(onUpload)).toEqual(['lagu.mp3']);
  });

  it('baris yang melanggar batas tidak ikut dikirim', () => {
    const onUpload = vi.fn();
    render(<RobloxPage onUpload={onUpload} />);
    fromUploader(() => robloxActions.setBackendReady(true));
    fromUploader(() => robloxActions.setCreatorId('123'));
    fromUploader(() => robloxActions.setApiKey('kunci'));
    drop([mp3('kecil.mp3'), mp3('raksasa.mp3', MAX_BYTES + 1)]);
    verifyDurations();
    assignGenre();

    fireEvent.click(uploadButton());
    expect(sentNames(onUpload)).toEqual(['kecil.mp3']);
  });
});

describe('antrean', () => {
  it('berkas bukan audio tidak jadi baris, dan namanya disebut', () => {
    render(<RobloxPage />);
    drop([mp3('a.mp3'), new File([new Uint8Array(4)], 'catatan.txt', { type: 'text/plain' })]);

    expect(robloxStore.getState().items).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toContain('catatan.txt');
  });

  it('pelanggaran ditulis sebagai kalimat di barisnya, bukan disembunyikan', () => {
    render(<RobloxPage />);
    drop([mp3('raksasa.mp3', MAX_BYTES + 1)]);

    const row = screen.getAllByRole('row')[0]!;
    expect(within(row).getByText(/melewati batas 20\.0 MB/).textContent).toContain('!');
  });

  it('menyunting nama di panel detail mengubah baris yang terpilih', () => {
    render(<RobloxPage />);
    drop([mp3('a.mp3')]);

    fireEvent.change(screen.getByLabelText('Nama asset'), { target: { value: 'NAMA BARU' } });
    expect(robloxStore.getState().items[0]!.name).toBe('NAMA BARU');
  });

  it('HAPUS membuang barisnya tanpa ikut memilih baris itu lebih dulu', () => {
    render(<RobloxPage />);
    drop([mp3('a.mp3'), mp3('b.mp3')]);

    fireEvent.click(screen.getByLabelText('hapus b.mp3'));
    expect(robloxStore.getState().items.map((it) => it.fileName)).toEqual(['a.mp3']);
    expect(robloxStore.getState().selected).toBe(robloxStore.getState().items[0]!.id);
  });
});

describe('kunci saat berjalan', () => {
  it('API key tidak bisa diubah sementara ada baris yang sedang diunggah', () => {
    render(<RobloxPage />);
    drop([mp3('a.mp3')]);
    fromUploader(() => robloxActions.markUploading(robloxStore.getState().items[0]!.id));

    expect((screen.getByLabelText('API key Open Cloud') as HTMLInputElement).disabled).toBe(true);
  });

  it('baris aktif tidak bisa dihapus sementara unggahan berjalan', () => {
    render(<RobloxPage />);
    drop([mp3('a.mp3')]);
    fromUploader(() => robloxActions.markUploading(robloxStore.getState().items[0]!.id));

    expect((screen.getByLabelText('hapus a.mp3') as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'KOSONGKAN' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('baris yang masih ANTRE bisa dihapus saat baris lain sedang dimoderasi', async () => {
    render(<RobloxPage />);
    drop([mp3('aktif.mp3'), mp3('menunggu.mp3')]);
    const [aktif, menunggu] = robloxStore.getState().items;
    await act(async () => {
      robloxActions.markQueued([aktif!.id, menunggu!.id]);
      await robloxActions.markProcessing(aktif!.id, 'op-aktif');
    });

    expect((screen.getByLabelText('hapus aktif.mp3') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('hapus menunggu.mp3') as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByLabelText('hapus menunggu.mp3'));
    expect(robloxStore.getState().items.map((it) => it.fileName)).toEqual(['aktif.mp3']);
  });
});

describe('kategori & genre (docs/21 §1d)', () => {
  it('baris tanpa genre tidak bisa diunggah dan alasannya tertulis di barisnya', () => {
    const onUpload = vi.fn();
    render(<RobloxPage onUpload={onUpload} />);
    fromUploader(() => robloxActions.setBackendReady(true));
    fromUploader(() => robloxActions.setCreatorId('123'));
    fromUploader(() => robloxActions.setApiKey('kunci'));
    drop([mp3('lagu.mp3')]);
    verifyDurations();

    const row = screen.getAllByRole('row')[0]!;
    expect(within(row).getByText(/kategori belum dipilih/).textContent).toContain('!');
    expect(uploadButton().disabled).toBe(true);
  });

  it('kolom KATEGORI dan GENRE ada di tiap baris, dan berantai: genre menunggu kategori', () => {
    render(<RobloxPage />);
    drop([mp3('lagu.mp3')]);

    const category = screen.getByLabelText('kategori lagu.mp3') as HTMLSelectElement;
    const genre = screen.getByLabelText('genre lagu.mp3') as HTMLSelectElement;
    expect(genre.disabled).toBe(true);

    fireEvent.change(category, { target: { value: 'kat:musik' } });
    expect(robloxStore.getState().items[0]!.categoryId).toBe('kat:musik');
    expect((screen.getByLabelText('genre lagu.mp3') as HTMLSelectElement).disabled).toBe(false);

    fireEvent.change(screen.getByLabelText('genre lagu.mp3'), { target: { value: 'gen:musik/edm' } });
    expect(robloxStore.getState().items[0]!.genreId).toBe('gen:musik/edm');
  });

  it('pilihan massal memberi genre ke SEMUA baris yang dicentang dalam satu klik', () => {
    render(<RobloxPage />);
    drop([mp3('a.mp3'), mp3('b.mp3'), mp3('c.mp3')]);

    fireEvent.click(screen.getByLabelText('pilih a.mp3'));
    fireEvent.click(screen.getByLabelText('pilih c.mp3'));
    fireEvent.change(screen.getByLabelText('kategori untuk baris terpilih'), { target: { value: 'kat:musik' } });
    fireEvent.change(screen.getByLabelText('genre untuk baris terpilih'), { target: { value: 'gen:musik/lo-fi' } });
    fireEvent.click(screen.getByRole('button', { name: /TERAPKAN KE 2 BARIS/ }));

    const byName = (n: string) => robloxStore.getState().items.find((it) => it.fileName === n)!;
    expect(byName('a.mp3')).toMatchObject({ categoryId: 'kat:musik', genreId: 'gen:musik/lo-fi' });
    expect(byName('c.mp3')).toMatchObject({ categoryId: 'kat:musik', genreId: 'gen:musik/lo-fi' });
    expect(byName('b.mp3')).toMatchObject({ categoryId: null, genreId: null });
  });

  it('"+ genre baru" di panel detail membuat genre dan langsung memasangnya ke baris', async () => {
    render(<RobloxPage />);
    drop([mp3('lagu.mp3')]);
    fireEvent.change(screen.getByLabelText('kategori baris terpilih'), { target: { value: 'kat:musik' } });
    fireEvent.change(screen.getByLabelText('nama genre baru'), { target: { value: 'Phonk' } });
    fireEvent.click(screen.getByRole('button', { name: '+ GENRE BARU' }));

    await waitFor(() => {
      const it = robloxStore.getState().items[0]!;
      const genre = robloxStore.getState().taxonomy.genres.find((g) => g.id === it.genreId);
      expect(genre?.name).toBe('Phonk');
      expect(genre?.categoryId).toBe('kat:musik');
    });
  });
});

describe('tab TAKSONOMI (docs/21 §1d)', () => {
  it('menolak menghapus genre yang dipakai, dengan pesan IN_USE yang menyebut jumlahnya', async () => {
    // Adapter dimock seperti Rust: `IN_USE` dengan `count`. Store hanya
    // meneruskan kalimatnya — panel tidak menghitung sendiri.
    robloxActions.__setPersistenceForTest({
      deleteGenre: async () => {
        throw { code: 'IN_USE', message: 'genre masih dipakai 3 lagu — ganti genre lagunya dulu', count: 3 };
      },
    });
    render(<RobloxPage />);
    fireEvent.click(screen.getByRole('tab', { name: 'TAKSONOMI' }));
    fireEvent.click(screen.getByLabelText('hapus genre Lo-fi'));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/dipakai 3 lagu/));
    expect(robloxStore.getState().taxonomy.genres.some((g) => g.id === 'gen:musik/lo-fi')).toBe(true);
  });

  it('menambah kategori dan genre baru, lalu memindahkan genre ke kategori lain', async () => {
    render(<RobloxPage />);
    fireEvent.click(screen.getByRole('tab', { name: 'TAKSONOMI' }));
    fireEvent.change(screen.getByLabelText('kategori baru'), { target: { value: 'Podcast' } });
    fireEvent.click(screen.getByRole('button', { name: '+ KATEGORI' }));
    await waitFor(() => expect(screen.getByLabelText('genre baru di Podcast')).toBeDefined());

    fireEvent.change(screen.getByLabelText('genre baru di Podcast'), { target: { value: 'Intro' } });
    fireEvent.click(within(screen.getByLabelText('genre baru di Podcast').parentElement!).getByRole('button', { name: '+ GENRE' }));
    await waitFor(() => expect(screen.getByLabelText('hapus genre Intro')).toBeDefined());

    fireEvent.change(screen.getByLabelText('pindahkan genre Intro ke kategori'), { target: { value: 'kat:suara' } });
    await waitFor(() => {
      const intro = robloxStore.getState().taxonomy.genres.find((g) => g.name === 'Intro');
      expect(intro?.categoryId).toBe('kat:suara');
    });
  });
});
