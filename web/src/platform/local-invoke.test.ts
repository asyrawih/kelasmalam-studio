/**
 * Pembungkus `invoke` bertipe (docs/21 §2a).
 *
 * Yang dijaga: SETIAP nama di `LOCAL_COMMAND_NAMES` bisa lewat pembungkus ini
 * (kontrak dan pembungkusnya tidak boleh melenceng diam-diam), penolakan Rust
 * keluar sebagai satu bentuk yang bisa dikenali, dan dua jalur biner memakai
 * bentuk IPC yang disepakati — `ArrayBuffer` keluar, badan mentah + header
 * masuk — bukan JSON array angka.
 */

import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

const invoke = vi.fn(async (_cmd: string, _args?: unknown, _opts?: unknown): Promise<unknown> => null);
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown, opts?: unknown) => invoke(cmd, args, opts),
  isTauri: () => true,
}));

import { LOCAL_COMMAND_NAMES, type LocalCommands, type LocalTrack } from './local-commands';
import {
  callLocal,
  isLocalError,
  LocalCommandError,
  putLocalBytes,
  toArrayBuffer,
  toLocalError,
  type JsonLocalCommandName,
} from './local-invoke';

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(null);
});

describe('bentuk: setiap command di kontrak bisa dipanggil', () => {
  it('semua nama di LOCAL_COMMAND_NAMES lewat callLocal, kecuali unggah biner lewat putLocalBytes', async () => {
    // `library_blob` menormalkan jawabannya; ArrayBuffer kosong sah untuk semua.
    invoke.mockResolvedValue(new ArrayBuffer(0));
    for (const name of LOCAL_COMMAND_NAMES) {
      if (name === 'library_put_bytes') {
        await putLocalBytes('h', 'mp3', new Uint8Array(2));
      } else {
        // Argumen kosong cukup untuk tes bentuk: yang diuji adalah bahwa nama
        // itu diterima pembungkus dan diteruskan apa adanya ke `invoke`.
        await callLocal(name as JsonLocalCommandName, {} as never);
      }
      expect(invoke).toHaveBeenLastCalledWith(name, expect.anything(), ...(name === 'library_put_bytes' ? [expect.anything()] : [undefined]));
    }
    expect(invoke).toHaveBeenCalledTimes(LOCAL_COMMAND_NAMES.length);
  });

  it('tipe hasil mengikuti kontrak', () => {
    // Murni tipe — TIDAK ada panggilan runtime: `expectTypeOf(callLocal(...))`
    // akan benar-benar memanggil `invoke` yang di-mock, dan `library_blob`
    // yang dijawab `null` melempar tanpa ada yang menunggu.
    type Hasil<K extends JsonLocalCommandName> = Awaited<ReturnType<typeof callLocal<K>>>;
    expectTypeOf<Hasil<'library_tracks'>>().toEqualTypeOf<readonly LocalTrack[]>();
    expectTypeOf<Hasil<'library_has'>>().toEqualTypeOf<boolean>();
    expectTypeOf<Hasil<'library_blob'>>().toEqualTypeOf<ArrayBuffer>();
    expectTypeOf<Hasil<'library_project_update'>>().toEqualTypeOf<number>();
    expectTypeOf<Parameters<typeof callLocal<'library_has'>>[1]>().toEqualTypeOf<{ hash: string }>();
    // Unggah biner TIDAK punya jalur JSON — tipenya menolak, bukan hanya runtime-nya.
    expectTypeOf<JsonLocalCommandName>().not.toEqualTypeOf<keyof LocalCommands>();
    const hanyaDikompilasi = (): void => {
      // @ts-expect-error library_put_bytes hanya lewat putLocalBytes
      void callLocal('library_put_bytes', { hash: 'h', ext: 'mp3' });
      // @ts-expect-error nama yang tidak ada di kontrak
      void callLocal('library_traks', {});
      // @ts-expect-error argumen yang salah bentuk
      void callLocal('library_has', { id: 'h' });
    };
    expect(typeof hanyaDikompilasi).toBe('function');
  });

  it('argumen diteruskan sebagai satu objek camelCase — Tauri yang mengubahnya ke snake_case', async () => {
    await callLocal('library_project_update', { id: 'p', name: 'n', json: { a: 1 }, expectedVersion: 3 });
    expect(invoke).toHaveBeenCalledWith(
      'library_project_update',
      { id: 'p', name: 'n', json: { a: 1 }, expectedVersion: 3 },
      undefined,
    );
  });
});

