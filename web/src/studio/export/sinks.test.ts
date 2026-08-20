/**
 * Tes sink export.
 *
 * Yang diuji di sini adalah hal-hal yang KEGAGALANNYA DIAM: header final yang
 * tidak pernah sampai ke disk, byte yang tertukar urutannya, dan berkas separuh
 * jadi yang tertinggal setelah pembatalan. Ketiganya menghasilkan file yang
 * ukurannya masuk akal dan namanya benar — jadi tidak ada yang curiga sampai
 * seseorang memutarnya.
 */
import { describe, expect, it } from 'vitest';

import { BlobSink, FileSystemSink, PostMessageSink, toTransferable } from './sinks';

/** Catatan satu operasi tulis ke `FileSystemWritableFileStream` palsu. */
type Write = { at: number | 'append'; bytes: number[] };

function fakeHandle(): {
  handle: FileSystemFileHandle;
  writes: Write[];
  closed: () => boolean;
  aborted: () => boolean;
} {
  const writes: Write[] = [];
  let closed = false;
  let aborted = false;
  const writable = {
    write(data: Uint8Array | { type: 'write'; position: number; data: Uint8Array }): Promise<void> {
      if (data instanceof Uint8Array) writes.push({ at: 'append', bytes: [...data] });
      else writes.push({ at: data.position, bytes: [...data.data] });
      return Promise.resolve();
    },
    close(): Promise<void> {
      closed = true;
      return Promise.resolve();
    },
    abort(): Promise<void> {
      aborted = true;
      return Promise.resolve();
    },
  };
  return {
    handle: { createWritable: () => Promise.resolve(writable) } as unknown as FileSystemFileHandle,
    writes,
    closed: () => closed,
    aborted: () => aborted,
  };
}

describe('FileSystemSink', () => {
  /**
   * Ini bug yang sesungguhnya ada di `engine-client.ts`: pesan header final
   * ditaruh di `parts[0]` bahkan ketika tujuannya berkas di disk. Di jalur disk
   * `parts` tidak pernah dibaca, jadi berkas yang tertinggal selamanya memakai
   * header placeholder — panjang data 0.
   */
  it('menimpa header di posisi 0, bukan menambahkannya di ujung', async () => {
    const f = fakeHandle();
    const sink = await FileSystemSink.create(f.handle);

    await sink.header(new Uint8Array([1, 1, 1, 1]));
    await sink.chunk(new Uint8Array([9, 9]));
    await sink.patchHeader(new Uint8Array([2, 2, 2, 2]));
    await sink.close();

    expect(f.writes).toEqual([
      { at: 'append', bytes: [1, 1, 1, 1] },
      { at: 'append', bytes: [9, 9] },
      { at: 0, bytes: [2, 2, 2, 2] },
    ]);
    expect(f.closed()).toBe(true);
  });

  /**
   * Header final HARUS sepanjang placeholder. Kalau tidak, menimpanya di posisi
   * 0 akan menggeser seluruh data audio — dan hasilnya file yang ukurannya
   * benar tapi isinya bergeser beberapa byte, yaitu derau.
   */
  it('menolak header final yang panjangnya berbeda dari placeholder', async () => {
    const f = fakeHandle();
    const sink = await FileSystemSink.create(f.handle);
    await sink.header(new Uint8Array(44));
    await expect(sink.patchHeader(new Uint8Array(40))).rejects.toThrow(/menggeser seluruh data/);
  });

  it('abort membuang berkas, tidak menutupnya sebagai sukses', async () => {
    const f = fakeHandle();
    const sink = await FileSystemSink.create(f.handle);
    await sink.header(new Uint8Array([1]));
    await sink.abort('dibatalkan');
    expect(f.aborted()).toBe(true);
    expect(f.closed()).toBe(false);
  });

  /**
   * `abort()` dipanggil DARI jalur penanganan error. Kalau ia melempar
   * sendiri, ia akan menutupi alasan sebenarnya export berhenti.
   */
  it('abort tidak melempar walau writable-nya gagal', async () => {
    const writable = {
      write: () => Promise.resolve(),
      close: () => Promise.reject(new Error('disk penuh')),
      abort: () => Promise.reject(new Error('sudah tertutup')),
    };
    const handle = {
      createWritable: () => Promise.resolve(writable),
    } as unknown as FileSystemFileHandle;
    const sink = await FileSystemSink.create(handle);
    await expect(sink.abort()).resolves.toBeUndefined();
  });
});

