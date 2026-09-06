/**
 * Rasa desktop (docs/20 D5): menu native → registry, judul jendela, penjaga
 * tutup. Semua API Tauri di-mock — yang diuji adalah bahwa shell memanggilnya
 * dengan benar SAAT di desktop, dan TIDAK SAMA SEKALI saat di web.
 *
 * Yang kedua bukan formalitas: `@tauri-apps/api/window` melempar di browser
 * biasa karena `window.__TAURI_INTERNALS__` tidak ada, dan satu panggilan yang
 * bocor ke jalur web berarti setiap user web mendapat error di konsol.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppShell } from './AppShell';
import { __resetMenuWarningsForTest, closeGuardReason, windowTitle } from './desktop';
import { djActions, djStore } from '../dj/store';
import { setPlatformHostForTests, type PlatformHost } from '../platform';
import { studioActions, studioStore } from '../studio/store';

type Listener = (e: { payload: unknown }) => void;
type CloseHandler = (ev: { preventDefault(): void }) => Promise<void> | void;

/**
 * `vi.hoisted` supaya objek ini sudah ada saat factory `vi.mock` dijalankan —
 * factory di-hoist ke atas seluruh import, termasuk `const` biasa.
 */
const tauri = vi.hoisted(() => ({
  desktop: false,
  listeners: new Map<string, (e: { payload: unknown }) => void>(),
  closeHandlers: [] as Array<(ev: { preventDefault(): void }) => Promise<void> | void>,
  listen: vi.fn(),
  getCurrentWindow: vi.fn(),
  setTitle: vi.fn(),
  destroy: vi.fn(),
  ask: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => tauri.desktop,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: tauri.listen,
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: tauri.getCurrentWindow,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  ask: tauri.ask,
}));

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

function installMocks(): void {
  tauri.listen.mockImplementation(async (name: string, handler: Listener) => {
    tauri.listeners.set(name, handler);
    return () => tauri.listeners.delete(name);
  });
  tauri.getCurrentWindow.mockImplementation(() => ({
    setTitle: tauri.setTitle,
    destroy: tauri.destroy,
    onCloseRequested: async (h: CloseHandler) => {
      tauri.closeHandlers.push(h);
      return () => {
        tauri.closeHandlers = tauri.closeHandlers.filter((x) => x !== h);
      };
    },
  }));
  tauri.setTitle.mockResolvedValue(undefined);
  tauri.destroy.mockResolvedValue(undefined);
}

/** Kirim satu event menu seperti yang dilakukan `menu.rs`. */
async function emitMenu(payload: unknown): Promise<void> {
  await waitFor(() => expect(tauri.listeners.has('daw://menu-command')).toBe(true));
  await act(async () => {
    tauri.listeners.get('daw://menu-command')?.({ payload });
  });
}

/** Simulasikan user menekan tombol tutup jendela. */
async function requestClose(): Promise<{ prevented: boolean }> {
  await waitFor(() => expect(tauri.closeHandlers.length).toBeGreaterThan(0));
  let prevented = false;
  const ev = {
    preventDefault: () => {
      prevented = true;
    },
  };
  await act(async () => {
    for (const h of tauri.closeHandlers) await h(ev);
  });
  return { prevented };
}

beforeEach(() => {
  Element.prototype.getBoundingClientRect = () => RECT as DOMRect;
  window.history.pushState(null, '', '/dj');
  djActions.__resetForTest();
  studioActions.__resetForTest();
  __resetMenuWarningsForTest();
  tauri.desktop = true;
  // Host platform di-cache sekali per proses; tiap tes memilih ulang supaya
  // `tauri.desktop` yang diubah di describe benar-benar menentukan host-nya.
  setPlatformHostForTests(null);
  tauri.listeners.clear();
  tauri.closeHandlers = [];
  vi.clearAllMocks();
  installMocks();
  act(() =>
    djActions.loadDeck('A', { assetId: 1, frames: SR * 120, name: 'LAGU A', sampleRate: SR }),
  );
});

afterEach(cleanup);

describe('windowTitle', () => {
  it('nama project — aplikasi, dengan • di depan saat kotor', () => {
    expect(windowTitle('NEON_DRIFT.STUDIO', false)).toBe('NEON_DRIFT.STUDIO — KELAS MALAM STUDIO');
    expect(windowTitle('NEON_DRIFT.STUDIO', true)).toBe('• NEON_DRIFT.STUDIO — KELAS MALAM STUDIO');
  });

  it('nama kosong tidak menghasilkan judul yang dimulai dengan tanda pisah', () => {
    expect(windowTitle('   ', false)).toBe('Tanpa nama — KELAS MALAM STUDIO');
  });
});