describe('galat', () => {
  it('LocalError dari Rust → LocalCommandError yang MEMENUHI LocalError, dengan field tambahannya', async () => {
    invoke.mockRejectedValue({ code: 'VERSION_CONFLICT', message: 'versi basi', currentVersion: 4 });
    const err = await callLocal('library_project_update', { id: 'p', name: 'n', json: {}, expectedVersion: 1 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LocalCommandError);
    expect(err).toBeInstanceOf(Error);
    expect(isLocalError(err)).toBe(true);
    expect(err).toMatchObject({ code: 'VERSION_CONFLICT', message: 'versi basi', currentVersion: 4 });
  });

  it('IN_USE membawa count; HTTP membawa status', () => {
    expect(toLocalError({ code: 'IN_USE', message: 'dipakai project Mix A', count: 1 })).toMatchObject({ count: 1 });
    expect(toLocalError({ code: 'HTTP', message: 'Open Cloud 429', status: 429 })).toMatchObject({ status: 429 });
  });

  it('penolakan yang bukan LocalError (string, Error, kode asing) dibungkus sebagai IO dengan pesannya', async () => {
    invoke.mockRejectedValueOnce({ code: 'KODE_ASING', message: 'tetap terbaca' });
    await expect(callLocal('store_info', {})).rejects.toMatchObject({ code: 'IO', message: 'tetap terbaca' });
    invoke.mockRejectedValueOnce('command belum ada');
    await expect(callLocal('store_info', {})).rejects.toMatchObject({ code: 'IO', message: 'command belum ada' });
    invoke.mockRejectedValueOnce(new Error('plugin rusak'));
    await expect(callLocal('store_info', {})).rejects.toMatchObject({ code: 'IO', message: 'plugin rusak' });
    invoke.mockRejectedValueOnce(undefined);
    await expect(callLocal('store_info', {})).rejects.toMatchObject({ code: 'IO' });
  });

  it('isLocalError menolak kode yang tidak ada di kontrak dan bentuk yang salah', () => {
    expect(isLocalError({ code: 'APA_INI', message: 'x' })).toBe(false);
    expect(isLocalError({ code: 'IO' })).toBe(false);
    expect(isLocalError('IO')).toBe(false);
    expect(isLocalError(null)).toBe(false);
    expect(isLocalError({ code: 'IO', message: 'x' })).toBe(true);
  });

  it('putLocalBytes juga menerjemahkan penolakannya', async () => {
    invoke.mockRejectedValueOnce({ code: 'DISK_FULL', message: 'disk sisa 2 MB' });
    await expect(putLocalBytes('h', 'wav', new ArrayBuffer(4))).rejects.toMatchObject({ code: 'DISK_FULL' });
  });
});

describe('jalur biner', () => {
  it('library_blob: ArrayBuffer apa adanya; Uint8Array dan number[] dinormalkan', async () => {
    const buf = new ArrayBuffer(3);
    invoke.mockResolvedValueOnce(buf);
    expect(await callLocal('library_blob', { hash: 'h' })).toBe(buf);

    invoke.mockResolvedValueOnce(new Uint8Array([1, 2, 3]));
    const fromView = await callLocal('library_blob', { hash: 'h' });
    expect(fromView).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(fromView)]).toEqual([1, 2, 3]);

    invoke.mockResolvedValueOnce([9, 8]);
    expect([...new Uint8Array(await callLocal('library_blob', { hash: 'h' }))]).toEqual([9, 8]);
  });

  it('view yang tidak menutupi seluruh buffer disalin — pemanggil menerima persis byte-nya', () => {
    const backing = new Uint8Array([0, 1, 2, 3, 4]);
    const out = toArrayBuffer(backing.subarray(1, 3));
    expect([...new Uint8Array(out)]).toEqual([1, 2]);
    expect(() => toArrayBuffer('bukan byte')).toThrow(LocalCommandError);
  });

  it('library_put_bytes: badan mentah Uint8Array + header x-hash/x-ext, TANPA argumen JSON', async () => {
    const bytes = new ArrayBuffer(5);
    await putLocalBytes('a'.repeat(64), 'flac', bytes);
    const [cmd, body, opts] = invoke.mock.calls[0]!;
    expect(cmd).toBe('library_put_bytes');
    expect(body).toBeInstanceOf(Uint8Array);
    expect((body as Uint8Array).byteLength).toBe(5);
    expect(opts).toEqual({ headers: { 'x-hash': 'a'.repeat(64), 'x-ext': 'flac' } });
  });
});
