/**
 * `createLocalGrantApi` dengan `invoke` di-mock. Yang dijaga adalah pemetaan
 * ke KONTRAK — nama command dan bentuk argumen — dan dua aturan rahasia:
 * `grant` tidak membawa API key, `settings` tidak membawa nilai rahasia.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createLocalGrantApi } from './local-api';
import { GrantError } from './api';

const invoke = vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null);
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invoke(cmd, args),
  isTauri: () => true,
}));

const api = createLocalGrantApi();

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(null);
});

describe('settings', () => {
  it('membaca roblox_grant_settings_get dan TIDAK membawa nilai rahasia', async () => {
    invoke.mockResolvedValue({ creatorKind: 'group', creatorId: '42', hasCookie: true, hasApiKey: true });
    expect(await api.settings()).toEqual({
      creatorKind: 'group', creatorId: '42', apiKey: '', hasApiKey: true, hasRobloxCookie: true, robloxCookie: '',
    });
    expect(invoke).toHaveBeenCalledWith('roblox_grant_settings_get', {});
    expect(invoke).not.toHaveBeenCalledWith('secret_get', expect.anything());
  });
});

describe('saveSettings', () => {
  it('target ke roblox_target_set (opsi genre dipertahankan), kunci ke berkas rahasia, cookie ke roblox_grant_cookie_set', async () => {
    invoke.mockImplementation(async (cmd) =>
      cmd === 'roblox_target_get' ? { creatorKind: 'user', creatorId: '1', genreToDescription: false } : null);
    await api.saveSettings({ creatorKind: 'user', creatorId: ' 555 ', apiKey: ' rahasia ', robloxCookie: 'cookie' });
    expect(invoke).toHaveBeenCalledWith('roblox_target_set', { creatorKind: 'user', creatorId: '555', genreToDescription: false });
    expect(invoke).toHaveBeenCalledWith('secret_set', { key: 'roblox.api_key', value: 'rahasia' });
    expect(invoke).toHaveBeenCalledWith('roblox_grant_cookie_set', { cookie: 'cookie' });
  });

  it('kunci dan cookie kosong berarti "jangan ganti", bukan "hapus"', async () => {
    invoke.mockImplementation(async (cmd) =>
      cmd === 'roblox_target_get' ? { creatorKind: 'user', creatorId: '1', genreToDescription: true } : null);
    await api.saveSettings({ creatorKind: 'group', creatorId: '9', apiKey: '' });
    const names = invoke.mock.calls.map(([cmd]) => cmd);
    expect(names).toEqual(['roblox_target_get', 'roblox_target_set']);
  });
});

describe('katalog, experience, place', () => {
  it('sync/list/import/record memetakan 1:1 ke command', async () => {
    invoke.mockImplementation(async (cmd) => (cmd === 'roblox_assets_sync' ? 3 : cmd === 'roblox_assets_import' ? 2 : cmd === 'roblox_assets_list' ? [{ assetId: '1' }] : null));
    expect(await api.syncAssets()).toBe(3);
    expect(await api.assets('Malam')).toEqual([{ assetId: '1' }]);
    expect(invoke).toHaveBeenCalledWith('roblox_assets_list', { query: 'Malam' });
    await api.assets();
    expect(invoke).toHaveBeenLastCalledWith('roblox_assets_list', { query: '' });

    const row = { assetId: '12345', creatorKind: 'group' as const, creatorId: '99', name: 'Lagu Malam' };
    expect(await api.importAssets([row])).toBe(2);
    expect(invoke).toHaveBeenLastCalledWith('roblox_assets_import', { assets: [{ ...row, source: 'import' }] });

    await api.recordAsset({ ...row, moderationState: 'approved' });
    expect(invoke).toHaveBeenLastCalledWith('roblox_assets_record', { asset: { ...row, moderationState: 'approved', source: 'upload' } });
  });

  it('experiences dan resolvePlace', async () => {
    invoke.mockImplementation(async (cmd) => (cmd === 'roblox_experiences' ? [{ universeId: '77', placeId: '88', name: 'Klub' }] : '77'));
    expect(await api.experiences('group', '42')).toEqual([{ universeId: '77', placeId: '88', name: 'Klub' }]);
    expect(invoke).toHaveBeenCalledWith('roblox_experiences', { ownerType: 'group', ownerId: '42' });
    expect(await api.resolvePlace('88')).toBe('77');
    expect(invoke).toHaveBeenCalledWith('roblox_resolve_place', { placeId: '88' });
  });
});

describe('grant', () => {
  it('memanggil roblox_grant TANPA API key di argumen — Rust membacanya dari berkas rahasia', async () => {
    invoke.mockResolvedValue(2);
    expect(await api.grant(['123', '456'], 'Universe', '77', 'kunci-yang-tidak-boleh-lewat')).toBe(2);
    expect(invoke).toHaveBeenCalledWith('roblox_grant', { assetIds: ['123', '456'], subjectType: 'Universe', subjectId: '77' });
    expect(JSON.stringify(invoke.mock.calls)).not.toContain('kunci-yang-tidak-boleh-lewat');
  });

  it('penolakan Rust keluar sebagai GrantError dengan kalimat Rust apa adanya', async () => {
    invoke.mockRejectedValue({ code: 'HTTP', message: 'Cookie Roblox tidak valid atau kedaluwarsa', status: 401 });
    await expect(api.syncAssets()).rejects.toThrow(GrantError);
    await expect(api.syncAssets()).rejects.toThrow('Cookie Roblox tidak valid atau kedaluwarsa');
    invoke.mockRejectedValue('command grant not found');
    await expect(api.grant(['1'], 'User', '2', '')).rejects.toThrow('command grant not found');
  });
});