describe('closeGuardReason', () => {
  it('export menang atas kotor — pesannya harus menyebut berkas yang terpotong', () => {
    expect(closeGuardReason({ exportProgress: 0.4, dirty: true })).toBe('export');
    expect(closeGuardReason({ exportProgress: null, dirty: true })).toBe('dirty');
    expect(closeGuardReason({ exportProgress: null, dirty: false })).toBeNull();
  });
});

describe('di web (isTauri false)', () => {
  beforeEach(() => {
    tauri.desktop = false;
  });

  it('tidak menyentuh satu pun API Tauri', async () => {
    render(<AppShell />);
    // Beri kesempatan pada impor dinamis yang (seharusnya tidak) terjadi.
    await act(async () => {
      await Promise.resolve();
    });
    expect(tauri.listen).not.toHaveBeenCalled();
    expect(tauri.getCurrentWindow).not.toHaveBeenCalled();
    expect(tauri.ask).not.toHaveBeenCalled();
  });

  it('document.title tetap mengikuti nama project + tanda kotor', () => {
    render(<AppShell />);
    const name = studioStore.getState().projectName;
    expect(document.title).toBe(`${name} — KELAS MALAM STUDIO`);
    act(() => studioActions.setMasterGain(-3));
    expect(document.title).toBe(`• ${name} — KELAS MALAM STUDIO`);
    act(() => studioActions.markSaved());
    expect(document.title).toBe(`${name} — KELAS MALAM STUDIO`);
  });

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

describe('menu native → registry', () => {
  it('event daw://menu-command menjalankan command yang sama dengan keyboard', async () => {
    render(<AppShell />);
    await emitMenu({ id: 'dj.deckA.playPause' });
    expect(djStore.getState().decks.A.playing).toBe(true);
  });

  it('id yang tidak terdaftar di halaman ini → warn SEKALI, bukan throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<AppShell />);
    await emitMenu({ id: 'roblox.kosongkan' });
    await emitMenu({ id: 'roblox.kosongkan' });
    const hits = warn.mock.calls.filter((c) => String(c[0]).includes('roblox.kosongkan'));
    expect(hits).toHaveLength(1);
    warn.mockRestore();
  });

  it('payload yang bentuknya salah diabaikan dengan peringatan', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<AppShell />);
    await emitMenu('dj.deckA.playPause');
    expect(djStore.getState().decks.A.playing).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('shell.preferences dari menu membuka editor pintasan', async () => {
    render(<AppShell />);
    await emitMenu({ id: 'shell.preferences' });
    expect(screen.getByRole('dialog', { name: 'pintasan keyboard' })).toBeTruthy();
  });

  it('listener dilepas saat shell unmount', async () => {
    const { unmount } = render(<AppShell />);
    await waitFor(() => expect(tauri.listeners.has('daw://menu-command')).toBe(true));
    unmount();
    expect(tauri.listeners.has('daw://menu-command')).toBe(false);
  });
});

/**
 * Menu Studio (File/Edit/Transport di `menu.rs`) menyasar command yang
 * didaftarkan `/studio`. Yang dibuktikan: id yang dikirim menu mengubah state
 * transport dan riwayat yang sama dengan tombol di layar dan keyboard.
 */
describe('menu native → Studio', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/studio');
  });

  it('studio.transport.playPause dan .stop mengubah transport', async () => {
    render(<AppShell />);
    expect(studioStore.getState().playing).toBe(false);
    await emitMenu({ id: 'studio.transport.playPause' });
    expect(studioStore.getState().playing).toBe(true);
    await emitMenu({ id: 'studio.transport.stop' });
    expect(studioStore.getState().playing).toBe(false);
    // Berhenti IDEMPOTEN: dari menu, berhenti dua kali tetap berhenti.
    await emitMenu({ id: 'studio.transport.stop' });
    expect(studioStore.getState().playing).toBe(false);
  });

  it('studio.undo sesudah satu edit mengembalikan state; studio.redo mengulanginya', async () => {
    render(<AppShell />);
    const before = studioStore.getState().masterGainDb;
    act(() => studioActions.setMasterGain(before - 6));
    await emitMenu({ id: 'studio.undo' });
    expect(studioStore.getState().masterGainDb).toBe(before);
    await emitMenu({ id: 'studio.redo' });
    expect(studioStore.getState().masterGainDb).toBe(before - 6);
  });

  it('studio.transport.toStart / toEnd / loop.toggle', async () => {
    render(<AppShell />);
    await emitMenu({ id: 'studio.transport.toEnd' });
    expect(studioStore.getState().playhead).toBe(studioStore.getState().duration);
    await emitMenu({ id: 'studio.transport.toStart' });
    expect(studioStore.getState().playhead).toBe(0);
    const loop = studioStore.getState().loop;
    await emitMenu({ id: 'studio.loop.toggle' });
    expect(studioStore.getState().loop).toBe(!loop);
  });

  it('studio.export.open membuka panel EXPORT — dan tetap terbuka kalau dipanggil lagi', async () => {
    render(<AppShell />);
    await emitMenu({ id: 'studio.export.open' });
    expect(studioStore.getState().openMenu).toBe('export');
    expect(
      document.querySelector('[data-menu-button="export"]')?.getAttribute('aria-expanded'),
    ).toBe('true');
    await emitMenu({ id: 'studio.export.open' });
    expect(studioStore.getState().openMenu).toBe('export');
  });

  it('studio.project.save membuka dok kepustakaan', async () => {
    render(<AppShell />);
    const dock = screen.getByTestId('library-dock');
    expect(within(dock).getByRole('button', { name: 'buka kepustakaan' })).toBeTruthy();
    await emitMenu({ id: 'studio.project.save' });
    expect(within(dock).getByRole('button', { name: 'tutup kepustakaan' })).toBeTruthy();
  });

  /**
   * Menu native tidak tahu keadaan `enabled` — item Undo selalu bisa diklik.
   * Undo tanpa riwayat karena itu keadaan normal, bukan "id tidak terdaftar",
   * dan tidak boleh mengotori konsol dengan peringatan kontrak putus.
   */
  it('command terdaftar yang sedang tidak bisa dijalankan diabaikan TANPA peringatan', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<AppShell />);
    await emitMenu({ id: 'studio.undo' });
    const hits = warn.mock.calls.filter((c) => String(c[0]).includes('studio.undo'));
    expect(hits).toHaveLength(0);
    warn.mockRestore();
  });
});

