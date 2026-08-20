/**
 * Aturan Roblox, diuji tanpa React.
 *
 * Yang dijaga di sini bukan "fungsinya jalan" melainkan tiga keputusan yang
 * mudah sekali dibalik oleh orang berikutnya tanpa sadar merusaknya:
 * durasi `null` LOLOS, pelanggaran dikembalikan SEMUA, dan berkas berformat
 * salah tidak pernah masuk antrean.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_BYTES,
  MAX_NAME_LEN,
  MAX_SECONDS,
  baseNameOf,
  createInitialRoblox,
  extOf,
  formatBytes,
  formatDuration,
  isAudioFile,
  isUploadable,
  readyItems,
  targetProblems,
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

  it('durasi yang BELUM terukur lolos — null bukan pelanggaran', () => {
    expect(codes(item({ seconds: null }))).toEqual([]);
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
    const base = { creatorKind: 'user', apiKey: 'kunci' } as const;
    expect(targetProblems({ ...base, creatorId: 'abc' })).toEqual(['ID pemilik harus angka']);
    expect(targetProblems({ ...base, creatorId: '  ' })).toEqual(['ID pemilik belum diisi']);
    expect(targetProblems({ ...base, creatorId: '123' })).toEqual([]);
  });

  it('API key berisi spasi saja tetap dianggap kosong', () => {
    expect(targetProblems({ creatorKind: 'user', creatorId: '1', apiKey: ' ' })).toEqual([
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
