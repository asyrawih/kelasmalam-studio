/**
 * Adapter web = perilaku lama, dipindah. Yang dijaga di sini adalah kontrak
 * yang dulu implisit di `encoders/index.ts` dan `LibraryDock`: tanpa File
 * System Access jatuh ke Blob+anchor, picker yang dibatalkan juga; login
 * adalah NAVIGASI; tidak ada header sesi tambahan.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebHost, ObjectUrlRegistry } from './web';

const g = globalThis as unknown as Record<string, unknown>;

beforeEach(() => {
  delete g['showSaveFilePicker'];
  g['URL'] = Object.assign(URL, {
    createObjectURL: vi.fn(() => 'blob:fake'),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  delete g['showSaveFilePicker'];
  ObjectUrlRegistry.revokeAll();
  vi.restoreAllMocks();
});

describe('pickSaveTarget', () => {
  it('tanpa showSaveFilePicker → blob, dan deliver mengunduh lewat anchor', async () => {
    const host = createWebHost();
    const target = await host.pickSaveTarget('mix.wav', 'audio/wav', 'wav');
    expect(target.kind).toBe('blob');
    if (target.kind !== 'blob') return;

    const clicked: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.download);
    });
    target.deliver(new Blob([new Uint8Array(4)], { type: 'audio/wav' }));
    expect(clicked).toEqual(['mix.wav']);
    click.mockRestore();
  });

  it('picker yang dibatalkan (AbortError) → blob, bukan gagal', async () => {
    g['showSaveFilePicker'] = vi.fn(async () => {
      throw new DOMException('batal', 'AbortError');
    });
    const target = await createWebHost().pickSaveTarget('mix.wav', 'audio/wav', 'wav');
    expect(target.kind).toBe('blob');
  });

  it('picker memberi handle → stream yang menulis ke writable-nya', async () => {
    const writes: unknown[] = [];
    const writable = {
      write: vi.fn(async (d: unknown) => {
        writes.push(d);
      }),
      close: vi.fn(async () => {}),
    };
    const picker = vi.fn(async (_o: unknown) => ({ createWritable: async () => writable }));
    g['showSaveFilePicker'] = picker;

    const target = await createWebHost().pickSaveTarget('mix.wav', 'audio/wav', 'wav');
    expect(target.kind).toBe('stream');
    if (target.kind !== 'stream') return;
    // Nama & tipe diteruskan ke picker — satu nama untuk dua jalur simpan.
    expect(picker.mock.calls[0]?.[0]).toEqual({
      suggestedName: 'mix.wav',
      types: [{ description: 'Audio', accept: { 'audio/wav': ['.wav'] } }],
    });
    await target.sink.header(new Uint8Array(44));
    await target.sink.chunk(new Uint8Array([1, 2, 3]));
    await target.sink.patchHeader(new Uint8Array(44));
    await target.sink.close();
    expect(writes).toHaveLength(3);
    expect(writable.close).toHaveBeenCalledOnce();
  });
});

describe('login / openExternal / authHeaders', () => {
  it('login adalah navigasi ke /auth/google?next=…, dan promise-nya tidak selesai', async () => {
    const original = window.location;
    const fake = { ...original, href: 'http://app.test/studio', pathname: '/studio' };
    Object.defineProperty(window, 'location', { value: fake, writable: true, configurable: true });
    try {
      const host = createWebHost();
      let settled = false;
      void host.login!({ apiBase: 'https://api.test', nextPath: '/studio' }).then(() => {
        settled = true;
      });
      expect(fake.href).toBe('https://api.test/auth/google?next=%2Fstudio');
      await Promise.resolve();
      expect(settled).toBe(false);
    } finally {
      Object.defineProperty(window, 'location', { value: original, writable: true, configurable: true });
    }
  });

  it('openExternal membuka tab baru dengan noopener', async () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    await createWebHost().openExternal('https://github.com/x');
    expect(open).toHaveBeenCalledWith('https://github.com/x', '_blank', 'noopener');
  });

  it('authHeaders kosong — sesinya cookie', async () => {
    expect(await createWebHost().authHeaders()).toEqual({});
  });

  it('tidak menyediakan dialog native maupun drop native', () => {
    const host = createWebHost();
    expect(host.openAudioFiles).toBeUndefined();
    expect(host.onFilesDropped).toBeUndefined();
  });
});

describe('modelBytes (tanpa OPFS)', () => {
  it('fetch dari URL katalog dan menolak unduhan yang terpotong', async () => {
    const storage = navigator.storage;
    Object.defineProperty(navigator, 'storage', { value: undefined, configurable: true });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array(10), { status: 200 }),
    );
    try {
      await expect(createWebHost().modelBytes('base', () => {})).rejects.toThrow(/tidak lengkap/);
      expect(fetchSpy).toHaveBeenCalledWith('/models/scnet/scnet-base.onnx');
    } finally {
      Object.defineProperty(navigator, 'storage', { value: storage, configurable: true });
    }
  });
});