describe('judul jendela', () => {
  it('mengikuti nama project, dan bertanda • saat ada perubahan belum disimpan', async () => {
    render(<AppShell />);
    const name = studioStore.getState().projectName;
    await waitFor(() => expect(tauri.setTitle).toHaveBeenCalledWith(`${name} — KELAS MALAM STUDIO`));

    act(() => studioActions.setMasterGain(-3));
    await waitFor(() =>
      expect(tauri.setTitle).toHaveBeenLastCalledWith(`• ${name} — KELAS MALAM STUDIO`),
    );

    act(() => studioActions.markSaved());
    await waitFor(() =>
      expect(tauri.setTitle).toHaveBeenLastCalledWith(`${name} — KELAS MALAM STUDIO`),
    );
  });

  it('nama project baru (buka project) langsung tampil, dan project yang baru dibuka itu bersih', async () => {
    render(<AppShell />);
    act(() => studioActions.setMasterGain(-3));
    act(() => studioActions.hydrate({ projectName: 'LAGU BARU' }));
    await waitFor(() =>
      expect(tauri.setTitle).toHaveBeenLastCalledWith('LAGU BARU — KELAS MALAM STUDIO'),
    );
  });

  /**
   * Undo tetap mengotori. Yang tersimpan adalah bentuk SESUDAH edit; kembali
   * ke bentuk sebelumnya berarti berbeda dari yang tersimpan.
   */
  it('undo sesudah simpan membuat project kotor lagi', () => {
    render(<AppShell />);
    act(() => studioActions.setMasterGain(-3));
    act(() => studioActions.markSaved());
    expect(document.title.startsWith('•')).toBe(false);
    act(() => {
      studioActions.undo();
    });
    expect(document.title.startsWith('•')).toBe(true);
  });

  it('markSaved dengan serial lama tidak membersihkan edit yang datang sesudahnya', () => {
    render(<AppShell />);
    const serial = studioStore.getState().projectSerial;
    act(() => studioActions.setMasterGain(-3));
    act(() => studioActions.markSaved(serial));
    expect(document.title.startsWith('•')).toBe(true);
  });
});

