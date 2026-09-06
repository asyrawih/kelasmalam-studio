/**
 * Model + store + klien kepustakaan, tanpa React.
 *
 * Yang dijaga di sini adalah tiga keputusan yang mudah dibalik tanpa sadar
 * merusaknya: `frames: 0` berarti TIDAK TAHU (bukan nol detik), 401 dari `/me`
 * adalah JAWABAN (bukan kegagalan), dan `loaded` bertahan melewati logout.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn(async (_cmd: string, _args?: unknown, _opts?: unknown): Promise<unknown> => null);
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown, opts?: unknown) => invoke(cmd, args, opts),
  isTauri: () => false,
}));

import { createLibraryApi, LibraryError, normalizeBase, VersionConflict, type LibraryApi } from './api';
import { createLocalLibraryApi } from './local-api';
import { formatBytes, formatDuration, summarize, type LibraryTrack, type LibraryUser } from './model';
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

// ── Suite KONTRAK: satu daftar janji, DUA implementasi ─────────────────────

/**
 * Janji `LibraryApi` yang harus dipenuhi klien Worker DAN kepustakaan lokal
 * (docs/21 §2d). Tiap tes ditulis sekali dan dijalankan untuk keduanya;
 * yang berbeda hanya cara backend-nya diskrip — `fetch` yang dijawab
 * `Response`, atau `invoke` yang dijawab nilai. Kalau salah satu implementasi
 * berhenti memenuhi kontrak, tes yang gagal menyebut implementasi mana.
 */

type Step = { readonly kind: 'ok'; readonly value: unknown } | { readonly kind: 'fail'; readonly value: unknown };

/** Skrip jawaban backend, satu per langkah, FIFO. Nama-namanya bahasa kontrak, bukan transport. */
interface Given {
  user(user: LibraryUser): void;
  tracks(list: readonly LibraryTrack[]): void;
  blob(bytes: Uint8Array): void;
  has(exists: boolean): void;
  ok(): void;
  projects(list: readonly { id: string; name: string; updatedAt: number; version: number }[]): void;
  project(body: { id: string; name: string; json: unknown; version: number; tracks: readonly string[] }): void;
  created(id: string, version: number): void;
  updated(version: number): void;
  conflict(currentVersion: number, message: string): void;
  removed(deletedFromLibrary: boolean): void;
  error(code: string, message: string): void;
}

interface Backend {
  readonly name: string;
  setup(): void;
  teardown(): void;
  api(): LibraryApi;
  readonly given: Given;
  /** Byte yang sampai ke penyimpanan lewat `putUpload`. */
  uploaded(): readonly number[];
  /** Badan JSON permintaan terakhir yang membawa badan. */
  lastJsonBody(): unknown;
}

const okJsonRes = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** XHR palsu: `putUpload` Worker memakai XHR demi progres unggah; jsdom tidak punya jaringan. */
class FakeXhr {
  static sent: number[] = [];
  upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
  status = 200;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  open(): void {}
  setRequestHeader(): void {}
  send(body: ArrayBuffer): void {
    FakeXhr.sent.push(body.byteLength);
    queueMicrotask(() => {
      this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 1 } as ProgressEvent);
      this.onload?.();
    });
  }
}

function httpBackend(): Backend {
  const queue: Step[] = [];
  const bodies: unknown[] = [];
  const push = (value: unknown, kind: Step['kind'] = 'ok'): void => {
    queue.push({ kind, value });
  };
  const errorRes = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit = {}): Promise<Response> => {
    if (typeof init.body === 'string') bodies.push(JSON.parse(init.body));
    const step = queue.shift();
    if (step === undefined) throw new Error('skrip backend habis');
    if (step.kind === 'fail') throw step.value;
    return step.value as Response;
  });
  return {
    name: 'Worker (HTTP)',
    setup() {
      queue.length = 0;
      bodies.length = 0;
      FakeXhr.sent = [];
      vi.stubGlobal('XMLHttpRequest', FakeXhr);
    },
    teardown() {
      vi.unstubAllGlobals();
    },
    api: () => createLibraryApi('https://api.test', fetchImpl as unknown as typeof fetch, async () => ({})),
    given: {
      user: (u) => push(okJsonRes(u)),
      tracks: (list) => push(okJsonRes({ tracks: list })),
      blob: (bytes) =>
        push(
          new Response(bytes as unknown as BodyInit, {
            status: 200,
            headers: { 'content-length': String(bytes.byteLength) },
          }),
        ),
      has: (exists) => push(okJsonRes({ exists, uploadUrl: exists ? null : 'https://r2.test/put' })),
      ok: () => push(okJsonRes({})),
      projects: (list) => push(okJsonRes({ projects: list })),
      project: (body) => push(okJsonRes(body)),
      created: (id, version) => push(okJsonRes({ id, version })),
      updated: (version) => push(okJsonRes({ version })),
      conflict: (currentVersion, message) => push(errorRes(412, { code: 'VERSI_BASI', message, currentVersion })),
      removed: (deletedFromLibrary) => push(okJsonRes({ deletedFromLibrary })),
      error: (code, message) => push(errorRes(409, { code, message })),
    },
    uploaded: () => FakeXhr.sent,
    lastJsonBody: () => bodies[bodies.length - 1],
  };
}

