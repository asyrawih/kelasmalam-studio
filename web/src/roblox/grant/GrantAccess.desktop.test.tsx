/**
 * Tab GRANT ACCESS di DESKTOP: formulir yang sama dengan web, di atas
 * `createLocalGrantApi()` dengan `invoke` di-mock. Yang dijaga: daftar
 * datang dari `roblox_assets_list`, GRANT memanggil `roblox_grant` tanpa
 * API key di argumen, dan SIMPAN menaruh cookie ke berkas rahasia lalu
 * mengosongkan kolomnya.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GrantAccess } from './GrantAccess';
import { createLocalGrantApi } from './local-api';
import { robloxActions, robloxStore } from '../store';

const invoke = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null);
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
  isTauri: () => true,
}));

const target = { creatorKind: 'user' as const, creatorId: '123', apiKey: '', genreToDescription: true };

function table(over: { hasApiKey?: boolean; hasCookie?: boolean } = {}): void {
  invoke.mockImplementation(async (cmd) => {
    switch (cmd) {
      case 'roblox_grant_settings_get':
        return { creatorKind: 'user', creatorId: '123', hasCookie: over.hasCookie ?? false, hasApiKey: over.hasApiKey ?? true };
      case 'roblox_target_get':
        return { creatorKind: 'user', creatorId: '123', genreToDescription: true };
      case 'roblox_assets_list':
        return [
          { assetId: '9876', creatorKind: 'user', creatorId: '123', name: 'Audio Lama', moderationState: null, source: 'import' },
          { assetId: '5555', creatorKind: 'user', creatorId: '123', name: 'Jingle', moderationState: 'approved', source: 'upload' },
        ];
      case 'roblox_grant': return 1;
      case 'roblox_assets_sync': return 2;
      default: return null;
    }
  });
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(null);
  robloxActions.__resetForTest();
});
afterEach(cleanup);

describe('GrantAccess di desktop', () => {
  it('merender daftar dari roblox_assets_list dan menandai kunci ada tanpa menampilkan nilainya', async () => {
    table();
    render(<GrantAccess api={createLocalGrantApi()} uploadTarget={target} uploadItems={[]} platform="desktop" />);
    await waitFor(() => expect(screen.getByText('Audio Lama')).toBeDefined());
    expect(screen.getByText('Jingle')).toBeDefined();
    expect(screen.getByText('2 asset')).toBeDefined();
    const key = screen.getByLabelText('API key Roblox untuk grant') as HTMLInputElement;
    expect(key.value).toBe('');
    expect(key.placeholder).toMatch(/sudah tersimpan di mesin ini/);
    expect(robloxStore.getState().apiKeyStored).toBe(true);
    expect(screen.queryByText(/belum tersedia di versi desktop/i)).toBeNull();
    expect(screen.queryByText(/Belum ada history/)).toBeNull();
  });

  it('GRANT memanggil roblox_grant dengan asset terpilih — tanpa API key di argumen', async () => {
    table();
    render(<GrantAccess api={createLocalGrantApi()} uploadTarget={target} uploadItems={[]} platform="desktop" />);
    await waitFor(() => expect(screen.getByText('Audio Lama')).toBeDefined());

    fireEvent.click(screen.getByLabelText(/Audio Lama/));
    fireEvent.change(screen.getByPlaceholderText('Universe ID'), { target: { value: '77' } });
    const button = screen.getByRole('button', { name: 'GRANT 1' }) as HTMLButtonElement;
    // Kunci di berkas rahasia cukup; kolom kunci boleh kosong.
    expect(button.disabled).toBe(false);
    fireEvent.click(button);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('roblox_grant', { assetIds: ['9876'], subjectType: 'Universe', subjectId: '77' }));
    const grantCall = invoke.mock.calls.find(([cmd]) => cmd === 'roblox_grant');
    expect(Object.keys(grantCall?.[1] as object)).toEqual(['assetIds', 'subjectType', 'subjectId']);
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/1 audio berhasil diberi izin Use ke Universe 77/));
  });

  it('tanpa kunci di berkas rahasia tombol GRANT mati; SIMPAN cookie → roblox_grant_cookie_set lalu kolom kosong', async () => {
    table({ hasApiKey: false });
    render(<GrantAccess api={createLocalGrantApi()} uploadTarget={target} uploadItems={[]} platform="desktop" />);
    await waitFor(() => expect(screen.getByText('Audio Lama')).toBeDefined());
    fireEvent.click(screen.getByLabelText(/Audio Lama/));
    fireEvent.change(screen.getByPlaceholderText('Universe ID'), { target: { value: '77' } });
    expect((screen.getByRole('button', { name: 'GRANT 1' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('API key Roblox untuk grant'), { target: { value: 'kunci-baru-yang-panjang' } });
    fireEvent.change(screen.getByLabelText('cookie .ROBLOSECURITY'), { target: { value: 'cookie-rahasia' } });
    // Setelah tersimpan, Rust menjawab keduanya ada.
    invoke.mockImplementation(async (cmd) => (cmd === 'roblox_grant_settings_get'
      ? { creatorKind: 'user', creatorId: '123', hasCookie: true, hasApiKey: true }
      : cmd === 'roblox_target_get' ? { creatorKind: 'user', creatorId: '123', genreToDescription: true }
        : cmd === 'roblox_assets_list' ? [] : null));
    fireEvent.click(screen.getByRole('button', { name: 'SIMPAN USER + API KEY' }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('roblox_grant_cookie_set', { cookie: 'cookie-rahasia' }));
    expect(invoke).toHaveBeenCalledWith('secret_set', { key: 'roblox.api_key', value: 'kunci-baru-yang-panjang' });
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/berkas lokal/));
    expect((screen.getByLabelText('API key Roblox untuk grant') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('cookie .ROBLOSECURITY') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('cookie .ROBLOSECURITY') as HTMLInputElement).placeholder).toMatch(/sudah tersimpan/);
    expect(robloxStore.getState().target.apiKey).toBe('');
    expect(robloxStore.getState().apiKeyStored).toBe(true);
  });

  it('SYNC ROBLOX memanggil roblox_assets_sync dan menyebut katalog lokal, bukan D1', async () => {
    table({ hasCookie: true });
    render(<GrantAccess api={createLocalGrantApi()} uploadTarget={target} uploadItems={[]} platform="desktop" />);
    await waitFor(() => expect(screen.getByText('Audio Lama')).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'SYNC ROBLOX' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('roblox_assets_sync', {}));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('2 audio disinkronkan dari Roblox ke katalog lokal'));
  });
});
