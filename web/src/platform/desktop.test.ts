/**
 * Adapter desktop dengan `@tauri-apps/*` di-mock seluruhnya — tidak ada Tauri
 * di vitest. Yang dijaga adalah KONTRAK dengan sisi Rust dan Worker (docs/20
 * §1d): state acak yang harus cocok, kode yang ditukar lewat fetch tanpa
 * kredensial, token yang hanya tersimpan kalau penukaran berhasil, dan drop
 * OS yang datang sebagai path lalu jadi `File`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null);
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
  isTauri: () => true,
}));

/** Handler `onOpenUrl` yang terpasang terakhir; tes memanggilnya seolah OS. */
let deepLinkHandler: ((urls: string[]) => void) | null = null;
const unlistenDeepLink = vi.fn();
vi.mock('@tauri-apps/plugin-deep-link', () => ({
  onOpenUrl: async (handler: (urls: string[]) => void) => {
    deepLinkHandler = handler;
    return unlistenDeepLink;
  },
}));

const openUrl = vi.fn(async (_u: string) => {});
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: (u: string) => openUrl(u) }));

const dialogSave = vi.fn(async (_o: unknown): Promise<string | null> => null);
const dialogOpen = vi.fn(async (_o: unknown): Promise<string | string[] | null> => null);
vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: (o: unknown) => dialogSave(o),
  open: (o: unknown) => dialogOpen(o),
}));

const fileOps = {
  write: vi.fn(async (d: Uint8Array): Promise<number> => d.byteLength),
  seek: vi.fn(async () => 0),
  close: vi.fn(async () => {}),
};
const fsOpen = vi.fn(async (_p: string, _o: unknown) => fileOps);
const fsRemove = vi.fn(async (_p: string) => {});
const readFile = vi.fn(async (_p: string): Promise<Uint8Array> => new Uint8Array(0));
vi.mock('@tauri-apps/plugin-fs', () => ({
  open: (p: string, o: unknown) => fsOpen(p, o),
  remove: (p: string) => fsRemove(p),
  readFile: (p: string) => readFile(p),
  SeekMode: { Start: 0, Current: 1, End: 2 },
}));

let dropHandler: ((e: { payload: unknown }) => void) | null = null;
const unlistenDrop = vi.fn();
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({
    onDragDropEvent: async (h: (e: { payload: unknown }) => void) => {
      dropHandler = h;
      return unlistenDrop;
    },
  }),
}));

let progressHandler: ((e: { payload: unknown }) => void) | null = null;
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (_name: string, h: (e: { payload: unknown }) => void) => {
    progressHandler = h;
    return () => {};
  },
}));

import { baseName, createDesktopHost, parseAuthDeepLink, randomState } from './desktop';

const API = 'https://api.test';

function stateOf(url: string): string {
  return new URL(url).searchParams.get('state') ?? '';
}

