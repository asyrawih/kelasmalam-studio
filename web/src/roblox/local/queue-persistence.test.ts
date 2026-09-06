/**
 * Adapter desktop dengan `invoke` di-mock — tidak ada Tauri di vitest.
 *
 * Yang dijaga adalah KONTRAK dengan sisi Rust (`platform/local-commands.ts`):
 * restore membaca TABEL (`roblox_queue_list` + taksonomi + katalog + target),
 * byte draft tidak pernah lewat TS (drop → kepustakaan → `hash` → `put`),
 * `put` hanya untuk baris yang berubah, coalescing store tetap berlaku, dan
 * BERSIHKAN SELESAI tidak menghapus baris `done` dari tabel.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RobloxTaxonomy, RobloxTargetSettings, RobloxUploadRow } from '../../platform/local-commands';
import { setPlatformHostForTests } from '../../platform';
import { createDesktopHost } from '../../platform/desktop';
import { createWebHost } from '../../platform/web';
import { createLocalQueuePersistence } from './queue-persistence';
import { fileOf, restoreRobloxQueue, robloxActions, robloxStore } from '../store';

const invoke = vi.fn(async (_cmd: string, _args?: unknown, _opts?: unknown): Promise<unknown> => null);
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown, opts?: unknown) => invoke(cmd, args, opts),
  isTauri: () => true,
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async () => () => {},
}));

const HASH = 'a'.repeat(64);
const taxonomy: RobloxTaxonomy = {
  categories: [{ id: 'c1', name: 'Musik', sort: 0 }],
  genres: [{ id: 'g1', categoryId: 'c1', name: 'Lo-fi', sort: 0 }],
};
const target: RobloxTargetSettings = { creatorKind: 'group', creatorId: '42', genreToDescription: false };
const row = (over: Partial<RobloxUploadRow> = {}): RobloxUploadRow => ({
  id: 'row-1', hash: HASH, fileName: 'lagu.mp3', bytes: 3, seconds: 60, name: 'LAGU', description: '',
  categoryId: 'c1', genreId: 'g1', creatorKind: 'group', creatorId: '42', status: 'draft', operationId: null,
  assetId: null, moderationState: null, error: null, createdAt: 1, updatedAt: 1, uploadedAt: null, approvedAt: null,
  ...over,
});

/** Tabel palsu di sisi "Rust": cukup untuk melihat apa yang TS kirim. */
function installTable(rows: readonly RobloxUploadRow[], catalog: readonly RobloxUploadRow[] = []): void {
  invoke.mockImplementation(async (cmd, args) => {
    switch (cmd) {
      case 'roblox_queue_list': return rows;
      case 'roblox_taxonomy_list': return taxonomy;
      case 'roblox_catalog_list': return catalog;
      case 'roblox_target_get': return target;
      case 'library_blob': return new Uint8Array([1, 2, 3]).buffer;
      case 'library_has': return false;
      case 'roblox_queue_put': return { ...(args as { row: RobloxUploadRow }).row, createdAt: 1, updatedAt: 1 };
      case 'roblox_genre_upsert': return { id: 'g-baru', ...(args as object) };
      default: return null;
    }
  });
}

const calls = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd);
const state = () => robloxStore.getState();
const mp3 = (name = 'lagu.mp3'): File => new File([new Uint8Array([9, 9, 9])], name, { type: 'audio/mpeg' });

beforeEach(() => {
  invoke.mockReset();
  installTable([]);
  setPlatformHostForTests(createDesktopHost());
  robloxActions.__resetForTest();
});
afterEach(() => setPlatformHostForTests(null));