function localBackend(): Backend {
  const queue: Step[] = [];
  const push = (value: unknown, kind: Step['kind'] = 'ok'): void => {
    queue.push({ kind, value });
  };
  const uploaded: number[] = [];
  let lastArgs: unknown;
  return {
    name: 'lokal (Tauri)',
    setup() {
      queue.length = 0;
      uploaded.length = 0;
      invoke.mockReset();
      invoke.mockImplementation(async (cmd, args) => {
        if (cmd === 'library_put_bytes') {
          uploaded.push((args as Uint8Array).byteLength);
          return null;
        }
        lastArgs = args;
        const step = queue.shift();
        if (step === undefined) throw new Error(`skrip backend habis di ${cmd}`);
        if (step.kind === 'fail') throw step.value;
        return step.value;
      });
    },
    teardown() {
      invoke.mockReset();
      invoke.mockResolvedValue(null);
    },
    api: () => createLocalLibraryApi(),
    given: {
      // `me()` lokal tidak bertanya ke siapa pun — tidak ada langkah yang dikonsumsi.
      user: () => {},
      tracks: (list) => push(list.map((t) => ({ ...t, createdAt: 1 }))),
      blob: (bytes) => push(bytes),
      has: (exists) => push(exists),
      ok: () => push(null),
      projects: (list) => push(list),
      project: (body) => push({ ...body, updatedAt: 1 }),
      created: (id, version) => push({ id, version }),
      updated: (version) => push(version),
      conflict: (currentVersion, message) => push({ code: 'VERSION_CONFLICT', message, currentVersion }, 'fail'),
      removed: (deletedFromLibrary) => push(deletedFromLibrary),
      error: (code, message) => push({ code, message }, 'fail'),
    },
    uploaded: () => uploaded,
    lastJsonBody: () => lastArgs,
  };
}

const USER: LibraryUser = { id: 'u1', email: 'a@test', name: 'Ana' };
const META = { hash: HASH, name: 'Lagu', bytes: 2048, mime: 'audio/mpeg', frames: 480, sampleRate: 48_000 };

