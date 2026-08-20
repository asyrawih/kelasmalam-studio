/**
 * Jalur unggah kepustakaan (L3).
 *
 * Yang dijaga adalah janji yang membuat seluruh rancangan ini sepadan: **berkas
 * yang sudah ada di R2 tidak pernah diunggah ulang, oleh siapa pun.** Sisanya —
 * commit yang tetap jalan di kedua cabang, antrean yang berurutan, kegagalan
 * yang berhenti di satu lagu — adalah yang menjaga janji itu tidak berubah jadi
 * kepustakaan yang bolong.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createUploadQueue, uploadImported } from './upload';
import type { InitResult, LibraryApi, TrackMeta } from './api';
import { LibraryError } from './api';
import { libraryActions, libraryStore } from './store';
import type { ImportedForLibrary } from '../studio/timeline/import-sink';

const HASH = 'a'.repeat(64);

const imported = (over: Partial<ImportedForLibrary> = {}): ImportedForLibrary => ({
  contentHash: HASH,
  assetId: 1,
  name: 'Kelas Malam',
  bytes: new ArrayBuffer(2048),
  format: 'MP3',
  frames: 48_000 * 90,
  sampleRate: 48_000,
  ...over,
});

function fakeApi(over: Partial<LibraryApi> = {}): LibraryApi {
  return {
    base: 'https://api.test',
    me: async () => ({ id: 'u1', email: 'a@test', name: 'Ana' }),
    tracks: async () => [],
    blob: async () => new ArrayBuffer(8),
    initTrack: async (): Promise<InitResult> => ({
      exists: false,
      uploadUrl: 'https://r2.test/put',
    }),
    putUpload: async () => {},
    commitTrack: async () => {},
    logout: async () => {},
    loginUrl: () => 'https://api.test/auth/google',
    ...over,
  };
}

const uploads = () => libraryStore.getState().uploads;

beforeEach(() => libraryActions.__resetForTest());

describe('dedup', () => {
  it('exists:true → TIDAK ada satu byte pun yang naik', async () => {
    const putUpload = vi.fn(async () => {});
    const commitTrack = vi.fn(async () => {});
    const api = fakeApi({
      initTrack: async () => ({ exists: true, uploadUrl: null }),
      putUpload,
      commitTrack,
    });

    const out = await uploadImported(api, imported());

    expect(out).toEqual({ ok: true, skipped: false, deduped: true });
    expect(putUpload).not.toHaveBeenCalled();
    // Commit TETAP jalan: `exists` berarti byte-nya ada, bukan bahwa user ini
    // sudah memilikinya. Yang membuat lagu masuk kepustakaan adalah barisnya.
    expect(commitTrack).toHaveBeenCalledTimes(1);
  });

  it('exists:false → unggah lalu commit, urut', async () => {
    const urutan: string[] = [];
    const api = fakeApi({
      initTrack: async () => {
        urutan.push('init');
        return { exists: false, uploadUrl: 'https://r2.test/put' };
      },
      putUpload: async () => {
        urutan.push('put');
      },
      commitTrack: async () => {
        urutan.push('commit');
      },
    });

    const out = await uploadImported(api, imported());
    expect(out).toEqual({ ok: true, skipped: false, deduped: false });
    expect(urutan).toEqual(['init', 'put', 'commit']);
  });

  it('metadata yang dikirim init dan commit menyebut hash dan ukuran yang sama', async () => {
    const seen: TrackMeta[] = [];
    const api = fakeApi({
      initTrack: async (meta) => {
        seen.push(meta);
        return { exists: true, uploadUrl: null };
      },
      commitTrack: async (meta) => {
        seen.push(meta);
      },
    });

    await uploadImported(api, imported({ bytes: new ArrayBuffer(4096) }));
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ hash: HASH, bytes: 4096, mime: 'audio/mpeg' });
    expect(seen[1]).toMatchObject({ hash: HASH, bytes: 4096, frames: 48_000 * 90 });
  });
});

describe('yang sengaja TIDAK diunggah', () => {
  it('hasil bake (tanpa berkas asal) dilewati, bukan digagalkan', async () => {
    const initTrack = vi.fn();
    const api = fakeApi({ initTrack: initTrack as unknown as LibraryApi['initTrack'] });

    const out = await uploadImported(api, imported({ contentHash: '' }));
    expect(out).toMatchObject({ ok: true, skipped: true });
    expect(initTrack).not.toHaveBeenCalled();
  });

  it('format yang tidak didukung server dilewati dengan alasannya', async () => {
    const out = await uploadImported(fakeApi(), imported({ format: 'WebM/Matroska' }));
    expect(out).toMatchObject({ ok: true, skipped: true });
    expect((out as { reason: string }).reason).toContain('WebM');
  });

  it('MP3, Ogg, WAV, dan FLAC semuanya punya MIME', async () => {
    for (const [format, mime] of [
      ['MP3', 'audio/mpeg'],
      ['Ogg', 'audio/ogg'],
      ['WAV', 'audio/wav'],
      ['FLAC', 'audio/flac'],
    ] as const) {
      const seen: TrackMeta[] = [];
      const api = fakeApi({
        initTrack: async (meta) => {
          seen.push(meta);
          return { exists: true, uploadUrl: null };
        },
      });
      await uploadImported(api, imported({ format }));
      expect([format, seen[0]?.mime]).toEqual([format, mime]);
    }
  });
});

describe('kegagalan', () => {
  it('pesan server dipajang apa adanya, dan barisnya BERTAHAN', async () => {
    const api = fakeApi({
      initTrack: async () => {
        throw new LibraryError('KUOTA', 'kepustakaan kamu sudah penuh');
      },
    });

    const out = await uploadImported(api, imported());
    expect(out).toEqual({ ok: false, message: 'kepustakaan kamu sudah penuh' });
    // Kegagalan yang menghilang sendiri sama saja tidak pernah dilaporkan.
    expect(uploads()[HASH]).toMatchObject({ phase: 'gagal', error: 'kepustakaan kamu sudah penuh' });
  });

  it('init yang menjawab tanpa uploadUrl dihitung gagal, bukan sukses diam', async () => {
    const api = fakeApi({ initTrack: async () => ({ exists: false, uploadUrl: null }) });
    const out = await uploadImported(api, imported());
    expect(out).toMatchObject({ ok: false });
  });

  it('yang berhasil TIDAK meninggalkan baris — buktinya ada di daftar kepustakaan', async () => {
    await uploadImported(fakeApi(), imported());
    expect(uploads()).toEqual({});
  });
});

describe('antrean', () => {
  it('mengunggah satu per satu, bukan serempak', async () => {
    let inFlight = 0;
    let peak = 0;
    const api = fakeApi({
      putUpload: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight -= 1;
      },
    });

    const queue = createUploadQueue(api);
    for (let i = 0; i < 3; i += 1) {
      queue.push(imported({ contentHash: String(i).repeat(64).slice(0, 64) }));
    }
    await queue.idle();
    expect(peak).toBe(1);
  });

  it('satu yang gagal tidak menghentikan sisanya', async () => {
    const dikirim: string[] = [];
    const api = fakeApi({
      initTrack: async (meta) => {
        if (meta.hash.startsWith('b')) throw new LibraryError('X', 'gagal');
        dikirim.push(meta.hash);
        return { exists: true, uploadUrl: null };
      },
    });

    const queue = createUploadQueue(api);
    queue.push(imported({ contentHash: 'a'.repeat(64) }));
    queue.push(imported({ contentHash: 'b'.repeat(64) }));
    queue.push(imported({ contentHash: 'c'.repeat(64) }));
    await queue.idle();

    expect(dikirim).toEqual(['a'.repeat(64), 'c'.repeat(64)]);
  });

  it('lagu yang BARU SAJA diunduh dari kepustakaan tidak dikirim balik ke sana', async () => {
    const initTrack = vi.fn();
    const api = fakeApi({ initTrack: initTrack as unknown as LibraryApi['initTrack'] });
    libraryActions.markLoaded(HASH, 7);

    const queue = createUploadQueue(api);
    queue.push(imported());
    await queue.idle();

    expect(initTrack).not.toHaveBeenCalled();
  });
});