describe('restore dari tabel', () => {
  it('memuat antrean, taksonomi, katalog, dan target dari empat command — bukan IndexedDB', async () => {
    installTable(
      [row(), row({ id: 'row-2', status: 'processing', operationId: 'op-2', assetId: '77' })],
      [row({ id: 'row-9', status: 'done', assetId: '99' })],
    );
    await restoreRobloxQueue();

    expect(state().items.map((it) => it.localId)).toEqual(['row-1', 'row-2']);
    expect(state().items[1]).toMatchObject({ status: 'processing', operationId: 'op-2', assetId: '77', hash: HASH });
    expect(state().taxonomy).toEqual(taxonomy);
    expect(state().catalog.map((r) => r.id)).toEqual(['row-9']);
    expect(state().target).toMatchObject({ creatorKind: 'group', creatorId: '42', genreToDescription: false });
  });

  it('byte diambil dari kepustakaan hanya untuk baris yang masih akan dikirim', async () => {
    installTable([row(), row({ id: 'row-2', status: 'processing', operationId: 'op-2' })]);
    await restoreRobloxQueue();

    expect(calls('library_blob')).toHaveLength(1);
    expect(calls('library_blob')[0]![1]).toEqual({ hash: HASH });
    const draft = state().items[0]!;
    expect(fileOf(draft.id)?.name).toBe('lagu.mp3');
    expect(fileOf(state().items[1]!.id)).toBeUndefined();
  });

  it('adapter dipilih dari platform host: di web tidak ada satu pun invoke', async () => {
    setPlatformHostForTests(createWebHost());
    robloxActions.__resetForTest();
    await restoreRobloxQueue();
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('drop berkas → kepustakaan → tabel', () => {
  it('berkas masuk kepustakaan dulu (put_bytes + commit), lalu barisnya di-put dengan hash', async () => {
    robloxActions.addFiles([mp3()]);
    const it = state().items[0]!;
    expect(it.hash).toBeNull();

    await vi.waitFor(() => expect(state().items[0]!.hash).not.toBeNull());
    const putBytes = calls('library_put_bytes')[0]!;
    expect(putBytes[1]).toBeInstanceOf(Uint8Array);
    expect(putBytes[2]).toEqual({ headers: { 'x-hash': state().items[0]!.hash, 'x-ext': 'mp3' } });
    expect(calls('library_commit')[0]![1]).toMatchObject({ hash: state().items[0]!.hash, name: 'lagu.mp3', bytes: 3, mime: 'audio/mpeg' });

    await vi.waitFor(() => expect(calls('roblox_queue_put').length).toBeGreaterThan(0));
    const put = calls('roblox_queue_put').at(-1)![1] as { row: RobloxUploadRow };
    expect(put.row).toMatchObject({ id: it.localId, hash: state().items[0]!.hash, status: 'draft', fileName: 'lagu.mp3' });
    expect(put.row).not.toHaveProperty('createdAt');
  });

  it('berkas yang sudah ada di kepustakaan tidak dikirim ulang byte-nya', async () => {
    invoke.mockImplementation(async (cmd) => (cmd === 'library_has' ? true : cmd === 'roblox_queue_put' ? row() : null));
    robloxActions.addFiles([mp3()]);
    await vi.waitFor(() => expect(state().items[0]!.hash).not.toBeNull());
    expect(calls('library_put_bytes')).toHaveLength(0);
    expect(calls('library_commit')).toHaveLength(0);
  });

  it('kegagalan masuk kepustakaan mendarat di barisnya sebagai GAGAL dengan alasannya', async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === 'library_has') throw { code: 'DISK_FULL', message: 'disk penuh' };
      return null;
    });
    robloxActions.addFiles([mp3()]);
    await vi.waitFor(() => expect(state().items[0]!.status).toBe('failed'));
    expect(state().items[0]!.error).toMatch(/disk penuh/);
  });
});

