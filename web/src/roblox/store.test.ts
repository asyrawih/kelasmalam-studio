/**
 * Store antrean.
 *
 * Yang diuji di sini adalah janji-janji yang dipegang lapisan unggah nanti:
 * berkas non-audio ditolak di pintu dan dilaporkan namanya, byte bisa diambil
 * lewat `fileOf` dan hilang saat barisnya dihapus, dan baris yang tidak
 * disentuh mengembalikan objek YANG SAMA (dasar dari `memo` di `QueueRow`).
 */

import { beforeEach, describe, expect, it } from 'vitest';

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
  it('berjalan dari antre sampai selesai, dan menyimpan asset id-nya', () => {
    robloxActions.addFiles([mp3('a.mp3')]);
    const id = state().items[0]!.id;

    robloxActions.markQueued([id]);
    expect(state().items[0]!.status).toBe('queued');

    robloxActions.markUploading(id);
    robloxActions.markProgress(id, 42);
    expect(state().items[0]!).toMatchObject({ status: 'uploading', progress: 42 });

    robloxActions.markProcessing(id);
    expect(state().items[0]!).toMatchObject({ status: 'processing', progress: 100 });

    robloxActions.markDone(id, '9876');
    expect(state().items[0]!).toMatchObject({ status: 'done', assetId: '9876' });
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
  it('BERSIHKAN SELESAI hanya membuang yang selesai — yang gagal sengaja ditinggal', () => {
    robloxActions.addFiles([mp3('a.mp3'), mp3('b.mp3'), mp3('c.mp3')]);
    const a = state().items[0]!;
    const b = state().items[1]!;
    robloxActions.markDone(a.id, '1');
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
