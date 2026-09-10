/**
 * Adapter desktop dengan `@tauri-apps/*` di-mock seluruhnya — tidak ada Tauri
 * di vitest. Yang dijaga adalah KONTRAK dengan sisi Rust: export streaming ke
 * berkas yang dipilih dialog, drop OS yang datang sebagai path lalu jadi
 * `File`, model lewat command + event progres — dan bahwa TIDAK ADA sesi:
 * `login` tidak didefinisikan dan `authHeaders()` kosong.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn(async (_cmd: string, _args?: unknown, _opts?: unknown): Promise<unknown> => null);
vi.mock('@tauri-apps/api/core', () => ({
  // Opsi ketiga (`{ headers }` untuk badan mentah) hanya diteruskan kalau ada,
  // supaya `toHaveBeenCalledWith(cmd, args)` yang lama tetap cocok.
  invoke: (cmd: string, args?: unknown, opts?: unknown) => (opts === undefined ? invoke(cmd, args) : invoke(cmd, args, opts)),
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
let splitProgressHandler: ((e: { payload: unknown }) => void) | null = null;
const unlistenEvent = vi.fn();
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, h: (e: { payload: unknown }) => void) => {
    if (name === 'daw://vocal-split-progress') splitProgressHandler = h;
    else progressHandler = h;
    return unlistenEvent;
  },
}));

import { baseName, createDesktopHost, decodeSplitOutput, DroppedPathRegistry, encodeSplitInput } from './desktop';

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(null);
  openUrl.mockClear();
  dropHandler = null;
  progressHandler = null;
  splitProgressHandler = null;
  unlistenEvent.mockClear();
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
  it('baseName memahami pemisah macOS dan Windows', () => {
    expect(baseName('/Users/a/Music/lagu.wav')).toBe('lagu.wav');
    expect(baseName('C:\\Users\\a\\lagu.mp3')).toBe('lagu.mp3');
    expect(baseName('lagu.flac')).toBe('lagu.flac');
  });
});

describe('sesi', () => {
  it('tidak ada login di desktop: `login` tidak didefinisikan, authHeaders() kosong, tanpa IPC', async () => {
    const host = createDesktopHost();
    expect(host.kind).toBe('desktop');
    expect(host.login).toBeUndefined();
    expect(await host.authHeaders()).toEqual({});
    expect(invoke).not.toHaveBeenCalled();
  });

  it('tidak ada libraryApi di host: kepustakaan lokal didaftarkan main.tsx, bukan platform', () => {
    expect('libraryApi' in createDesktopHost()).toBe(false);
  });
});

describe('path berkas yang baru masuk (jalur cepat library_import_path)', () => {
  it('drop OS: path-nya bisa diklaim SEKALI lewat (name, size), lalu habis', async () => {
    readFile.mockResolvedValue(new Uint8Array([1, 2]));
    const host = createDesktopHost();
    const off = host.onFilesDropped!(() => {});
    for (let i = 0; i < 10 && dropHandler === null; i++) await Promise.resolve();
    dropHandler!({ payload: { type: 'drop', paths: ['/a/x.wav'], position: { x: 1, y: 1 } } });
    // Klaim pertama yang berhasil ada di dalam waitFor; sesudahnya kosong.
    await vi.waitFor(() => expect(host.droppedPathFor!('x.wav', 2)).toBe('/a/x.wav'));
    expect(host.droppedPathFor!('x.wav', 2)).toBeNull();
    // Ukuran lain = berkas lain.
    dropHandler!({ payload: { type: 'drop', paths: ['/b/x.wav'], position: { x: 1, y: 1 } } });
    await vi.waitFor(() => expect(readFile).toHaveBeenCalledTimes(2));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(host.droppedPathFor!('x.wav', 3)).toBeNull();
    expect(host.droppedPathFor!('x.wav', 2)).toBe('/b/x.wav');
    off();
  });

  it('dialog native juga mengingat path — berkas dari "buka…" tidak perlu lewat IPC dua kali', async () => {
    dialogOpen.mockResolvedValue(['/a/lagu.flac']);
    readFile.mockResolvedValue(new Uint8Array(7));
    const host = createDesktopHost();
    await host.openAudioFiles!();
    expect(host.droppedPathFor!('lagu.flac', 7)).toBe('/a/lagu.flac');
  });

  it('registry: FIFO untuk nama+ukuran sama, kedaluwarsa, dan dibatasi jumlahnya', () => {
    let now = 0;
    const reg = new DroppedPathRegistry(3, 1000, () => now);
    reg.remember('x.wav', 1, '/1/x.wav');
    reg.remember('x.wav', 1, '/2/x.wav');
    expect(reg.take('x.wav', 1)).toBe('/1/x.wav');
    expect(reg.take('x.wav', 1)).toBe('/2/x.wav');
    expect(reg.take('x.wav', 1)).toBeNull();

    reg.remember('tua.wav', 1, '/tua');
    now = 1001;
    expect(reg.take('tua.wav', 1)).toBeNull();

    reg.remember('a', 1, '/a');
    reg.remember('b', 1, '/b');
    reg.remember('c', 1, '/c');
    reg.remember('d', 1, '/d');
    expect(reg.take('a', 1)).toBeNull();
    expect(reg.take('d', 1)).toBe('/d');
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

  it('downloadUrl ADA dan membuka tautan di browser OS — WebView tidak mengunduh dari <a download>', async () => {
    const host = createDesktopHost();
    expect(host.downloadUrl).toBeDefined();
    await host.downloadUrl!('https://sc.test/v1/download?url=x');
    expect(openUrl).toHaveBeenCalledWith('https://sc.test/v1/download?url=x');
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
    const out = await createDesktopHost().modelBytes!('base', (p) => progress.push(p));
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
    const out = await createDesktopHost().modelBytes!('base', () => {});
    expect(out.cacheHit).toBe(true);
    expect(out.bytes).toBeInstanceOf(Uint8Array);
  });

  it('byte yang terpotong ditolak', async () => {
    invoke.mockImplementation(async (cmd) => (cmd === 'model_read' ? new Uint8Array(5) : '/p'));
    await expect(createDesktopHost().modelBytes!('base', () => {})).rejects.toThrow(/tidak lengkap/);
  });

  it("'kim-vocal-2' lewat pipa yang sama, ukurannya dari VOCAL_MODELS (docs/26 P2)", async () => {
    const total = 66_759_214;
    invoke.mockImplementation(async (cmd) => {
      if (cmd === 'model_download') {
        progressHandler!({ payload: { id: 'kim-vocal-2', done: 10, total } });
        progressHandler!({ payload: { id: 'base', done: 999, total: 1 } }); // model lain: abaikan
        return '/data/models/Kim_Vocal_2.onnx';
      }
      if (cmd === 'model_read') return new Uint8Array(total);
      return null;
    });
    const progress: unknown[] = [];
    const out = await createDesktopHost().modelBytes!('kim-vocal-2', (p) => progress.push(p));
    expect(out.bytes.byteLength).toBe(total);
    expect(out.cacheHit).toBe(false);
    expect(progress).toEqual([
      { loaded: 10, total, cacheHit: false },
      { loaded: total, total, cacheHit: false },
    ]);
    expect(invoke).toHaveBeenCalledWith('model_download', { id: 'kim-vocal-2' });
    expect(invoke).toHaveBeenCalledWith('model_read', { id: 'kim-vocal-2' });
  });

  it("'kim-vocal-2' yang terpotong ditolak dengan ukuran katalog vocal-split, bukan SCNet", async () => {
    // 44 516 685 byte = ukuran scnet-base: kalau katalognya keliru, ini lolos.
    invoke.mockImplementation(async (cmd) => (cmd === 'model_read' ? new Uint8Array(44_516_685) : '/p'));
    await expect(createDesktopHost().modelBytes!('kim-vocal-2', () => {})).rejects.toThrow(
      /tidak lengkap: 44516685 \/ 66759214/,
    );
  });
});

describe('vocalSplit (docs/26 P3b)', () => {
  const N = 4;
  const left = new Float32Array([0.5, -0.25, 1, 0]);
  const right = new Float32Array([0.125, 0.75, -1, 2]);

  /** Balasan Rust: `[voc_l, voc_r, inst_l, inst_r]` = kiri×0,5, kanan×0,5, kiri×0,25, kanan×0,25. */
  function reply(): Float32Array {
    const out = new Float32Array(4 * N);
    for (let i = 0; i < N; i += 1) {
      out[i] = left[i]! * 0.5;
      out[N + i] = right[i]! * 0.5;
      out[2 * N + i] = left[i]! * 0.25;
      out[3 * N + i] = right[i]! * 0.25;
    }
    return out;
  }

  const input = { left, right, sampleRate: 44_100, modelId: 'kim-vocal-2' as const, overlap: 0.25 as const, denoise: false, accel: 'cpu' as const, threads: 3 };

  it('host desktop punya vocalSplit', () => {
    expect(createDesktopHost().vocalSplit).toBeDefined();
  });

  it('accels: hasil Rust apa adanya, nilai asing dibuang, cpu selalu ada', async () => {
    const host = createDesktopHost().vocalSplit!;
    invoke.mockResolvedValueOnce(['cpu', 'coreml']);
    expect(await host.accels()).toEqual(['cpu', 'coreml']);
    expect(invoke).toHaveBeenLastCalledWith('vocal_split_accels', undefined);
    invoke.mockResolvedValueOnce(['cpu', 'vulkan']);
    expect(await host.accels()).toEqual(['cpu']);
    invoke.mockResolvedValueOnce(['coreml']);
    expect(await host.accels()).toEqual(['cpu', 'coreml']);
  });

  it('ensureModel: model_download + progres yang difilter id, TANPA model_read', async () => {
    const total = 66_759_214;
    invoke.mockImplementation(async (cmd) => {
      if (cmd === 'model_download') {
        progressHandler!({ payload: { id: 'kim-vocal-2', done: 10, total } });
        progressHandler!({ payload: { id: 'base', done: 999, total: 1 } }); // model lain: abaikan
        return '/data/models/Kim_Vocal_2.onnx';
      }
      return null;
    });
    const progress: unknown[] = [];
    await createDesktopHost().vocalSplit!.ensureModel('kim-vocal-2', (p) => progress.push(p));
    expect(progress).toEqual([
      { loaded: 10, total, cacheHit: false },
      { loaded: total, total, cacheHit: false },
    ]);
    expect(invoke).toHaveBeenCalledWith('model_download', { id: 'kim-vocal-2' });
    expect(invoke).not.toHaveBeenCalledWith('model_read', expect.anything());
    expect(unlistenEvent).toHaveBeenCalledTimes(1);
  });

  it('ensureModel tanpa event progres = berkas sudah ada → cacheHit', async () => {
    const progress: unknown[] = [];
    await createDesktopHost().vocalSplit!.ensureModel('kim-vocal-2', (p) => progress.push(p));
    expect(progress).toEqual([{ loaded: 66_759_214, total: 66_759_214, cacheHit: true }]);
  });

  it('run: badan Float32 LE [L, R], header lengkap, progres difilter id, balasan Uint8Array diparse', async () => {
    let jobId = '';
    invoke.mockImplementation(async (cmd, _args, opts) => {
      if (cmd !== 'vocal_split_run') return null;
      jobId = (opts as { headers: Record<string, string> }).headers['x-job-id']!;
      splitProgressHandler!({ payload: { id: 'job-lain', done: 9, total: 9 } }); // job lain: abaikan
      splitProgressHandler!({ payload: { id: jobId, done: 1, total: 3 } });
      return new Uint8Array(reply().buffer);
    });
    const progress: [number, number][] = [];
    const out = await createDesktopHost().vocalSplit!.run(input, (done, total) => progress.push([done, total]));

    const [cmd, body, opts] = invoke.mock.calls.find((c) => c[0] === 'vocal_split_run')!;
    expect(cmd).toBe('vocal_split_run');
    expect(body).toBeInstanceOf(Uint8Array);
    const bytes = body as Uint8Array;
    expect(bytes.byteLength).toBe(2 * N * 4);
    // Little-endian eksplisit: dibaca kembali lewat DataView, bukan Float32Array mesin.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(Array.from({ length: N }, (_, i) => view.getFloat32(i * 4, true))).toEqual([...left]);
    expect(Array.from({ length: N }, (_, i) => view.getFloat32((N + i) * 4, true))).toEqual([...right]);
    expect(opts).toEqual({
      headers: {
        'x-job-id': jobId,
        'x-frames': '4',
        'x-model': 'kim-vocal-2',
        'x-overlap': '0.25',
        'x-denoise': '0',
        'x-accel': 'cpu',
        'x-threads': '3',
      },
    });
    expect(jobId).not.toBe('');
    expect(progress).toEqual([[1, 3]]);
    expect([...out.vocals.left]).toEqual([0.25, -0.125, 0.5, 0]);
    expect([...out.vocals.right]).toEqual([0.0625, 0.375, -0.5, 1]);
    expect([...out.instrumental.left]).toEqual([0.125, -0.0625, 0.25, 0]);
    expect([...out.instrumental.right]).toEqual([0.03125, 0.1875, -0.25, 0.5]);
    // Empat buffer terpisah — bukan view ke satu balasan.
    expect(out.vocals.left.buffer).not.toBe(out.vocals.right.buffer);
    expect(unlistenEvent).toHaveBeenCalledTimes(1);
  });

  it('run: overlap 0,5 + denoise + coreml tanpa thread → header sesuai, x-threads tidak ada', async () => {
    invoke.mockImplementation(async (cmd) => (cmd === 'vocal_split_run' ? new Uint8Array(reply().buffer) : null));
    await createDesktopHost().vocalSplit!.run({ ...input, overlap: 0.5, denoise: true, accel: 'coreml', threads: undefined }, () => {});
    const [, , opts] = invoke.mock.calls.find((c) => c[0] === 'vocal_split_run')!;
    expect(opts).toEqual({
      headers: expect.objectContaining({ 'x-overlap': '0.5', 'x-denoise': '1', 'x-accel': 'coreml' }),
    });
    expect((opts as { headers: Record<string, string> }).headers).not.toHaveProperty('x-threads');
  });

  it('run: balasan number[] (JSON) dan ArrayBuffer diparse sama', async () => {
    const asBytes = new Uint8Array(reply().buffer);
    invoke.mockImplementation(async (cmd) => (cmd === 'vocal_split_run' ? Array.from(asBytes) : null));
    const fromArray = await createDesktopHost().vocalSplit!.run(input, () => {});
    expect([...fromArray.vocals.left]).toEqual([0.25, -0.125, 0.5, 0]);
    invoke.mockImplementation(async (cmd) => (cmd === 'vocal_split_run' ? asBytes.buffer : null));
    const fromBuffer = await createDesktopHost().vocalSplit!.run(input, () => {});
    expect([...fromBuffer.instrumental.right]).toEqual([0.03125, 0.1875, -0.25, 0.5]);
  });

  it('decodeSplitOutput: view dengan byteOffset bukan kelipatan 4 tetap benar; panjang salah ditolak', () => {
    const padded = new Uint8Array(1 + 4 * N * 4);
    padded.set(new Uint8Array(reply().buffer), 1);
    const out = decodeSplitOutput(padded.subarray(1), N);
    expect([...out.vocals.left]).toEqual([0.25, -0.125, 0.5, 0]);
    expect(() => decodeSplitOutput(new Uint8Array(3), N)).toThrow(/diharapkan 64/);
    expect(() => encodeSplitInput(new Float32Array(2), new Float32Array(3))).toThrow(/harus sama/);
  });

  it('run: sample rate ≠ 44,1 kHz ditolak sebelum IPC', async () => {
    await expect(createDesktopHost().vocalSplit!.run({ ...input, sampleRate: 48_000 }, () => {})).rejects.toThrow(/44100/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('abort → vocal_split_cancel dengan id yang sama; Rust menolak CANCELLED → AbortError', async () => {
    const controller = new AbortController();
    let rejectRun: ((reason: unknown) => void) | null = null;
    let jobId = '';
    invoke.mockImplementation(async (cmd, args, opts) => {
      if (cmd === 'vocal_split_run') {
        jobId = (opts as { headers: Record<string, string> }).headers['x-job-id']!;
        return new Promise((_resolve, reject) => {
          rejectRun = reject;
        });
      }
      if (cmd === 'vocal_split_cancel') {
        expect(args).toEqual({ id: jobId });
        rejectRun!({ code: 'CANCELLED', message: 'dibatalkan' });
        return null;
      }
      return null;
    });
    const job = createDesktopHost().vocalSplit!.run(input, () => {}, controller.signal);
    await vi.waitFor(() => expect(rejectRun).not.toBeNull());
    controller.abort();
    const err = await job.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('AbortError');
    expect(invoke).toHaveBeenCalledWith('vocal_split_cancel', { id: jobId });
    expect(unlistenEvent).toHaveBeenCalledTimes(1);
  });

  it('signal sudah aborted sebelum run → AbortError tanpa IPC', async () => {
    const controller = new AbortController();
    controller.abort();
    const err = await createDesktopHost().vocalSplit!.run(input, () => {}, controller.signal).catch((e: unknown) => e);
    expect((err as DOMException).name).toBe('AbortError');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('hasil tiba setelah abort → tetap AbortError, hasil dibuang', async () => {
    const controller = new AbortController();
    let resolveRun: ((value: unknown) => void) | null = null;
    invoke.mockImplementation(async (cmd) => {
      if (cmd === 'vocal_split_run') {
        return new Promise((resolve) => {
          resolveRun = resolve;
        });
      }
      return null;
    });
    const job = createDesktopHost().vocalSplit!.run(input, () => {}, controller.signal);
    await vi.waitFor(() => expect(resolveRun).not.toBeNull());
    controller.abort();
    resolveRun!(new Uint8Array(reply().buffer));
    const err = await job.catch((e: unknown) => e);
    expect((err as DOMException).name).toBe('AbortError');
  });

  it('galat Rust selain CANCELLED → Error dengan kode dan pesannya (BUSY, MODEL_MISSING)', async () => {
    invoke.mockImplementation(async (cmd) => {
      if (cmd === 'vocal_split_run') throw { code: 'MODEL_MISSING', message: 'Kim_Vocal_2.onnx belum diunduh' };
      return null;
    });
    const err = await createDesktopHost().vocalSplit!.run(input, () => {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ code: 'MODEL_MISSING', message: 'Kim_Vocal_2.onnx belum diunduh' });
    expect((err as Error).name).not.toBe('AbortError');
    invoke.mockImplementation(async (cmd) => {
      if (cmd === 'vocal_split_run') throw 'sibuk';
      return null;
    });
    await expect(createDesktopHost().vocalSplit!.run(input, () => {})).rejects.toMatchObject({ code: 'IO', message: 'sibuk' });
  });

  it('balasan yang panjangnya tidak sesuai N ditolak', async () => {
    invoke.mockImplementation(async (cmd) => (cmd === 'vocal_split_run' ? new Uint8Array(8) : null));
    await expect(createDesktopHost().vocalSplit!.run(input, () => {})).rejects.toThrow(/diharapkan 64/);
  });
});
