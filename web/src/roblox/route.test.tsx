/**
 * Pembungkus route: kapan tombol UNGGAH boleh hidup.
 *
 * Satu aturan yang dijaga di sini dan tidak di tempat lain: **konfigurasi yang
 * ada tidak sama dengan backend yang hidup.** URL terisi + Worker mati adalah
 * keadaan paling sering saat pengembangan, dan badge yang berkata SIAP di situ
 * berbohong tepat di tempat yang paling mahal.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RobloxRoute } from './RobloxRoute';
import { robloxActions, robloxStore } from './store';
import type { Runner } from './backend/runner';
import { setPlatformHostForTests } from '../platform';
import { createDesktopHost } from '../platform/desktop';

const invoke = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null);
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
  isTauri: () => false,
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

const fakeRunner = (): Runner => ({ run: vi.fn(), idle: async () => {} });

const uploadButton = (): HTMLButtonElement =>
  screen.getByRole('button', { name: /^UNGGAH/ }) as HTMLButtonElement;

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(null);
  robloxActions.__resetForTest();
});
afterEach(cleanup);

describe('tanpa VITE_ROBLOX_API', () => {
  it('halaman persis seperti sebelum backend ada', async () => {
    render(<RobloxRoute apiBase="" />);
    await waitFor(() => expect(robloxStore.getState().backendReady).toBe(false));
    expect(uploadButton().disabled).toBe(true);
    expect(screen.getByText(/masih UI saja/i).textContent).toMatch(/UI saja/);
  });
});

describe('dengan URL terisi', () => {
  it('Worker yang tidak menjawab TIDAK dianggap siap', async () => {
    const probe = vi.fn(async () => false);
    render(<RobloxRoute apiBase="https://worker.test" makeRunner={fakeRunner} probe={probe} />);

    await waitFor(() => expect(probe).toHaveBeenCalledWith('https://worker.test'));
    expect(robloxStore.getState().backendReady).toBe(false);
    expect(uploadButton().disabled).toBe(true);
  });

  it('probe yang gagal tidak menghasilkan unhandled rejection dan tetap belum siap', async () => {
    render(
      <RobloxRoute
        apiBase="https://worker.test"
        makeRunner={fakeRunner}
        probe={async () => Promise.reject(new Error('offline'))}
      />,
    );
    await waitFor(() => expect(robloxStore.getState().backendReady).toBe(false));
    expect(uploadButton().disabled).toBe(true);
  });

  it('Worker yang menjawab membuat badge dan tombol hidup', async () => {
    render(
      <RobloxRoute
        apiBase="https://worker.test"
        makeRunner={fakeRunner}
        probe={async () => true}
      />,
    );

    await waitFor(() => expect(robloxStore.getState().backendReady).toBe(true));
    expect(screen.getByText('SIAP')).toBeDefined();
  });

  it('meninggalkan halaman mengembalikannya ke belum-tersambung', async () => {
    const { unmount } = render(
      <RobloxRoute
        apiBase="https://worker.test"
        makeRunner={fakeRunner}
        probe={async () => true}
      />,
    );
    await waitFor(() => expect(robloxStore.getState().backendReady).toBe(true));

    act(() => unmount());
    expect(robloxStore.getState().backendReady).toBe(false);
  });

  it('runner dibuat dari URL yang sama dengan yang diprobe', async () => {
    const makeRunner = vi.fn(fakeRunner);
    render(
      <RobloxRoute
        apiBase="https://worker.test/"
        makeRunner={makeRunner}
        probe={async () => true}
      />,
    );
    expect(makeRunner).toHaveBeenCalledWith('https://worker.test/');
    // Ditunggu sampai probe mendarat: janji yang selesai SESUDAH tes berakhir
    // memperbarui store di luar `act`, dan peringatannya muncul di tes lain
    // yang tidak bersalah.
    await waitFor(() => expect(robloxStore.getState().backendReady).toBe(true));
  });
});

/**
 * DESKTOP (docs/21 §3): tidak ada Worker. Kesiapan = kunci di berkas rahasia +
 * creator id; SIMPAN menaruh kunci ke berkas rahasia lalu mengosongkan kolomnya;
 * GRANT memakai command lokal (§3f, R5) — tanpa Worker, tanpa login.
 */