describe('BlobSink', () => {
  it('menyusun header + chunk + header final dengan urutan yang benar', () => {
    const sink = new BlobSink();
    sink.header(new Uint8Array([0, 0]));
    sink.chunk(new Uint8Array([7]));
    sink.chunk(new Uint8Array([8]));
    sink.patchHeader(new Uint8Array([1, 2]));
    sink.close();
    expect([...sink.bytes()]).toEqual([1, 2, 7, 8]);
  });

  it('menaruh header final di depan walau tidak ada placeholder', () => {
    const sink = new BlobSink();
    sink.chunk(new Uint8Array([7]));
    sink.patchHeader(new Uint8Array([1]));
    expect([...sink.bytes()]).toEqual([1, 7]);
  });

  /** Export yang dibatalkan tidak boleh bisa diambil sebagai berkas. */
  it('setelah abort, blob() menolak alih-alih menyerahkan file separuh', () => {
    const sink = new BlobSink();
    sink.header(new Uint8Array([0, 0]));
    sink.chunk(new Uint8Array([7]));
    sink.abort();
    expect(() => sink.blob('audio/wav')).toThrow(/dibatalkan/);
    expect([...sink.bytes()]).toEqual([]);
  });
});

describe('PostMessageSink', () => {
  it('mengirim tiap chunk sebagai transferable dan tidak menahan apa pun', () => {
    const posts: Array<{ type: string; bytes: number[]; transferred: boolean }> = [];
    const sink = new PostMessageSink((msg, transfer) => {
      posts.push({
        type: msg.type,
        bytes: [...new Uint8Array(msg.buffer)],
        transferred: transfer[0] === msg.buffer,
      });
    });

    sink.header(new Uint8Array([1, 1]));
    sink.chunk(new Uint8Array([5, 6]));
    sink.patchHeader(new Uint8Array([2, 2]));

    expect(posts.map((p) => p.type)).toEqual(['header', 'chunk', 'patch-header']);
    expect(posts.map((p) => p.bytes)).toEqual([
      [1, 1],
      [5, 6],
      [2, 2],
    ]);
    // Buffer-nya IKUT dalam daftar transfer — kalau tidak, structured clone
    // menyalinnya dan worker menyimpan salinan kedua dari seluruh file.
    expect(posts.every((p) => p.transferred)).toBe(true);
  });

  it('tidak mengirim pesan untuk chunk kosong', () => {
    let count = 0;
    const sink = new PostMessageSink(() => {
      count++;
    });
    sink.chunk(new Uint8Array(0));
    expect(count).toBe(0);
  });
});

describe('toTransferable', () => {
  it('menyerahkan buffer apa adanya kalau view-nya menutupi seluruh buffer', () => {
    const a = new Uint8Array([1, 2, 3]);
    expect(toTransferable(a)).toBe(a.buffer);
  });

  /**
   * View sebagian TIDAK boleh menyerahkan buffer induknya: yang ikut terkirim
   * bukan cuma chunk ini, dan mentransfernya melumpuhkan view lain yang masih
   * menunjuk buffer yang sama.
   */
  it('menyalin dulu kalau view-nya hanya sebagian dari buffer', () => {
    const parent = new Uint8Array([1, 2, 3, 4]);
    const part = parent.subarray(1, 3);
    const out = toTransferable(part);
    expect(out).not.toBe(parent.buffer);
    expect([...new Uint8Array(out)]).toEqual([2, 3]);
  });
});
