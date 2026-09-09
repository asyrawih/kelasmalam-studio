/**
 * Jalur pengambilan model di BROWSER (fetch + OPFS) dan pemilihannya
 * (`prefetchModelBytes`) berdasarkan KONTRAK host, bukan platform.
 *
 * Tes fetch-nya dipindah dari `apps/web/src/platform/web.test.ts` (docs/25
 * P3): jalur ini bukan lagi milik host web, melainkan bawaan siapa pun yang
 * tidak punya `modelBytes`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setPlatformHostForTests, type PlatformHost, type ScnetModelDownloadProgress } from '@kelasmalam/platform';
import { SCNET_MODELS } from './scnet-catalog';
import { fetchModelBytesInBrowser, prefetchModelBytes } from './scnet-model';

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

describe('fetchModelBytesInBrowser (tanpa OPFS)', () => {
  it('fetch dari URL katalog dan menolak unduhan yang terpotong', async () => {
    const storage = navigator.storage;
    Object.defineProperty(navigator, 'storage', { value: undefined, configurable: true });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array(10), { status: 200 }),
    );
    try {
      await expect(fetchModelBytesInBrowser(SCNET_MODELS.base, () => {})).rejects.toThrow(/tidak lengkap/);
      expect(fetchSpy).toHaveBeenCalledWith('/models/scnet/scnet-base.onnx');
    } finally {
      Object.defineProperty(navigator, 'storage', { value: storage, configurable: true });
    }
  });
});

describe('prefetchModelBytes', () => {
  it('host tanpa modelBytes → null: worker mengambil sendiri', async () => {
    setPlatformHostForTests(baseHost);
    expect(await prefetchModelBytes('base', () => {})).toBeNull();
  });

  it('host dengan modelBytes → byte dari host, dengan progres yang diteruskan', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const modelBytes = vi.fn(async (_id: string, onProgress: (p: ScnetModelDownloadProgress) => void) => {
      onProgress({ loaded: 3, total: 3, cacheHit: true });
      return { bytes, cacheHit: true };
    });
    setPlatformHostForTests({ ...baseHost, modelBytes });
    const progress: ScnetModelDownloadProgress[] = [];
    expect(await prefetchModelBytes('large', (p) => progress.push(p))).toBe(bytes);
    expect(modelBytes).toHaveBeenCalledWith('large', expect.any(Function));
    expect(progress).toEqual([{ loaded: 3, total: 3, cacheHit: true }]);
  });
});