/** Tunggu sampai browser dibuka — itu tanda listener deep link sudah terpasang. */
async function untilBrowserOpened(): Promise<string> {
  for (let i = 0; i < 20 && openUrl.mock.calls.length === 0; i++) await Promise.resolve();
  const url = openUrl.mock.calls[0]?.[0] as string | undefined;
  if (url === undefined) throw new Error('browser tidak dibuka');
  return url;
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(null);
  openUrl.mockClear();
  unlistenDeepLink.mockClear();
  deepLinkHandler = null;
  dropHandler = null;
  progressHandler = null;
  dialogSave.mockReset();
  dialogSave.mockResolvedValue(null);
  dialogOpen.mockReset();
  dialogOpen.mockResolvedValue(null);
  fsOpen.mockClear();
  fsRemove.mockClear();
  fileOps.write.mockClear();
  fileOps.seek.mockClear();
  fileOps.close.mockClear();
  readFile.mockReset();
  readFile.mockResolvedValue(new Uint8Array(0));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('helper', () => {
  it('randomState 32 hex dari getRandomValues, berbeda tiap panggilan', () => {
    const a = randomState();
    const b = randomState();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it('parseAuthDeepLink hanya menerima kelasmalam://auth dengan code+state', () => {
    expect(parseAuthDeepLink('kelasmalam://auth?code=abc&state=xyz')).toEqual({ code: 'abc', state: 'xyz' });
    expect(parseAuthDeepLink('kelasmalam://auth?code=abc')).toBeNull();
    expect(parseAuthDeepLink('kelasmalam://lain?code=abc&state=xyz')).toBeNull();
    expect(parseAuthDeepLink('https://evil.test/auth?code=abc&state=xyz')).toBeNull();
    expect(parseAuthDeepLink('bukan url')).toBeNull();
  });

  it('baseName memahami pemisah macOS dan Windows', () => {
    expect(baseName('/Users/a/Music/lagu.wav')).toBe('lagu.wav');
    expect(baseName('C:\\Users\\a\\lagu.mp3')).toBe('lagu.mp3');
    expect(baseName('lagu.flac')).toBe('lagu.flac');
  });
});

describe('login', () => {
  it('listener dipasang sebelum browser dibuka; state cocok → tukar kode tanpa kredensial → simpan token', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ token: 'tok-1' }), { status: 200 }),
    );
    invoke.mockResolvedValue(null);
    const host = createDesktopHost();

    const pending = host.login({ apiBase: API, nextPath: '/studio' });
    const url = await untilBrowserOpened();
    expect(deepLinkHandler).not.toBeNull();
    expect(url).toMatch(/^https:\/\/api\.test\/auth\/google\?client=desktop&state=[0-9a-f]{32}&next=%2Fstudio$/);

    deepLinkHandler!([`kelasmalam://auth?code=kode-1&state=${stateOf(url)}`]);
    await pending;

    const [exchangeUrl, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(exchangeUrl).toBe(`${API}/auth/desktop/exchange`);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    expect(init.body).toBe(JSON.stringify({ code: 'kode-1' }));
    expect(invoke).toHaveBeenCalledWith('auth_token_set', { token: 'tok-1' });
    expect(unlistenDeepLink).toHaveBeenCalledOnce();
    // Token yang baru langsung dipakai, tanpa membaca keychain lagi.
    expect(await host.authHeaders()).toEqual({ authorization: 'Bearer tok-1' });
    expect(invoke).not.toHaveBeenCalledWith('auth_token_get', undefined);
  });

  it('state yang tidak cocok DITOLAK: tidak ada penukaran, tidak ada token', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const host = createDesktopHost();
    const pending = host.login({ apiBase: API, nextPath: '/studio' });
    await untilBrowserOpened();

    deepLinkHandler!(['kelasmalam://auth?code=kode-asing&state=' + 'f'.repeat(32)]);
    await expect(pending).rejects.toThrow(/state login tidak cocok/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalledWith('auth_token_set', expect.anything());
    expect(unlistenDeepLink).toHaveBeenCalledOnce();
  });

  it('deep link yang bukan auth diabaikan, dan yang benar sesudahnya tetap diterima', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ token: 'tok-2' }), { status: 200 }),
    );
    invoke.mockResolvedValue(null);
    const host = createDesktopHost();
    const pending = host.login({ apiBase: API, nextPath: '/dj' });
    const url = await untilBrowserOpened();
    deepLinkHandler!(['kelasmalam://open?project=abc']);
    deepLinkHandler!([`kelasmalam://auth?code=kode-2&state=${stateOf(url)}`]);
    await pending;
    expect(invoke).toHaveBeenCalledWith('auth_token_set', { token: 'tok-2' });
  });

  it('penukaran ditolak server → gagal, token TIDAK disimpan', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 401 }));
    const host = createDesktopHost();
    const pending = host.login({ apiBase: API, nextPath: '/studio' });
    const url = await untilBrowserOpened();
    deepLinkHandler!([`kelasmalam://auth?code=kadaluarsa&state=${stateOf(url)}`]);
    await expect(pending).rejects.toThrow(/HTTP 401/);
    expect(invoke).not.toHaveBeenCalledWith('auth_token_set', expect.anything());
  });

  it('balasan tanpa token juga tidak menyimpan apa pun', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const host = createDesktopHost();
    const pending = host.login({ apiBase: API, nextPath: '/studio' });
    const url = await untilBrowserOpened();
    deepLinkHandler!([`kelasmalam://auth?code=k&state=${stateOf(url)}`]);
    await expect(pending).rejects.toThrow(/tidak mengembalikan token/);
    expect(invoke).not.toHaveBeenCalledWith('auth_token_set', expect.anything());
  });
});

describe('authHeaders / logout', () => {
  it('tanpa token di keychain → {} ; keychain dibaca SEKALI', async () => {
    invoke.mockResolvedValue(null);
    const host = createDesktopHost();
    expect(await host.authHeaders()).toEqual({});
    expect(await host.authHeaders()).toEqual({});
    expect(invoke.mock.calls.filter(([c]) => c === 'auth_token_get')).toHaveLength(1);
  });

  it('token di keychain → Bearer', async () => {
    invoke.mockImplementation(async (cmd) => (cmd === 'auth_token_get' ? 'tok-k' : null));
    expect(await createDesktopHost().authHeaders()).toEqual({ authorization: 'Bearer tok-k' });
  });

  it('keychain gagal dibaca → {} untuk permintaan ini, dicoba lagi berikutnya', async () => {
    invoke.mockRejectedValueOnce(new Error('keyring')).mockResolvedValue('tok-lagi');
    const host = createDesktopHost();
    expect(await host.authHeaders()).toEqual({});
    expect(await host.authHeaders()).toEqual({ authorization: 'Bearer tok-lagi' });
  });

  it('logout menghapus keychain dan melupakan token di memori', async () => {
    invoke.mockImplementation(async (cmd) => (cmd === 'auth_token_get' ? 'tok-k' : null));
    const host = createDesktopHost();
    expect(await host.authHeaders()).toEqual({ authorization: 'Bearer tok-k' });
    await host.logout();
    expect(invoke).toHaveBeenCalledWith('auth_token_clear', undefined);
    expect(await host.authHeaders()).toEqual({});
  });
});

