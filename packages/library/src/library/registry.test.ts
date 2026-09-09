/**
 * Registry kepustakaan: dibuat malas SEKALI dari factory yang didaftarkan
 * app, `null` tanpa pendaftaran. Menggantikan tes `libraryApi` yang dulu ada
 * di `apps/web/src/platform/web.test.ts` (docs/25 P3).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLibraryApi } from './api';
import { getLibraryApi, registerLibraryApi } from './registry';

afterEach(() => registerLibraryApi(null));

describe('registerLibraryApi / getLibraryApi', () => {
  it('tanpa pendaftaran → null: dok tampil dan mengatakan kenapa kosong', () => {
    expect(getLibraryApi()).toBeNull();
  });

  it('factory dipanggil malas, sekali, dan objeknya sama tiap panggilan', () => {
    const factory = vi.fn(() => createLibraryApi('https://api.test/'));
    registerLibraryApi(factory);
    expect(factory).not.toHaveBeenCalled();
    const api = getLibraryApi();
    expect(api?.base).toBe('https://api.test');
    expect(getLibraryApi()).toBe(api);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(api?.loginUrl('/studio')).toBe('https://api.test/auth/google?next=%2Fstudio');
  });

  it('factory yang menjawab null = build tanpa backend, dan pendaftaran ulang membuang cache', () => {
    registerLibraryApi(() => null);
    expect(getLibraryApi()).toBeNull();
    const api = createLibraryApi('https://lain.test');
    registerLibraryApi(() => api);
    expect(getLibraryApi()).toBe(api);
  });
});