describe.each([httpBackend(), localBackend()])('kontrak LibraryApi — $name', (backend) => {
  beforeEach(() => backend.setup());
  afterEach(() => backend.teardown());

  it('me() memberi pemilik kepustakaan dengan id dan nama', async () => {
    backend.given.user(USER);
    const me = await backend.api().me();
    expect(me).not.toBeNull();
    expect(typeof me?.id).toBe('string');
    expect(me?.name.length).toBeGreaterThan(0);
  });

  it('tracks() mempertahankan frames dan marks apa adanya', async () => {
    backend.given.tracks([track({ frames: 0, marks: { cues: { cuePoint: 3 } } })]);
    const list = await backend.api().tracks();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ hash: HASH, frames: 0, marks: { cues: { cuePoint: 3 } } });
  });

  it('blob() memberi byte-nya dan progresnya berakhir di 100', async () => {
    backend.given.blob(new Uint8Array([1, 2, 3, 4]));
    const seen: number[] = [];
    const out = await backend.api().blob(HASH, (p) => seen.push(p));
    expect(out.byteLength).toBe(4);
    expect(seen[seen.length - 1]).toBe(100);
  });

  it('initTrack: sudah ada → tidak ada alamat unggah; belum → ada', async () => {
    backend.given.has(true);
    await expect(backend.api().initTrack(META)).resolves.toEqual({ exists: true, uploadUrl: null });
    backend.given.has(false);
    const init = await backend.api().initTrack(META);
    expect(init.exists).toBe(false);
    expect(typeof init.uploadUrl).toBe('string');
  });

  it('putUpload lalu commitTrack: byte-nya sampai SEKALI, utuh', async () => {
    backend.given.has(false);
    const api = backend.api();
    const init = await api.initTrack(META);
    const seen: number[] = [];
    await api.putUpload(init.uploadUrl!, new ArrayBuffer(2048), 'audio/mpeg', (p) => seen.push(p));
    expect(backend.uploaded()).toEqual([2048]);
    expect(seen[seen.length - 1]).toBe(100);
    backend.given.ok();
    await expect(api.commitTrack(META)).resolves.toBeUndefined();
  });

  it('projects() dan project(id) memberi bentuk yang sama', async () => {
    backend.given.projects([{ id: 'p1', name: 'Mix', updatedAt: 5, version: 2 }]);
    await expect(backend.api().projects()).resolves.toEqual([{ id: 'p1', name: 'Mix', updatedAt: 5, version: 2 }]);
    backend.given.project({ id: 'p1', name: 'Mix', json: { lanes: [] }, version: 2, tracks: [HASH] });
    const body = await backend.api().project('p1');
    expect(body).toMatchObject({ id: 'p1', name: 'Mix', json: { lanes: [] }, version: 2, tracks: [HASH] });
  });

  it('createProject memberi id + versi; updateProject memberi versi baru', async () => {
    backend.given.created('p9', 1);
    await expect(backend.api().createProject('Mix', { a: 1 })).resolves.toEqual({ id: 'p9', version: 1 });
    backend.given.updated(2);
    await expect(backend.api().updateProject('p9', 'Mix', { a: 2 }, 1)).resolves.toBe(2);
  });

  it('kalah versi → VersionConflict yang membawa versi sekarang, bukan LibraryError', async () => {
    backend.given.conflict(5, 'project ini sudah berubah di tempat lain');
    const err = await backend.api().updateProject('p9', 'Mix', {}, 3).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VersionConflict);
    expect((err as VersionConflict).name).toBe('VersionConflict');
    expect((err as VersionConflict).currentVersion).toBe(5);
    expect((err as Error).message).toMatch(/sudah berubah/);
  });

  it('hapus lagu yang masih dipakai → LibraryError yang MENYEBUT project-nya', async () => {
    backend.given.error('IN_USE', 'masih dipakai project Mix Malam');
    const err = await backend.api().deleteTrack(HASH).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LibraryError);
    expect((err as LibraryError).code).toBe('IN_USE');
    expect((err as Error).message).toContain('Mix Malam');
  });

  it('galat lain membawa kode dan pesan backend apa adanya', async () => {
    backend.given.error('DISK_FULL', 'kepustakaan penuh');
    const err = await backend.api().tracks().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LibraryError);
    expect(err).toMatchObject({ code: 'DISK_FULL', message: 'kepustakaan penuh' });
  });

  it('removeProjectTrack menjawab apakah lagunya ikut hilang dari kepustakaan', async () => {
    backend.given.removed(true);
    await expect(backend.api().removeProjectTrack('p1', HASH)).resolves.toBe(true);
    backend.given.removed(false);
    await expect(backend.api().removeProjectTrack('p1', HASH)).resolves.toBe(false);
  });

  it('putMarks mengirim keadaan LENGKAP, bukan tambalan', async () => {
    backend.given.ok();
    const marks = { cues: { cuePoint: 1 }, grid: { bpm: 120, offsetSec: 0, lock: true } };
    await backend.api().putMarks(HASH, marks);
    expect(JSON.stringify(backend.lastJsonBody())).toContain(JSON.stringify(marks));
  });

  it('addProjectTrack dan deleteProject selesai tanpa isi', async () => {
    backend.given.ok();
    await expect(backend.api().addProjectTrack('p1', HASH)).resolves.toBeUndefined();
    backend.given.ok();
    await expect(backend.api().deleteProject('p1')).resolves.toBeUndefined();
  });
});