describe('put saat berubah, dengan coalescing', () => {
  it('menulis ulang hanya baris yang berubah; perubahan pilihan baris tidak menulis apa pun', async () => {
    installTable([row(), row({ id: 'row-2', name: 'DUA' })]);
    await restoreRobloxQueue();
    const [a, b] = state().items;

    robloxActions.select(b!.id);
    robloxActions.setName(a!.id, 'BARU');
    await vi.waitFor(() => expect(calls('roblox_queue_put')).toHaveLength(1));
    expect((calls('roblox_queue_put')[0]![1] as { row: RobloxUploadRow }).row).toMatchObject({ id: 'row-1', name: 'BARU' });
  });

  it('seratus laporan progres tidak menjadi seratus put — hanya snapshot terbaru', async () => {
    installTable([row()]);
    await restoreRobloxQueue();
    const id = state().items[0]!.id;
    robloxActions.markUploading(id);
    for (let pct = 1; pct <= 100; pct++) robloxActions.markProgress(id, pct);
    await robloxActions.markProcessing(id, 'op-1', '55');

    expect(calls('roblox_queue_put').length).toBeLessThan(10);
    const last = (calls('roblox_queue_put').at(-1)![1] as { row: RobloxUploadRow }).row;
    expect(last).toMatchObject({ status: 'processing', operationId: 'op-1', assetId: '55' });
  });

  it('target yang berubah ditulis lewat roblox_target_set', async () => {
    installTable([]);
    await restoreRobloxQueue();
    robloxActions.setCreatorId('777');
    await vi.waitFor(() => expect(calls('roblox_target_set')).toHaveLength(1));
    expect(calls('roblox_target_set')[0]![1]).toEqual({ creatorKind: 'group', creatorId: '777', genreToDescription: false });
  });
});

describe('hapus vs bersihkan', () => {
  it('HAPUS memanggil roblox_queue_remove; BERSIHKAN SELESAI tidak — baris done adalah katalog', async () => {
    installTable([row(), row({ id: 'row-2' })]);
    await restoreRobloxQueue();
    const [a, b] = state().items;

    await robloxActions.markDone(a!.id, '1');
    robloxActions.clearDone();
    await vi.waitFor(() => expect(calls('roblox_catalog_list').length).toBeGreaterThan(1));
    expect(calls('roblox_queue_remove')).toHaveLength(0);

    robloxActions.remove(b!.id);
    await vi.waitFor(() => expect(calls('roblox_queue_remove')).toHaveLength(1));
    expect(calls('roblox_queue_remove')[0]![1]).toEqual({ id: 'row-2' });
  });

  it('NOT_FOUND saat hapus diabaikan — baris yang belum sampai tabel tidak punya apa-apa untuk dihapus', async () => {
    const adapter = createLocalQueuePersistence();
    invoke.mockImplementation(async () => { throw { code: 'NOT_FOUND', message: 'tidak ada' }; });
    await expect(adapter.remove(['x'])).resolves.toBeUndefined();
    invoke.mockImplementation(async () => { throw { code: 'IO', message: 'disk' }; });
    await expect(adapter.remove(['x'])).rejects.toMatchObject({ code: 'IO' });
  });
});

describe('taksonomi lewat command', () => {
  it('upsert/delete diteruskan apa adanya; IN_USE dari Rust menjadi pesan untuk user', async () => {
    installTable([]);
    await restoreRobloxQueue();
    const r = await robloxActions.addGenre('c1', 'Phonk');
    expect(r).toEqual({ ok: true, id: 'g-baru' });
    expect(calls('roblox_genre_upsert')[0]![1]).toEqual({ categoryId: 'c1', name: 'Phonk', sort: 1 });

    invoke.mockImplementation(async (cmd) => {
      if (cmd === 'roblox_genre_delete') throw { code: 'IN_USE', message: 'genre masih dipakai 3 lagu', count: 3 };
      return null;
    });
    expect(await robloxActions.deleteGenre('g1')).toEqual({ ok: false, message: 'genre masih dipakai 3 lagu' });
    expect(state().taxonomy.genres.some((g) => g.id === 'g1')).toBe(true);
  });
});