describe('pickSaveTarget (export streaming ke berkas)', () => {
  it('dialog dibatalkan → cancelled, tidak ada berkas dibuka', async () => {
    dialogSave.mockResolvedValue(null);
    const target = await createDesktopHost().pickSaveTarget('mix.wav', 'audio/wav', 'wav');
    expect(target.kind).toBe('cancelled');
    expect(fsOpen).not.toHaveBeenCalled();
  });

  it('path dipilih → chunk ditulis bertahap, header ditimpa lewat seek(0), lalu ditutup', async () => {
    dialogSave.mockResolvedValue('/tmp/mix.wav');
    const target = await createDesktopHost().pickSaveTarget('mix.wav', 'audio/wav', 'wav');
    expect(target.kind).toBe('stream');
    if (target.kind !== 'stream') return;
    expect(dialogSave.mock.calls[0]?.[0]).toEqual({
      defaultPath: 'mix.wav',
      filters: [{ name: 'Audio', extensions: ['wav'] }],
    });
    expect(fsOpen).toHaveBeenCalledWith('/tmp/mix.wav', { write: true, create: true, truncate: true });

    await target.sink.header(new Uint8Array(44));
    await target.sink.chunk(new Uint8Array(1000));
    await target.sink.chunk(new Uint8Array(500));
    await target.sink.patchHeader(new Uint8Array(44).fill(7));
    await target.sink.close();

    const sizes = fileOps.write.mock.calls.map(([d]) => d.byteLength);
    expect(sizes).toEqual([44, 1000, 500, 44]);
    expect(fileOps.seek).toHaveBeenCalledWith(0, 0);
    expect(fileOps.close).toHaveBeenCalledOnce();
    expect(fsRemove).not.toHaveBeenCalled();
  });

  it('write parsial diulang sampai seluruh chunk tertulis', async () => {
    dialogSave.mockResolvedValue('/tmp/mix.wav');
    fileOps.write.mockImplementation(async (d) => Math.min(300, d.byteLength));
    const target = await createDesktopHost().pickSaveTarget('mix.wav', 'audio/wav', 'wav');
    if (target.kind !== 'stream') throw new Error('bukan stream');
    await target.sink.chunk(new Uint8Array(1000));
    const sizes = fileOps.write.mock.calls.map(([d]) => d.byteLength);
    expect(sizes).toEqual([1000, 700, 400, 100]);
    fileOps.write.mockImplementation(async (d) => d.byteLength);
  });

  it('header final yang beda panjang ditolak sebelum menimpa', async () => {
    dialogSave.mockResolvedValue('/tmp/mix.wav');
    const target = await createDesktopHost().pickSaveTarget('mix.wav', 'audio/wav', 'wav');
    if (target.kind !== 'stream') throw new Error('bukan stream');
    await target.sink.header(new Uint8Array(44));
    await expect(target.sink.patchHeader(new Uint8Array(40))).rejects.toThrow(/placeholder/);
    expect(fileOps.seek).not.toHaveBeenCalled();
  });

  it('abort menutup DAN menghapus berkasnya', async () => {
    dialogSave.mockResolvedValue('/tmp/mix.wav');
    const target = await createDesktopHost().pickSaveTarget('mix.wav', 'audio/wav', 'wav');
    if (target.kind !== 'stream') throw new Error('bukan stream');
    await target.sink.chunk(new Uint8Array(10));
    await target.sink.abort(new Error('batal'));
    expect(fileOps.close).toHaveBeenCalledOnce();
    expect(fsRemove).toHaveBeenCalledWith('/tmp/mix.wav');
  });
});

