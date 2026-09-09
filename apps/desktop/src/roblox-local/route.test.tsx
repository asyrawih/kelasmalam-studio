/**
 * `RobloxRoute` dengan backend DESKTOP yang disuntik (docs/21 §3, docs/25 §1c):
 * tidak ada Worker. Kesiapan = kunci di berkas rahasia + creator id; SIMPAN
 * menaruh kunci ke berkas rahasia lalu mengosongkan kolomnya; GRANT memakai
 * command lokal (§3f, R5) — tanpa Worker, tanpa login.
 *
 * Dulu describe `desktop` di `apps/web/src/roblox/route.test.tsx` dengan
 * `setPlatformHostForTests(createDesktopHost())`; kini route tidak melihat
 * host sama sekali — yang ia lihat adalah `RobloxBackend` yang di app
 * didaftarkan `main.tsx` dan di sini disuntik lewat prop `backend`, plus
 * penyimpanan antrean lokal yang didaftarkan ke store.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDesktopRobloxBackend } from './backend';
import { createLocalQueuePersistence } from './queue-persistence';
import { RobloxRoute } from '@kelasmalam/roblox/roblox/RobloxRoute';
import { registerRobloxPersistence, robloxActions, robloxStore } from '@kelasmalam/roblox/roblox/store';

const invoke = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null);
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

const uploadButton = (): HTMLButtonElement =>
  screen.getByRole('button', { name: /^UNGGAH/ }) as HTMLButtonElement;

const table = (over: { key?: string | null; creatorId?: string } = {}): void => {
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

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(null);
  registerRobloxPersistence(createLocalQueuePersistence);
  robloxActions.__resetForTest();
});
afterEach(() => {
  cleanup();
  registerRobloxPersistence(null);
});

const mount = (): ReturnType<typeof render> => render(<RobloxRoute backend={createDesktopRobloxBackend()} />);

describe('desktop', () => {
  it('tanpa kunci di berkas rahasia: badge BELUM ADA API KEY dan tombol mati dengan alasan itu', async () => {
    table({ key: null, creatorId: '123' });
    mount();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('secret_get', { key: 'roblox.api_key' }));
    await waitFor(() => expect(screen.getByText('BELUM ADA API KEY')).toBeDefined());
    expect(uploadButton().disabled).toBe(true);
    expect(screen.getByText(/API key Open Cloud belum tersimpan/)).toBeDefined();
    // Tidak ada HTTP: probe Worker tidak dipanggil di desktop.
    expect(robloxStore.getState().backendReady).toBe(false);
  });

  it('kunci ada + creator id terisi dari tabel setting → SIAP', async () => {
    table({ key: 'kunci', creatorId: '123' });
    mount();
    await waitFor(() => expect(robloxStore.getState().backendReady).toBe(true));
    expect(screen.getByText('SIAP')).toBeDefined();
    expect(robloxStore.getState().target.creatorId).toBe('123');
    expect(robloxStore.getState().apiKeyStored).toBe(true);
  });

  it('SIMPAN: target ke roblox_target_set, kunci ke berkas rahasia, kolom kunci dikosongkan, lalu SIAP', async () => {
    table({ key: null, creatorId: '' });
    mount();
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
    mount();
    fireEvent.click(screen.getByRole('tab', { name: 'GRANT ACCESS' }));
    expect(screen.queryByText(/belum tersedia di versi desktop/i)).toBeNull();
    expect(screen.getByRole('button', { name: /SYNC ROBLOX/ })).toBeDefined();
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('roblox_assets_list', { query: '' }));
    // Pengaturan grant dibaca dari Rust; tidak ada fetch ke VITE_LIBRARY_API.
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('roblox_grant_settings_get', {}));
    expect(screen.getByText(/disimpan dalam berkas lokal/i)).toBeDefined();
  });

  it('teks UI mengikuti backend: platform desktop tanpa prop platform', async () => {
    table({ key: 'kunci', creatorId: '123' });
    mount();
    // Badge kuota desktop ("KUOTA —") datang dari `platform === 'desktop'` di
    // header — dan itu dibaca dari `backend.platform`, bukan dari prop.
    await waitFor(() => expect(robloxStore.getState().backendReady).toBe(true));
    expect(screen.getByText(/KUOTA —/)).toBeDefined();
  });
});
