/**
 * `importUrlToLane` di WEB: tidak ada importer yang didaftarkan, jadi link
 * yang butuh server (YouTube, SoundCloud) mendapat pesan lama — unduh dulu,
 * drop berkasnya — tanpa satu pun command yang disentuh. Cabang desktop-nya
 * (importer YouTube lewat yt-dlp) diuji di `apps/desktop/src/youtube/import.test.ts`
 * dengan mendaftarkan importer sungguhan; di sini registry-nya diuji dengan
 * importer palsu.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { importUrlToLane, registerUrlImporter } from './url-to-lane';

const URL_YT = 'https://youtu.be/abc';

describe('importUrlToLane tanpa importer terdaftar (web)', () => {
  it('link YouTube: pesan lama, tidak ada fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await importUrlToLane(URL_YT, 'lane-1', 0, 48_000);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/link YouTube tidak bisa diunduh langsung dari browser/);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('link SoundCloud: pesan yang menyebut layanannya', async () => {
    const r = await importUrlToLane('https://soundcloud.com/a/b', 'lane-1', 0, 48_000);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/SoundCloud/);
  });
});

describe('registerUrlImporter', () => {
  const unregister: (() => void)[] = [];
  afterEach(() => {
    for (const un of unregister.splice(0)) un();
  });

  it('importer yang cocok dipakai SEBELUM fetch, dengan argumen apa adanya', async () => {
    const imp = vi.fn(async () => ({ ok: true as const }));
    unregister.push(
      registerUrlImporter({
        matches: (cls) => cls.kind === 'needs-server' && cls.service === 'YouTube',
        import: imp,
      }),
    );
    const r = await importUrlToLane(URL_YT, 'lane-1', 480, 48_000, { avoidOverlap: true });
    expect(r).toEqual({ ok: true });
    expect(imp).toHaveBeenCalledWith(URL_YT, 'lane-1', 480, 48_000, { avoidOverlap: true });
  });

  it('importer yang tidak cocok tidak ikut campur — host lain tetap jalur lama', async () => {
    const imp = vi.fn(async () => ({ ok: true as const }));
    unregister.push(
      registerUrlImporter({
        matches: (cls) => cls.kind === 'needs-server' && cls.service === 'YouTube',
        import: imp,
      }),
    );
    const r = await importUrlToLane('https://soundcloud.com/a/b', 'lane-1', 0, 48_000);
    expect(r.ok).toBe(false);
    expect(imp).not.toHaveBeenCalled();
  });

  it('pelepasan pendaftaran mengembalikan jalur lama', async () => {
    const imp = vi.fn(async () => ({ ok: true as const }));
    const un = registerUrlImporter({ matches: () => true, import: imp });
    un();
    const r = await importUrlToLane(URL_YT, 'lane-1', 0, 48_000);
    expect(r.ok).toBe(false);
    expect(imp).not.toHaveBeenCalled();
  });
});