describe('openAudioFiles / openExternal', () => {
  it('dialog open → tiap path dibaca jadi File dengan nama dan MIME dari ekstensi', async () => {
    dialogOpen.mockResolvedValue(['/a/lagu.wav', '/b/track.mp3']);
    readFile.mockImplementation(async (p) => new Uint8Array(p.endsWith('.wav') ? 10 : 12));
    const files = await createDesktopHost().openAudioFiles!({ extensions: ['wav', 'mp3'] });
    expect(files.map((f) => [f.name, f.type, f.size])).toEqual([
      ['lagu.wav', 'audio/wav', 10],
      ['track.mp3', 'audio/mpeg', 12],
    ]);
    expect(dialogOpen.mock.calls[0]?.[0]).toEqual({
      multiple: true,
      directory: false,
      filters: [{ name: 'Audio', extensions: ['wav', 'mp3'] }],
    });
  });

  it('dialog dibatalkan → daftar kosong; satu path → satu File', async () => {
    dialogOpen.mockResolvedValueOnce(null);
    expect(await createDesktopHost().openAudioFiles!()).toEqual([]);
    dialogOpen.mockResolvedValueOnce('/x/satu.flac');
    readFile.mockResolvedValue(new Uint8Array(3));
    const files = await createDesktopHost().openAudioFiles!({ multiple: false });
    expect(files.map((f) => f.name)).toEqual(['satu.flac']);
  });

  it('openExternal memakai opener OS, bukan window.open', async () => {
    const winOpen = vi.spyOn(window, 'open');
    await createDesktopHost().openExternal('https://soundcloud.com/x');
    expect(openUrl).toHaveBeenCalledWith('https://soundcloud.com/x');
    expect(winOpen).not.toHaveBeenCalled();
  });
});

describe('onFilesDropped', () => {
  it('drop path → File, titik jatuh dikonversi dari piksel fisik ke CSS', async () => {
    readFile.mockResolvedValue(new Uint8Array([1, 2]));
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    const got: [readonly File[], { x: number; y: number }][] = [];
    const off = createDesktopHost().onFilesDropped!((files, point) => got.push([files, point]));
    for (let i = 0; i < 10 && dropHandler === null; i++) await Promise.resolve();
    expect(dropHandler).not.toBeNull();

    dropHandler!({ payload: { type: 'enter', paths: ['/a/x.wav'], position: { x: 0, y: 0 } } });
    dropHandler!({ payload: { type: 'drop', paths: ['/a/x.wav'], position: { x: 400, y: 200 } } });
    for (let i = 0; i < 10 && got.length === 0; i++) await Promise.resolve();

    expect(got).toHaveLength(1);
    expect(got[0]![0].map((f) => f.name)).toEqual(['x.wav']);
    expect(got[0]![1]).toEqual({ x: 200, y: 100 });
    expect(readFile).toHaveBeenCalledTimes(1);

    off();
    expect(unlistenDrop).toHaveBeenCalledOnce();
  });

  it('sesudah dilepas, drop yang menyusul tidak sampai ke pemanggil', async () => {
    readFile.mockResolvedValue(new Uint8Array(1));
    const cb = vi.fn();
    const off = createDesktopHost().onFilesDropped!(cb);
    for (let i = 0; i < 10 && dropHandler === null; i++) await Promise.resolve();
    off();
    dropHandler!({ payload: { type: 'drop', paths: ['/a/x.wav'], position: { x: 1, y: 1 } } });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('modelBytes', () => {
  it('unduh lewat Rust dengan progres, baca byte, verifikasi ukuran', async () => {
    const total = 44_516_685;
    invoke.mockImplementation(async (cmd) => {
      if (cmd === 'model_download') {
        progressHandler!({ payload: { id: 'base', done: 10, total } });
        progressHandler!({ payload: { id: 'large', done: 999, total: 1 } }); // model lain: abaikan
        return '/data/models/scnet-base.onnx';
      }
      if (cmd === 'model_read') return new Uint8Array(total);
      return null;
    });
    const progress: unknown[] = [];
    const out = await createDesktopHost().modelBytes('base', (p) => progress.push(p));
    expect(out.bytes.byteLength).toBe(total);
    expect(out.cacheHit).toBe(false);
    expect(progress).toEqual([
      { loaded: 10, total, cacheHit: false },
      { loaded: total, total, cacheHit: false },
    ]);
    expect(invoke).toHaveBeenCalledWith('model_download', { id: 'base' });
    expect(invoke).toHaveBeenCalledWith('model_read', { id: 'base' });
  });

  it('tanpa event progres = berkas sudah ada → cacheHit; number[] diterima', async () => {
    invoke.mockImplementation(async (cmd) =>
      cmd === 'model_read' ? Array.from({ length: 44_516_685 }, () => 0) : '/p',
    );
    const out = await createDesktopHost().modelBytes('base', () => {});
    expect(out.cacheHit).toBe(true);
    expect(out.bytes).toBeInstanceOf(Uint8Array);
  });

  it('byte yang terpotong ditolak', async () => {
    invoke.mockImplementation(async (cmd) => (cmd === 'model_read' ? new Uint8Array(5) : '/p'));
    await expect(createDesktopHost().modelBytes('base', () => {})).rejects.toThrow(/tidak lengkap/);
  });
});
