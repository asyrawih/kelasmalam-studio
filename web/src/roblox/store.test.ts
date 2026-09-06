/**
 * Store antrean.
 *
 * Yang diuji di sini adalah janji-janji yang dipegang lapisan unggah nanti:
 * berkas non-audio ditolak di pintu dan dilaporkan namanya, byte bisa diambil
 * lewat `fileOf` dan hilang saat barisnya dihapus, dan baris yang tidak
 * disentuh mengembalikan objek YANG SAMA (dasar dari `memo` di `QueueRow`).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fileOf, robloxActions, robloxStore } from './store';

const mp3 = (name = 'lagu.mp3', bytes = 1024): File =>
  new File([new Uint8Array(bytes)], name, { type: 'audio/mpeg' });

const state = () => robloxStore.getState();

beforeEach(() => robloxActions.__resetForTest());

describe('addFiles', () => {
  it('menerima audio dan melaporkan yang ditolak dengan namanya', () => {
    const rejected = robloxActions.addFiles([
      mp3('a.mp3'),
      new File([new Uint8Array(8)], 'catatan.txt', { type: 'text/plain' }),
    ]);
    expect(rejected).toEqual(['catatan.txt']);
    expect(state().items.map((it) => it.fileName)).toEqual(['a.mp3']);
  });

  it('baris baru lahir sebagai draft bernama sama dengan berkasnya tanpa ekstensi', () => {
    robloxActions.addFiles([mp3('Kelas Malam.mp3', 4096)]);
    const it = state().items[0]!;
    expect(it).toMatchObject({ name: 'Kelas Malam', status: 'draft', seconds: null, bytes: 4096 });
  });

  it('berkas pertama langsung terpilih, dan drop kedua TIDAK memindahkan pilihan', () => {
    robloxActions.addFiles([mp3('a.mp3')]);
    const first = state().selected;
    robloxActions.addFiles([mp3('b.mp3')]);
    expect(state().selected).toBe(first);
  });

  it('drop yang seluruhnya ditolak tidak mengubah state sama sekali', () => {
    const before = state();
    robloxActions.addFiles([new File([new Uint8Array(1)], 'x.wav', { type: 'audio/wav' })]);
    expect(state()).toBe(before);
  });
});

describe('byte berkas', () => {
  it('bisa diambil lewat id, dan ikut hilang saat barisnya dihapus', () => {
    robloxActions.addFiles([mp3('a.mp3', 2048)]);
    const id = state().items[0]!.id;
    expect(fileOf(id)?.size).toBe(2048);

    robloxActions.remove(id);
    expect(fileOf(id)).toBeUndefined();
    expect(state().items).toEqual([]);
  });

  it('menghapus baris terpilih memindahkan pilihan, bukan meninggalkannya menggantung', () => {
    robloxActions.addFiles([mp3('a.mp3'), mp3('b.mp3')]);
    const a = state().items[0]!;
    const b = state().items[1]!;
    robloxActions.select(a.id);
    robloxActions.remove(a.id);
    expect(state().selected).toBe(b.id);
  });
});

describe('stabilitas referensi', () => {
  it('menyunting satu baris tidak menyentuh objek baris lain', () => {
    robloxActions.addFiles([mp3('a.mp3'), mp3('b.mp3')]);
    const a = state().items[0]!;
    const b = state().items[1]!;

    robloxActions.setName(a.id, 'BARU');
    const after = state().items;
    expect(after[0]).not.toBe(a);
    expect(after[1]).toBe(b);
  });

  it('menulis nilai yang sama tidak menghasilkan state baru', () => {
    robloxActions.addFiles([mp3('a.mp3')]);
    const before = state();
    robloxActions.setName(before.items[0]!.id, before.items[0]!.name);
    robloxActions.setApiKey('');
    expect(state()).toBe(before);
  });
});

describe('siklus hidup unggah', () => {
  it('berjalan dari antre sampai selesai, dan menyimpan asset id-nya', async () => {
    robloxActions.addFiles([mp3('a.mp3')]);
    const id = state().items[0]!.id;

    robloxActions.markQueued([id]);
    expect(state().items[0]!.status).toBe('queued');

    robloxActions.markUploading(id);
    robloxActions.markProgress(id, 42);
    expect(state().items[0]!).toMatchObject({ status: 'uploading', progress: 42 });

    await robloxActions.markProcessing(id);
    expect(state().items[0]!).toMatchObject({ status: 'processing', progress: 100 });

    await robloxActions.markDone(id, '9876');
    expect(state().items[0]!).toMatchObject({ status: 'done', assetId: '9876' });
  });

  it('menyimpan asset id provisional selama moderasi', async () => {
    robloxActions.addFiles([mp3('a.mp3')]);
    const id = state().items[0]!.id;
    await robloxActions.markProcessing(id, 'op-123', '4567');
    expect(state().items[0]!).toMatchObject({
      status: 'processing',
      operationId: 'op-123',
      assetId: '4567',
    });
  });

  it('status done + assetId menyalip backlog progress dan durable sebelum Promise selesai', async () => {
    const saved: Array<{ readonly items: readonly { status: string; assetId: string | null }[] }> = [];
    let release!: () => void;
    const firstWrite = new Promise<void>((resolve) => { release = resolve; });
    robloxActions.__setPersistenceForTest({
      save: async (value) => {
        saved.push(value);
        if (saved.length === 1) await firstWrite;
      },
      clear: async () => {},
    });

    robloxActions.addFiles([mp3('a.mp3')]); // transaksi pertama sengaja macet
    const id = state().items[0]!.id;
    robloxActions.markUploading(id);
    for (let pct = 1; pct <= 100; pct++) robloxActions.markProgress(id, pct);
    const durable = robloxActions.markDone(id, '9876');

    // Seratus update tidak menjadi seratus transaksi Blob: hanya snapshot
    // aktif + snapshot TERBARU yang menunggu.
    expect(saved).toHaveLength(1);
    release();
    await durable;
    // Satu snapshot awal + satu commit kritis. Publish UI menjadwalkan satu
    // snapshot gabungan lagi, tetapi assetId SUDAH durable sebelum itu.
    expect(saved.length).toBeGreaterThanOrEqual(2);
    expect(saved.some((entry) =>
      entry.items[0]?.status === 'done' && entry.items[0]?.assetId === '9876',
    )).toBe(true);
  });

  it('progress dijepit ke 0..100 — laporan aneh dari pengunggah tidak merusak bar', () => {
    robloxActions.addFiles([mp3('a.mp3')]);
    const id = state().items[0]!.id;
    robloxActions.markProgress(id, 140);
    expect(state().items[0]!.progress).toBe(100);
    robloxActions.markProgress(id, -5);
    expect(state().items[0]!.progress).toBe(0);
  });

  it('gagal menyimpan pesannya, dan ULANGI mengembalikannya ke draft bersih', () => {
    robloxActions.addFiles([mp3('a.mp3')]);
    const id = state().items[0]!.id;
    robloxActions.markUploading(id);
    robloxActions.markFailed(id, 'HTTP 401');
    expect(state().items[0]!).toMatchObject({ status: 'failed', error: 'HTTP 401' });

    robloxActions.retry(id);
    expect(state().items[0]!).toMatchObject({ status: 'draft', error: null, progress: 0 });
  });

  it('aksi untuk id yang sudah tidak ada diabaikan diam-diam', () => {
    const before = state();
    robloxActions.markDone(999, '1');
    expect(state()).toBe(before);
  });
});

describe('bersih-bersih', () => {
  it('BERSIHKAN SELESAI hanya membuang yang selesai — yang gagal sengaja ditinggal', async () => {
    robloxActions.addFiles([mp3('a.mp3'), mp3('b.mp3'), mp3('c.mp3')]);
    const a = state().items[0]!;
    const b = state().items[1]!;
    await robloxActions.markDone(a.id, '1');
    robloxActions.markFailed(b.id, 'gagal');

    robloxActions.clearDone();
    const names = state().items.map((it) => it.fileName);
    expect(names).toEqual(['b.mp3', 'c.mp3']);
    expect(fileOf(a.id)).toBeUndefined();
  });

  it('KOSONGKAN membuang semuanya berikut byte-nya', () => {
    robloxActions.addFiles([mp3('a.mp3'), mp3('b.mp3')]);
    const ids = state().items.map((it) => it.id);
    robloxActions.clearAll();
    expect(state().items).toEqual([]);
    expect(state().selected).toBeNull();
    for (const id of ids) expect(fileOf(id)).toBeUndefined();
  });
});

describe('kategori & genre massal (docs/21 §1d)', () => {
  it('setGenre memberi genre DAN kategori induknya ke semua id sekaligus', () => {
    robloxActions.addFiles([mp3('a.mp3'), mp3('b.mp3'), mp3('c.mp3')]);
    const [a, b, c] = state().items;
    robloxActions.setGenre([a!.id, c!.id], 'gen:musik/lo-fi');
    expect(state().items[0]).toMatchObject({ categoryId: 'kat:musik', genreId: 'gen:musik/lo-fi' });
    expect(state().items[2]).toMatchObject({ categoryId: 'kat:musik', genreId: 'gen:musik/lo-fi' });
    // Baris yang tidak disebut tetap objek yang SAMA — memo QueueRow bergantung padanya.
    expect(state().items[1]).toBe(b);
  });

  it('mengganti kategori mengosongkan genre yang bukan anaknya', () => {
    robloxActions.addFiles([mp3('a.mp3')]);
    const id = state().items[0]!.id;
    robloxActions.setGenre([id], 'gen:musik/lo-fi');
    robloxActions.setCategory([id], 'kat:efek-suara');
    expect(state().items[0]).toMatchObject({ categoryId: 'kat:efek-suara', genreId: null });
  });

  it('genre yang tidak ada di taksonomi ditolak diam-diam', () => {
    robloxActions.addFiles([mp3('a.mp3')]);
    const before = state();
    robloxActions.setGenre([before.items[0]!.id], 'gen:tidak-ada');
    expect(state()).toBe(before);
  });

  it('baris baru lahir dengan localId stabil dan tanpa kategori', () => {
    robloxActions.addFiles([mp3('a.mp3')]);
    const it = state().items[0]!;
    expect(it.localId).toMatch(/^rbx:/);
    expect(it).toMatchObject({ categoryId: null, genreId: null, hash: null });
  });
});

describe('taksonomi di web (adapter IndexedDB, keputusan di TS)', () => {
  it('tambah, ganti nama, pindah, hapus — semuanya mendarat di state', async () => {
    const cat = await robloxActions.addCategory('Podcast');
    expect(cat.ok).toBe(true);
    const catId = cat.ok ? cat.id : '';
    const gen = await robloxActions.addGenre(catId, 'Intro');
    expect(gen.ok).toBe(true);
    const genId = gen.ok ? gen.id : '';

    await robloxActions.renameGenre(genId, 'Pembuka');
    expect(state().taxonomy.genres.find((g) => g.id === genId)?.name).toBe('Pembuka');

    await robloxActions.moveGenre(genId, 'kat:suara');
    expect(state().taxonomy.genres.find((g) => g.id === genId)?.categoryId).toBe('kat:suara');

    expect((await robloxActions.deleteGenre(genId)).ok).toBe(true);
    expect((await robloxActions.deleteCategory(catId)).ok).toBe(true);
    expect(state().taxonomy.categories.some((c) => c.id === catId)).toBe(false);
  });

  it('hapus genre yang dipakai baris antrean ditolak dengan menyebut jumlahnya', async () => {
    robloxActions.addFiles([mp3('a.mp3'), mp3('b.mp3')]);
    robloxActions.setGenre(state().items.map((it) => it.id), 'gen:musik/lo-fi');
    const r = await robloxActions.deleteGenre('gen:musik/lo-fi');
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/dipakai 2 lagu/) });
    expect(state().taxonomy.genres.some((g) => g.id === 'gen:musik/lo-fi')).toBe(true);
  });

  it('hapus kategori yang masih punya genre ditolak; nama kosong ditolak', async () => {
    const r = await robloxActions.deleteCategory('kat:musik');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/9 genre/);
    expect((await robloxActions.addCategory('   ')).ok).toBe(false);
  });

  it('memindahkan genre ikut memindahkan kategori baris yang memakainya', async () => {
    robloxActions.addFiles([mp3('a.mp3')]);
    robloxActions.setGenre([state().items[0]!.id], 'gen:musik/lo-fi');
    await robloxActions.moveGenre('gen:musik/lo-fi', 'kat:suara');
    expect(state().items[0]).toMatchObject({ categoryId: 'kat:suara', genreId: 'gen:musik/lo-fi' });
  });
});

describe('katalog di web', () => {
  it('markDone memasukkan baris ke katalog; markFailed juga, dan ULANGI + DISETUJUI menimpanya', async () => {
    robloxActions.addFiles([mp3('a.mp3')]);
    robloxActions.setCreatorId('9');
    const id = state().items[0]!.id;
    robloxActions.markFailed(id, 'ditolak');
    await vi.waitFor(() => expect(state().catalog).toHaveLength(1));
    expect(state().catalog[0]).toMatchObject({ status: 'failed', creatorId: '9' });

    robloxActions.retry(id);
    await robloxActions.markDone(id, '777');
    expect(state().catalog).toHaveLength(1);
    expect(state().catalog[0]).toMatchObject({ status: 'done', assetId: '777', moderationState: 'approved' });
  });

  it('coba lagi dari katalog untuk baris yang masih di antrean = ULANGI baris itu', async () => {
    robloxActions.addFiles([mp3('a.mp3')]);
    const id = state().items[0]!.id;
    robloxActions.markFailed(id, 'ditolak');
    await vi.waitFor(() => expect(state().catalog).toHaveLength(1));
    expect(await robloxActions.retryFromCatalog(state().catalog[0]!)).toBeNull();
    expect(state().items[0]!.status).toBe('draft');
  });

  it('coba lagi tanpa byte di web mengatakan kenapa, bukan membuat baris kosong', async () => {
    robloxActions.addFiles([mp3('a.mp3')]);
    const id = state().items[0]!.id;
    robloxActions.markFailed(id, 'ditolak');
    await vi.waitFor(() => expect(state().catalog).toHaveLength(1));
    const row = state().catalog[0]!;
    robloxActions.remove(id);
    expect(await robloxActions.retryFromCatalog(row)).toMatch(/jatuhkan lagi/);
    expect(state().items).toEqual([]);
  });

  it('penyaring katalog melepas genre yang bukan anak kategori terpilih', () => {
    robloxActions.setCatalogFilter({ genreId: 'gen:musik/lo-fi' });
    robloxActions.setCatalogFilter({ categoryId: 'kat:suara' });
    expect(state().catalogFilter).toEqual({ categoryId: 'kat:suara', genreId: null, query: '' });
  });
});
