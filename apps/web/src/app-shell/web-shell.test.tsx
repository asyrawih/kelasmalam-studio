/**
 * Shell WEB: judul dokumen, penjaga `beforeunload`, gerbang login, dan login
 * lewat adapter platform.
 *
 * Dulu ini separuh dari `desktop.test.tsx` (bagian "di web (isTauri false)"
 * dan "login lewat adapter platform"). Sejak docs/25 P2 shell web tidak punya
 * satu pun cabang desktop — jadi tidak ada `@tauri-apps` yang di-mock di
 * sini, dan "tidak menyentuh API Tauri" dijaga secara statis oleh
 * `__tests__/no-desktop-leak.test.ts`, bukan lewat mock yang diam.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppShell } from './AppShell';
import { djActions } from '@kelasmalam/dj/dj/store';
import { setPlatformHostForTests, type PlatformHost } from '../platform';
import { studioActions, studioStore } from '@kelasmalam/studio/studio/store';

const SR = 48_000;
const RECT = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 900,
  bottom: 300,
  width: 900,
  height: 300,
  toJSON: () => ({}),
};

beforeEach(() => {
  Element.prototype.getBoundingClientRect = () => RECT as DOMRect;
  window.history.pushState(null, '', '/dj');
  djActions.__resetForTest();
  studioActions.__resetForTest();
  setPlatformHostForTests(null);
  act(() =>
    djActions.loadDeck('A', { assetId: 1, frames: SR * 120, name: 'LAGU A', sampleRate: SR }),
  );
});

afterEach(() => {
  cleanup();
  setPlatformHostForTests(null);
});

describe('judul dokumen', () => {
  it('mengikuti nama project + tanda kotor', () => {
    render(<AppShell />);
    const name = studioStore.getState().projectName;
    expect(document.title).toBe(`${name} — KELAS MALAM STUDIO`);
    act(() => studioActions.setMasterGain(-3));
    expect(document.title).toBe(`• ${name} — KELAS MALAM STUDIO`);
    act(() => studioActions.markSaved());
    expect(document.title).toBe(`${name} — KELAS MALAM STUDIO`);
  });
});

describe('penjaga tutup web', () => {
  it('beforeunload dicegah hanya saat kotor atau export berjalan', () => {
    render(<AppShell />);
    const fire = (): boolean => {
      const e = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    expect(fire()).toBe(false);
    act(() => studioActions.setMasterGain(-3));
    expect(fire()).toBe(true);
    act(() => studioActions.markSaved());
    expect(fire()).toBe(false);
    act(() => studioActions.setExportProgress(0.2));
    expect(fire()).toBe(true);
  });
});

describe('gerbang auth', () => {
  const api = () => ({
    me: vi.fn(async () => null),
    loginUrl: vi.fn((next: string) => `https://auth.test/google?next=${next}`),
  });

  it('/studio dengan authApi yang disuntik: gerbang tampil, sesi diperiksa sekali', async () => {
    window.history.pushState(null, '', '/studio');
    const authApi = api();
    render(<AppShell authApi={authApi} />);
    await waitFor(() => expect(screen.getByTestId('auth-guard')).toBeTruthy());
    expect(authApi.me).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('KELAS MALAM STUDIO')).toBeNull();
  });
});

/**
 * Login lewat `PlatformHost.login()`, bukan `location.href` — satu-satunya
 * jalan keluar dari WebView ada di `platform/` (`guard.test.ts`). `login`
 * OPSIONAL di host: tanpa itu tombol MASUK tidak dirender sama sekali.
 */
describe('login lewat adapter platform', () => {
  const api = () => ({
    me: vi.fn(async () => null),
    loginUrl: vi.fn((next: string) => `https://lib.test/auth/google?next=${next}`),
    base: 'https://lib.test',
  });

  function fakeHost(login?: PlatformHost['login']): PlatformHost {
    return {
      kind: 'web',
      pickSaveTarget: vi.fn(),
      openExternal: vi.fn(),
      authHeaders: async () => ({}),
      modelBytes: vi.fn(),
      // Tes ini tidak menyentuh kepustakaan; `null` = "tidak dikonfigurasi",
      // sama dengan build web tanpa VITE_LIBRARY_API.
      ...(login === undefined ? {} : { login }),
    };
  }

  it('gerbang halaman: MASUK DENGAN GOOGLE memanggil host.login dengan path saat ini', async () => {
    const login = vi.fn(() => new Promise<void>(() => {}));
    setPlatformHostForTests(fakeHost(login));
    window.history.pushState(null, '', '/studio');
    const href = window.location.href;
    const authApi = api();
    render(<AppShell authApi={authApi} />);
    fireEvent.click(await screen.findByRole('button', { name: 'MASUK DENGAN GOOGLE' }));
    expect(login).toHaveBeenCalledWith({ apiBase: 'https://lib.test', nextPath: '/studio' });
    // Shell tidak lagi membangun URL login sendiri, apalagi menavigasi.
    expect(authApi.loginUrl).not.toHaveBeenCalled();
    expect(window.location.href).toBe(href);
  });

  it('landing: MASUK menitipkan /studio sebagai tujuan pulang', async () => {
    const login = vi.fn(() => new Promise<void>(() => {}));
    setPlatformHostForTests(fakeHost(login));
    window.history.pushState(null, '', '/');
    render(<AppShell authApi={api()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'MASUK' }));
    expect(login).toHaveBeenCalledWith({ apiBase: 'https://lib.test', nextPath: '/studio' });
  });

  it('host tanpa login: tidak ada tombol MASUK di landing maupun di gerbang', async () => {
    setPlatformHostForTests(fakeHost());
    window.history.pushState(null, '', '/');
    const view = render(<AppShell authApi={api()} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole('button', { name: 'MASUK' })).toBeNull();
    view.unmount();

    window.history.pushState(null, '', '/studio');
    render(<AppShell authApi={api()} />);
    await waitFor(() => expect(screen.getByText('LOGIN DIPERLUKAN')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'MASUK DENGAN GOOGLE' })).toBeNull();
  });
});

describe('pintasan ⌘,', () => {
  it('membuka editor pintasan lewat command shell.preferences', () => {
    render(<AppShell />);
    fireEvent.keyDown(window, { code: 'Comma', metaKey: true, ctrlKey: true });
    expect(screen.getByRole('dialog', { name: 'pintasan keyboard' })).toBeTruthy();
  });
});
