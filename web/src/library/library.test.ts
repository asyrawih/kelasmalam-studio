/**
 * Model + store + klien kepustakaan, tanpa React.
 *
 * Yang dijaga di sini adalah tiga keputusan yang mudah dibalik tanpa sadar
 * merusaknya: `frames: 0` berarti TIDAK TAHU (bukan nol detik), 401 dari `/me`
 * adalah JAWABAN (bukan kegagalan), dan `loaded` bertahan melewati logout.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createLibraryApi, LibraryError, normalizeBase } from './api';
import { formatBytes, formatDuration, summarize, type LibraryTrack } from './model';
import { libraryActions, libraryStore } from './store';

const HASH = 'a'.repeat(64);
const state = () => libraryStore.getState();

const track = (over: Partial<LibraryTrack> = {}): LibraryTrack => ({
  hash: HASH,
  name: 'Lagu',
  bytes: 1024 * 1024,
  mime: 'audio/mpeg',
  frames: 48_000 * 90,
  sampleRate: 48_000,
  marks: null,
  ...over,
});

beforeEach(() => libraryActions.__resetForTest());

describe('format', () => {
  it('durasi nol berarti TIDAK TAHU, bukan nol detik', () => {
    expect(formatDuration(0, 48_000)).toBe('—');
    expect(formatDuration(48_000 * 187, 48_000)).toBe('3:07');
    // Sample rate yang hilang juga tidak boleh menghasilkan angka.
    expect(formatDuration(48_000, 0)).toBe('—');
  });

  it('ukuran memakai basis yang sama dengan server', () => {
    expect(formatBytes(20 * 1024 * 1024)).toBe('20.0 MB');
    expect(formatBytes(900)).toBe('900 B');
  });

  it('ringkasan strip menyebut jumlah dan total', () => {
    expect(summarize([])).toBe('KOSONG');
    expect(summarize([track(), track({ hash: 'b'.repeat(64) })])).toBe('2 LAGU · 2.0 MB');
  });
});

describe('store', () => {
  it('mulai terlipat dan tanpa sambungan', () => {
    expect(state().collapsed).toBe(true);
    expect(state().status).toBe('tidak-dikonfigurasi');
  });

  it('lipat/buka bergantian', () => {
    libraryActions.toggleCollapsed();
    expect(state().collapsed).toBe(false);
    libraryActions.toggleCollapsed();
    expect(state().collapsed).toBe(true);
  });

  it('progres dijepit 0..100', () => {
    libraryActions.setProgress(HASH, 140);
    expect(state().loading[HASH]).toBe(100);
    libraryActions.setProgress(HASH, -20);
    expect(state().loading[HASH]).toBe(0);
  });

  it('menandai sudah dimuat menghapus progresnya', () => {
    libraryActions.setProgress(HASH, 50);
    libraryActions.markLoaded(HASH, 3);
    expect(state().loaded[HASH]).toBe(3);
    expect(state().loading[HASH]).toBeUndefined();
  });

  it('logout TIDAK melupakan lagu yang sudah mendarat di sesi', () => {
    libraryActions.markLoaded(HASH, 3);
    libraryActions.setTracks([track()]);
    libraryActions.signedOut();

    expect(state().tracks).toEqual([]);
    expect(state().user).toBeNull();
    // Lagunya sudah jadi bagian dari sesi kerja; menariknya kembali berarti
    // timeline kehilangan audio karena user menekan tombol keluar.
    expect(state().loaded[HASH]).toBe(3);
  });

  it('menulis nilai yang sama tidak menghasilkan state baru', () => {
    libraryActions.setCollapsed(true);
    const before = state();
    libraryActions.setCollapsed(true);
    libraryActions.setListing(false);
    expect(state()).toBe(before);
  });
});

describe('klien', () => {
  const okJson = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

  it('selalu mengirim cookie — tanpa itu semuanya 401 tanpa sebab yang terbaca', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit = {}) =>
      okJson({ id: 'u1', email: 'a', name: 'A' }),
    );
    const api = createLibraryApi('https://api.test', fetchImpl as unknown as typeof fetch);
    await api.me();

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.credentials).toBe('include');
    // Web: tidak ada header sesi tambahan — bentuk permintaannya persis yang lama.
    expect(init.headers).toBeUndefined();
  });

  it('header dari platform ikut di setiap permintaan, tanpa menghilangkan cookie', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit = {}) => okJson({ tracks: [] }));
    const api = createLibraryApi('https://api.test', fetchImpl as unknown as typeof fetch, async () => ({
      authorization: 'Bearer tok',
    }));
    await api.tracks();
    await api.putMarks('a'.repeat(64), { cues: [] });
    const [, listInit] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const [, marksInit] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(listInit.credentials).toBe('include');
    expect(listInit.headers).toEqual({ authorization: 'Bearer tok' });
    // Header permintaan (content-type) dan header sesi hidup berdampingan.
    expect(marksInit.headers).toEqual({ authorization: 'Bearer tok', 'content-type': 'application/json' });
  });

  it('401 dari /me adalah JAWABAN, bukan lemparan', async () => {
    const api = createLibraryApi(
      'https://api.test',
      (async () => new Response('{}', { status: 401 })) as typeof fetch,
    );
    await expect(api.me()).resolves.toBeNull();
  });

  it('galat lain membawa pesan server apa adanya', async () => {
    const api = createLibraryApi(
      'https://api.test',
      (async () =>
        new Response(JSON.stringify({ code: 'KUOTA', message: 'kepustakaan penuh' }), {
          status: 409,
        })) as typeof fetch,
    );
    await expect(api.tracks()).rejects.toThrow('kepustakaan penuh');
    await expect(api.tracks()).rejects.toBeInstanceOf(LibraryError);
  });

  it('slash di ujung base tidak menghasilkan URL berslash ganda', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit = {}) => okJson({ tracks: [] }));
    const api = createLibraryApi('https://api.test//', fetchImpl as unknown as typeof fetch);
    await api.tracks();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.test/tracks');
    expect(normalizeBase('https://api.test///')).toBe('https://api.test');
  });

  it('URL login membawa path sekarang supaya user kembali ke tempatnya', () => {
    const api = createLibraryApi('https://api.test');
    expect(api.loginUrl('/studio')).toBe('https://api.test/auth/google?next=%2Fstudio');
  });

  it('unduhan tanpa content-length tetap jalan — yang hilang cuma bar progresnya', async () => {
    const api = createLibraryApi(
      'https://api.test',
      (async () => new Response(new Uint8Array([1, 2, 3]))) as typeof fetch,
    );
    const bytes = await api.blob(HASH, () => {});
    expect(bytes.byteLength).toBe(3);
  });

  it('melaporkan kemajuan saat panjangnya diketahui', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5));
        controller.enqueue(new Uint8Array(5));
        controller.close();
      },
    });
    const api = createLibraryApi(
      'https://api.test',
      (async () =>
        new Response(body, { headers: { 'content-length': '10' } })) as typeof fetch,
    );

    const seen: number[] = [];
    const bytes = await api.blob(HASH, (p) => seen.push(p));
    expect(bytes.byteLength).toBe(10);
    expect(seen).toEqual([50, 100]);
  });
});