describe('penjaga tutup jendela', () => {
  it('bersih → tidak dicegah, tidak ada dialog', async () => {
    render(<AppShell />);
    const { prevented } = await requestClose();
    expect(prevented).toBe(false);
    expect(tauri.ask).not.toHaveBeenCalled();
    expect(tauri.destroy).not.toHaveBeenCalled();
  });

  it('kotor → dicegah, ditanya; setuju → jendela dihancurkan', async () => {
    tauri.ask.mockResolvedValue(true);
    render(<AppShell />);
    act(() => studioActions.setMasterGain(-3));
    const { prevented } = await requestClose();
    expect(prevented).toBe(true);
    expect(tauri.ask).toHaveBeenCalledTimes(1);
    expect(String(tauri.ask.mock.calls[0]?.[0])).toContain('belum disimpan');
    expect(tauri.destroy).toHaveBeenCalledTimes(1);
  });

  it('kotor → ditanya; batal → jendela tetap hidup', async () => {
    tauri.ask.mockResolvedValue(false);
    render(<AppShell />);
    act(() => studioActions.setMasterGain(-3));
    const { prevented } = await requestClose();
    expect(prevented).toBe(true);
    expect(tauri.destroy).not.toHaveBeenCalled();
  });

  it('export berjalan → dicegah walau project bersih, dan pesannya soal export', async () => {
    tauri.ask.mockResolvedValue(false);
    render(<AppShell />);
    act(() => studioActions.setExportProgress(0.5));
    const { prevented } = await requestClose();
    expect(prevented).toBe(true);
    expect(String(tauri.ask.mock.calls[0]?.[0])).toContain('Export');
    expect(tauri.destroy).not.toHaveBeenCalled();
  });

  it('keadaan dibaca SAAT permintaan datang, bukan saat penjaga dipasang', async () => {
    tauri.ask.mockResolvedValue(false);
    render(<AppShell />);
    await waitFor(() => expect(tauri.closeHandlers.length).toBeGreaterThan(0));
    // Kotor sesudah penjaga terpasang → tetap dicegah.
    act(() => studioActions.setMasterGain(-3));
    expect((await requestClose()).prevented).toBe(true);
    // Disimpan → tidak lagi dicegah.
    act(() => studioActions.markSaved());
    expect((await requestClose()).prevented).toBe(false);
  });

  it('dialog yang gagal tidak mengurung user: jendela ditutup', async () => {
    tauri.ask.mockRejectedValue(new Error('plugin dialog tidak terpasang'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<AppShell />);
    act(() => studioActions.setMasterGain(-3));
    await requestClose();
    expect(tauri.destroy).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('beforeunload TIDAK dipasang di desktop — satu penjaga per platform', () => {
    render(<AppShell />);
    act(() => studioActions.setMasterGain(-3));
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });
});

/**
 * DESKTOP TANPA LOGIN. Di produksi web, `authRequired` mengunci /studio, /dj,
 * /roblox di balik sesi Google. Di jendela Tauri cookie sesi tidak pernah ikut
 * (origin `tauri://`), jadi tanpa pengecualian ini seluruh .app terkunci di
 * balik tombol MASUK yang menavigasi WebView ke Google tanpa jalan pulang.
 */
describe('gerbang auth di desktop', () => {
  const api = () => ({
    me: vi.fn(async () => null),
    loginUrl: vi.fn((next: string) => `https://auth.test/google?next=${next}`),
  });

  it('/studio terbuka langsung tanpa login, dan tidak ada navigasi keluar', async () => {
    window.history.pushState(null, '', '/studio');
    const authApi = api();
    const href = window.location.href;
    // `authApi` disuntikkan = di web ini berarti `authRequired` TRUE.
    render(<AppShell authApi={authApi} />);
    expect(screen.queryByTestId('auth-guard')).toBeNull();
    expect(screen.getByText('KELAS MALAM STUDIO')).toBeTruthy();
    await act(async () => {
      await Promise.resolve();
    });
    expect(authApi.me).not.toHaveBeenCalled();
    expect(authApi.loginUrl).not.toHaveBeenCalled();
    expect(window.location.href).toBe(href);
  });

  it('/dj dan /roblox juga terbuka', () => {
    window.history.pushState(null, '', '/dj');
    const view = render(<AppShell authApi={api()} />);
    expect(screen.queryByTestId('auth-guard')).toBeNull();
    expect(screen.getByText('KELAS MALAM DJ')).toBeTruthy();
    view.unmount();

    window.history.pushState(null, '', '/roblox');
    render(<AppShell authApi={api()} />);
    expect(screen.queryByTestId('auth-guard')).toBeNull();
  });

  it('landing di desktop tidak menampilkan tombol MASUK, tautan aplikasi terbuka', () => {
    window.history.pushState(null, '', '/');
    render(<AppShell authApi={api()} />);
    expect(screen.queryByRole('button', { name: 'MASUK' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'BUKA STUDIO' }).length).toBeGreaterThan(0);
  });

  it('di web (isTauri false) gerbangnya tetap ada — perilaku web tidak berubah', async () => {
    tauri.desktop = false;
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
      ...(login === undefined ? {} : { login }),
    };
  }

  beforeEach(() => {
    tauri.desktop = false;
  });
  afterEach(() => setPlatformHostForTests(null));

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