describe('desktop', () => {
  // Store memilih adapter dari host platform, bukan dari prop route — di app
  // keduanya satu sumber (`getPlatformHost()`); di tes host-nya ditukar.
  beforeEach(() => setPlatformHostForTests(createDesktopHost()));
  afterEach(() => setPlatformHostForTests(null));

  const table = (over: { key?: string | null; creatorId?: string } = {}) => {
    invoke.mockImplementation(async (cmd) => {
      switch (cmd) {
        case 'secret_get': return over.key === undefined ? null : over.key;
        case 'roblox_target_get': return { creatorKind: 'user', creatorId: over.creatorId ?? '', genreToDescription: true };
        case 'roblox_grant_settings_get': return { creatorKind: 'user', creatorId: over.creatorId ?? '', hasCookie: false, hasApiKey: over.key != null };
        case 'roblox_queue_list': case 'roblox_catalog_list': case 'roblox_assets_list': return [];
        case 'roblox_taxonomy_list': return { categories: [], genres: [] };
        default: return null;
      }
    });
  };

  it('tanpa kunci di berkas rahasia: badge BELUM ADA API KEY dan tombol mati dengan alasan itu', async () => {
    table({ key: null, creatorId: '123' });
    render(<RobloxRoute platform="desktop" />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('secret_get', { key: 'roblox.api_key' }));
    await waitFor(() => expect(screen.getByText('BELUM ADA API KEY')).toBeDefined());
    expect(uploadButton().disabled).toBe(true);
    expect(screen.getByText(/API key Open Cloud belum tersimpan/)).toBeDefined();
    // Tidak ada HTTP: probe Worker tidak dipanggil di desktop.
    expect(robloxStore.getState().backendReady).toBe(false);
  });

  it('kunci ada + creator id terisi dari tabel setting → SIAP', async () => {
    table({ key: 'kunci', creatorId: '123' });
    render(<RobloxRoute platform="desktop" />);
    await waitFor(() => expect(robloxStore.getState().backendReady).toBe(true));
    expect(screen.getByText('SIAP')).toBeDefined();
    expect(robloxStore.getState().target.creatorId).toBe('123');
    expect(robloxStore.getState().apiKeyStored).toBe(true);
  });

  it('SIMPAN: target ke roblox_target_set, kunci ke berkas rahasia, kolom kunci dikosongkan, lalu SIAP', async () => {
    table({ key: null, creatorId: '' });
    render(<RobloxRoute platform="desktop" />);
    await waitFor(() => expect(screen.getByText('BELUM ADA API KEY')).toBeDefined());

    fireEvent.change(screen.getByLabelText('ID user'), { target: { value: '555' } });
    fireEvent.change(screen.getByLabelText('API key Open Cloud'), { target: { value: 'rahasia' } });
    // Sesudah tersimpan, berkas rahasia menjawab ada.
    invoke.mockImplementation(async (cmd) => (cmd === 'secret_get' ? 'rahasia' : cmd === 'roblox_queue_list' || cmd === 'roblox_catalog_list' ? [] : cmd === 'roblox_taxonomy_list' ? { categories: [], genres: [] } : cmd === 'roblox_target_get' ? { creatorKind: 'user', creatorId: '555', genreToDescription: true } : null));
    fireEvent.click(screen.getByRole('button', { name: 'SIMPAN USER + API KEY' }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('secret_set', { key: 'roblox.api_key', value: 'rahasia' }));
    expect(invoke).toHaveBeenCalledWith('roblox_target_set', { creatorKind: 'user', creatorId: '555', genreToDescription: true });
    await waitFor(() => expect(robloxStore.getState().backendReady).toBe(true));
    expect(robloxStore.getState().target.apiKey).toBe('');
    expect(robloxStore.getState().apiKeyStored).toBe(true);
  });

  it('tab GRANT hidup di desktop lewat command lokal, bukan Worker', async () => {
    table({ key: 'kunci', creatorId: '123' });
    render(<RobloxRoute platform="desktop" />);
    fireEvent.click(screen.getByRole('tab', { name: 'GRANT ACCESS' }));
    expect(screen.queryByText(/belum tersedia di versi desktop/i)).toBeNull();
    expect(screen.getByRole('button', { name: /SYNC ROBLOX/ })).toBeDefined();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('roblox_assets_list', { query: '' }));
    // Pengaturan grant dibaca dari Rust; tidak ada fetch ke VITE_LIBRARY_API.
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('roblox_grant_settings_get', {}));
    expect(screen.getByText(/disimpan dalam berkas lokal/i)).toBeDefined();
  });
});
