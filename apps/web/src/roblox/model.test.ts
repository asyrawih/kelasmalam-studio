/**
 * Aturan Roblox, diuji tanpa React.
 *
 * Yang dijaga di sini bukan "fungsinya jalan" melainkan tiga keputusan yang
 * mudah sekali dibalik oleh orang berikutnya tanpa sadar merusaknya:
 * durasi `null` DITAHAN, pelanggaran dikembalikan SEMUA, dan berkas berformat
 * salah tidak pernah masuk antrean.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_BYTES,
  MAX_DESC_LEN,
  MAX_NAME_LEN,
  MAX_SECONDS,
  baseNameOf,
  catalogSummary,
  createInitialRoblox,
  defaultTaxonomy,
  descriptionForRoblox,
  extOf,
  filterCatalog,
  formatBytes,
  formatDuration,
  fromUploadRow,
  genreLabel,
  groupCatalog,
  isAudioFile,
  isUploadable,
  readyItems,
  targetProblems,
  toUploadRow,
  violationsOf,
  type QueueItem,
  type RobloxState,
} from './model';

function item(patch: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 1,
    fileName: 'lagu.mp3',
    bytes: 3 * 1024 * 1024,
    seconds: 180,
    name: 'LAGU',
    description: '',
    status: 'draft',
    progress: 0,
    error: null,
    assetId: null,
    operationId: null,
    categoryId: 'kat:musik',
    genreId: 'gen:musik/lo-fi',
    localId: 'rbx:1',
    hash: null,
    ...patch,
  };
}

const codes = (it: QueueItem): readonly string[] => violationsOf(it).map((v) => v.code);

describe('penyaring pintu masuk', () => {
  it('menerima mp3 dan ogg lewat ekstensi maupun lewat MIME', () => {
    expect(isAudioFile('a.mp3', '')).toBe(true);
    expect(isAudioFile('a.OGG', '')).toBe(true);
    expect(isAudioFile('tanpa-ekstensi', 'audio/mpeg')).toBe(true);
  });

  it('menolak format yang tidak diterima Roblox — termasuk audio lain', () => {
    expect(isAudioFile('a.wav', 'audio/wav')).toBe(false);
    expect(isAudioFile('a.flac', 'audio/flac')).toBe(false);
    expect(isAudioFile('gambar.png', 'image/png')).toBe(false);
  });

  it('ekstensi diambil dari titik TERAKHIR, dan berkas titik-di-depan bukan ekstensi', () => {
    expect(extOf('mix.final.mp3')).toBe('.mp3');
    expect(extOf('.gitignore')).toBe('');
  });
});

describe('nama awal', () => {
  it('membuang ekstensi', () => {
    expect(baseNameOf('Kelas Malam.mp3')).toBe('Kelas Malam');
  });

  it('dipotong ke batas Roblox supaya baris baru tidak lahir sudah melanggar', () => {
    expect(baseNameOf(`${'x'.repeat(80)}.mp3`)).toHaveLength(MAX_NAME_LEN);
  });
});

describe('violationsOf', () => {
  it('berkas yang wajar tidak punya pelanggaran', () => {
    expect(violationsOf(item())).toEqual([]);
    expect(isUploadable(item())).toBe(true);
  });

  it('durasi yang belum dapat diverifikasi ditahan sebelum menghabiskan kuota', () => {
    expect(codes(item({ seconds: null }))).toEqual(['durasi-tidak-diketahui']);
    expect(isUploadable(item({ seconds: null }))).toBe(false);
  });

  it('tepat di batas masih lolos; satu lewat sudah tidak', () => {
    expect(codes(item({ seconds: MAX_SECONDS }))).toEqual([]);
    expect(codes(item({ seconds: MAX_SECONDS + 1 }))).toContain('durasi');
    expect(codes(item({ bytes: MAX_BYTES }))).toEqual([]);
    expect(codes(item({ bytes: MAX_BYTES + 1 }))).toContain('ukuran');
  });

  it('mengembalikan SEMUA alasan sekaligus, bukan yang pertama saja', () => {
    const bad = item({ fileName: 'a.wav', bytes: MAX_BYTES + 1, seconds: MAX_SECONDS + 1, name: '' });
    expect(codes(bad)).toEqual(['format', 'ukuran', 'durasi', 'nama-kosong']);
  });

  it('nama berisi spasi saja dihitung kosong', () => {
    expect(codes(item({ name: '   ' }))).toEqual(['nama-kosong']);
  });

  it('nama kepanjangan dan nama kosong tidak pernah muncul bersamaan', () => {
    expect(codes(item({ name: 'x'.repeat(MAX_NAME_LEN + 1) }))).toEqual(['nama-panjang']);
  });
});

describe('targetProblems', () => {
  it('target kosong menyebut kedua kekurangannya', () => {
    expect(targetProblems(createInitialRoblox().target)).toHaveLength(2);
  });

  it('id bukan angka ditolak dengan pesan yang berbeda dari id kosong', () => {
    const base = { creatorKind: 'user', apiKey: 'kunci', genreToDescription: true } as const;
    expect(targetProblems({ ...base, creatorId: 'abc' })).toEqual(['ID pemilik harus angka']);
    expect(targetProblems({ ...base, creatorId: '  ' })).toEqual(['ID pemilik belum diisi']);
    expect(targetProblems({ ...base, creatorId: '123' })).toEqual([]);
  });

  it('API key berisi spasi saja tetap dianggap kosong', () => {
    expect(targetProblems({ creatorKind: 'user', creatorId: '1', apiKey: ' ', genreToDescription: true })).toEqual([
      'API key Open Cloud belum diisi',
    ]);
  });
});

describe('readyItems', () => {
  const state = (items: readonly QueueItem[]): RobloxState => ({
    ...createInitialRoblox(),
    items,
  });

  it('hanya draft dan gagal yang berangkat — yang sedang jalan atau sudah selesai tidak', () => {
    const ids = readyItems(
      state([
        item({ id: 1, status: 'draft' }),
        item({ id: 2, status: 'failed' }),
        item({ id: 3, status: 'uploading' }),
        item({ id: 4, status: 'processing' }),
        item({ id: 5, status: 'done' }),
        item({ id: 6, status: 'queued' }),
      ]),
    ).map((it) => it.id);
    expect(ids).toEqual([1, 2]);
  });

  it('baris yang melanggar tidak ikut, walau statusnya draft', () => {
    expect(readyItems(state([item({ id: 1, name: '' })]))).toEqual([]);
  });
});

describe('format angka', () => {
  it('ukuran memakai basis yang sama dengan batasnya', () => {
    expect(formatBytes(MAX_BYTES)).toBe('20.0 MB');
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(2048)).toBe('2 KB');
  });

  it('durasi kosong tampil sebagai em dash, bukan 0:00', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatDuration(187)).toBe('3:07');
    expect(formatDuration(MAX_SECONDS)).toBe('7:00');
  });
});

describe('kategori & genre wajib (docs/21 §1d)', () => {
  it('tanpa kategori → kategori-kosong; pesannya menyebut cara memperbaikinya', () => {
    const v = violationsOf(item({ categoryId: null, genreId: null }));
    expect(v.map((x) => x.code)).toEqual(['kategori-kosong']);
    expect(v[0]!.message).toMatch(/pilih di kolom KATEGORI/);
    expect(v[0]!.message).toMatch(/terapkan sekaligus/);
  });

  it('kategori ada tapi genre kosong → genre-kosong, dan menyebut "+ genre baru"', () => {
    const v = violationsOf(item({ genreId: null }));
    expect(v.map((x) => x.code)).toEqual(['genre-kosong']);
    expect(v[0]!.message).toMatch(/genre baru/);
  });

  it('baris tanpa genre tidak pernah ready, walau semua yang lain sah', () => {
    const state: RobloxState = { ...createInitialRoblox(), items: [item({ id: 1, genreId: null })] };
    expect(isUploadable(item({ genreId: null }))).toBe(false);
    expect(readyItems(state)).toEqual([]);
  });

  it('kode genre muncul SETELAH kode teks — urutan dari yang paling sulit diperbaiki', () => {
    expect(codes(item({ name: '', categoryId: null }))).toEqual(['nama-kosong', 'kategori-kosong']);
  });
});

describe('taksonomi bawaan', () => {
  it('tiga kategori dari docs/21 §1d dengan id deterministik', () => {
    const t = defaultTaxonomy();
    expect(t.categories.map((c) => c.id)).toEqual(['kat:musik', 'kat:efek-suara', 'kat:suara']);
    expect(t.genres.find((g) => g.id === 'gen:musik/lo-fi')?.categoryId).toBe('kat:musik');
    expect(t.genres.filter((g) => g.categoryId === 'kat:efek-suara')).toHaveLength(5);
  });

  it('label genre memakai nama kategori DAN genre, dan jujur kalau salah satunya sudah dihapus', () => {
    const t = defaultTaxonomy();
    expect(genreLabel(t, 'kat:musik', 'gen:musik/lo-fi')).toBe('Musik / Lo-fi');
    expect(genreLabel(t, 'kat:musik', null)).toBe('—');
    expect(genreLabel(t, 'kat:suara', 'gen:musik/lo-fi')).toBe('—');
    expect(genreLabel({ categories: [], genres: [] }, 'kat:musik', 'gen:musik/lo-fi')).toBe('—');
  });
});

describe('deskripsi ke Roblox (docs/21 §3d)', () => {
  const t = defaultTaxonomy();

  it('menambah baris Genre di akhir kalau opsinya hidup, dan tidak kalau mati', () => {
    expect(descriptionForRoblox(item({ description: 'halo' }), t, true)).toBe('halo\n\nGenre: Musik / Lo-fi');
    expect(descriptionForRoblox(item({ description: '' }), t, true)).toBe('Genre: Musik / Lo-fi');
    expect(descriptionForRoblox(item({ description: 'halo' }), t, false)).toBe('halo');
  });

  it('tidak menambah apa pun kalau genre belum lengkap atau kalau melewati batas 1000', () => {
    expect(descriptionForRoblox(item({ description: 'halo', genreId: null }), t, true)).toBe('halo');
    const long = 'x'.repeat(MAX_DESC_LEN - 5);
    expect(descriptionForRoblox(item({ description: long }), t, true)).toBe(long);
  });
});

describe('katalog (docs/21 §3a)', () => {
  const t = defaultTaxonomy();
  const now = 1_000;
  const rows = [
    toUploadRow(item({ id: 1, localId: 'a', status: 'done', assetId: '1' }), { creatorKind: 'user', creatorId: '9' }, now),
    toUploadRow(item({ id: 2, localId: 'b', status: 'done', assetId: '2', genreId: 'gen:musik/edm' }), { creatorKind: 'user', creatorId: '9' }, now),
    toUploadRow(item({ id: 3, localId: 'c', status: 'failed', categoryId: 'kat:efek-suara', genreId: 'gen:efek-suara/ui' }), { creatorKind: 'user', creatorId: '9' }, now),
  ];

  it('baris antrean ↔ baris tabel bolak-balik tanpa kehilangan kolom', () => {
    const it = item({ id: 7, localId: 'x', hash: 'h'.repeat(64), status: 'processing', operationId: 'op', assetId: '55' });
    const row = toUploadRow(it, { creatorKind: 'group', creatorId: ' 12 ' }, now);
    expect(row).toMatchObject({ id: 'x', creatorKind: 'group', creatorId: '12', moderationState: 'reviewing', uploadedAt: now, approvedAt: null });
    expect(fromUploadRow(row, 3)).toEqual({ ...it, id: 3, progress: 100 });
  });

  it('mengelompokkan kategori → genre dengan hitungan; kategori kosong tetap tampil', () => {
    const groups = groupCatalog(rows, t);
    expect(groups.map((g) => [g.category?.name, g.count])).toEqual([['Musik', 2], ['Efek suara', 1], ['Suara', 0]]);
    const musik = groups[0]!;
    expect(musik.genres.find((g) => g.genre?.name === 'Lo-fi')?.rows).toHaveLength(1);
    expect(musik.genres.find((g) => g.genre?.name === 'EDM')?.rows).toHaveLength(1);
  });

  it('baris yang taksonominya sudah dihapus masuk kelompok "tanpa kategori", bukan hilang', () => {
    const groups = groupCatalog(rows, { categories: [], genres: [] });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.category).toBeNull();
    expect(groups[0]!.count).toBe(3);
  });

  it('ringkasan hanya menghitung yang disetujui — GAGAL bukan koleksi', () => {
    expect(catalogSummary(rows, t)).toBe('2 Musik · 0 Efek suara · 0 Suara');
  });

  it('penyaring: kategori, genre, dan cari nama/berkas/assetId tanpa peduli huruf', () => {
    const f = { categoryId: null, genreId: null, query: '' };
    expect(filterCatalog(rows, { ...f, categoryId: 'kat:musik' })).toHaveLength(2);
    expect(filterCatalog(rows, { ...f, genreId: 'gen:musik/edm' })).toHaveLength(1);
    expect(filterCatalog(rows, { ...f, query: 'lagu' })).toHaveLength(3);
    expect(filterCatalog(rows, { ...f, query: '2' })).toHaveLength(1);
  });
});
