/**
 * Jalur pengambilan model Kim_Vocal_2 di BROWSER (fetch HuggingFace + OPFS)
 * dan pemilihannya (`prefetchVocalModelBytes`) berdasarkan KONTRAK host,
 * bukan platform — pola `proof-stem/model-bytes.test.ts`.
 *
 * ORT tidak disentuh di sini (tidak ada WASM di jsdom); `loadVocalModel`
 * hanya dibuktikan lewat jalur byte-nya.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setPlatformHostForTests, type PlatformHost, type ScnetModelDownloadProgress } from '@kelasmalam/platform';
import { VOCAL_MODELS } from '../catalog';
import { fetchVocalModelBytesInBrowser, prefetchVocalModelBytes } from '../mdx-model';

const KIM = VOCAL_MODELS['kim-vocal-2'];

const baseHost: PlatformHost = {
  kind: 'web',
  pickSaveTarget: async () => ({ kind: 'cancelled' }),
  openExternal: async () => {},
  authHeaders: async () => ({}),
};

afterEach(() => {
  setPlatformHostForTests(null);
  vi.restoreAllMocks();
});

function withStorage<T>(value: unknown, run: () => Promise<T>): Promise<T> {
  const original = navigator.storage;
  Object.defineProperty(navigator, 'storage', { value, configurable: true });
  return run().finally(() => {
    Object.defineProperty(navigator, 'storage', { value: original, configurable: true });
  });
}

describe('fetchVocalModelBytesInBrowser (tanpa OPFS)', () => {
  it('fetch dari URL resolve HuggingFace di katalog dan menolak unduhan yang terpotong', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array(10), { status: 200 }),
    );
    await withStorage(undefined, async () => {
      await expect(fetchVocalModelBytesInBrowser(KIM, () => {})).rejects.toThrow(/tidak lengkap/);
    });
    expect(fetchSpy).toHaveBeenCalledWith('https://huggingface.co/seanghay/uvr_models/resolve/main/Kim_Vocal_2.onnx');
  });

  it('HTTP bukan 2xx → galat dengan status, bukan byte kosong', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 403 }));
    await withStorage(undefined, async () => {
      await expect(fetchVocalModelBytesInBrowser(KIM, () => {})).rejects.toThrow(/HTTP 403/);
    });
  });
});

/**
 * OPFS palsu seukuran yang dibutuhkan: satu direktori, berkas di `Map`.
 * Yang diuji adalah nama berkas (`model.fileName`), aturan cache hit (ukuran
 * cocok), dan progres per chunk saat streaming — bukan API OPFS-nya.
 */
function fakeOpfs(files: Map<string, Uint8Array>) {
  const directory = {
    async getFileHandle(name: string, opts?: { create?: boolean }) {
      if (!files.has(name)) {
        if (!opts?.create) throw new DOMException('NotFoundError', 'NotFoundError');
        files.set(name, new Uint8Array(0));
      }
      return {
        async getFile() {
          const bytes = files.get(name)!;
          return { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
        },
        async createWritable() {
          const chunks: Uint8Array[] = [];
          return {
            async write(chunk: Uint8Array) { chunks.push(chunk); },
            async close() {
              const total = chunks.reduce((n, c) => n + c.byteLength, 0);
              const out = new Uint8Array(total);
              let at = 0;
              for (const c of chunks) { out.set(c, at); at += c.byteLength; }
              files.set(name, out);
            },
            async abort() {},
          };
        },
      };
    },
    async removeEntry(name: string) { files.delete(name); },
  };
  return {
    getDirectory: async () => ({ getDirectoryHandle: async () => directory }),
    persist: async () => true,
  };
}

/** Model katalog dengan ukuran kecil supaya tes tidak mengalokasikan 64 MB. */
const TINY = { ...KIM, bytes: 6 };

describe('fetchVocalModelBytesInBrowser (OPFS)', () => {
  it('cache hit kalau berkas `fileName` ada dengan ukuran katalog — tanpa fetch', async () => {
    const files = new Map([[KIM.fileName, new Uint8Array([1, 2, 3, 4, 5, 6])]]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const progress: ScnetModelDownloadProgress[] = [];
    const result = await withStorage(fakeOpfs(files), () => fetchVocalModelBytesInBrowser(TINY, (p) => progress.push(p)));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.cacheHit).toBe(true);
    expect([...result.bytes]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(progress).toEqual([{ loaded: 6, total: 6, cacheHit: true }]);
  });

  it('ukuran cache tidak cocok → dibuang, diunduh ulang lewat stream dengan progres per chunk, disimpan sebagai `fileName`', async () => {
    const files = new Map([[KIM.fileName, new Uint8Array([9, 9])]]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
        controller.close();
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream, { status: 200 }));
    const progress: ScnetModelDownloadProgress[] = [];
    const result = await withStorage(fakeOpfs(files), () => fetchVocalModelBytesInBrowser(TINY, (p) => progress.push(p)));
    expect(result.cacheHit).toBe(false);
    expect([...result.bytes]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(progress).toEqual([
      { loaded: 3, total: 6, cacheHit: false },
      { loaded: 6, total: 6, cacheHit: false },
    ]);
    expect([...files.keys()]).toEqual(['Kim_Vocal_2.onnx']);
    expect(files.get('Kim_Vocal_2.onnx')!.byteLength).toBe(6);
  });

  it('unduhan terpotong → galat dan berkas cache dihapus', async () => {
    const files = new Map<string, Uint8Array>();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([1, 2]), { status: 200 }));
    await withStorage(fakeOpfs(files), async () => {
      await expect(fetchVocalModelBytesInBrowser(TINY, () => {})).rejects.toThrow(/tidak lengkap: 2 \/ 6/);
    });
    // Berkas terpotong tidak boleh tinggal: ukuran salah memang membuatnya
    // dibuang saat kunjungan berikutnya, tapi lebih baik tidak ada sama sekali.
    expect(files.has(KIM.fileName)).toBe(false);
  });
});

describe('prefetchVocalModelBytes', () => {
  it('host tanpa modelBytes → null: worker mengambil sendiri', async () => {
    setPlatformHostForTests(baseHost);
    expect(await prefetchVocalModelBytes('kim-vocal-2', () => {})).toBeNull();
  });

  it('host dengan modelBytes → byte dari host, dengan progres yang diteruskan', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const modelBytes = vi.fn(async (_id: string, onProgress: (p: ScnetModelDownloadProgress) => void) => {
      onProgress({ loaded: 3, total: 3, cacheHit: true });
      return { bytes, cacheHit: true };
    });
    setPlatformHostForTests({ ...baseHost, modelBytes });
    const progress: ScnetModelDownloadProgress[] = [];
    expect(await prefetchVocalModelBytes('kim-vocal-2', (p) => progress.push(p))).toBe(bytes);
    expect(modelBytes).toHaveBeenCalledWith('kim-vocal-2', expect.any(Function));
    expect(progress).toEqual([{ loaded: 3, total: 3, cacheHit: true }]);
  });
});
