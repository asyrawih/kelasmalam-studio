/**
 * Panel PENYIMPANAN (docs/21 K3). Semua API Tauri di-mock — yang diuji:
 * angka `store_info` tampil, alur pindah folder (pilih → konfirmasi menyebut
 * ukuran → progres dari event → sukses/gagal), dan bahwa di WEB panel ini
 * tidak dirender dan tidak ada satu pun `invoke`.
 *
 * Yang terakhir bukan formalitas: `invoke` di browser biasa melempar karena
 * `__TAURI_INTERNALS__` tidak ada, dan satu panggilan yang bocor berarti
 * setiap user web yang membuka ⌘, mendapat error di konsol.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StoreInfo } from '../platform/local-commands';
import { KeymapEditor } from '../app-shell/KeymapEditor';
import { StoreSettings } from './StoreSettings';
import {
  confirmRelocateMessage,
  formatStoreBytes,
  OLD_DIR_INTACT,
  relocateFailureMessage,
  relocatePercent,
  revealLabel,
  STORE_HELP,
} from './store-settings';

type Listener = (e: { payload: unknown }) => void;

/** `vi.hoisted`: factory `vi.mock` di-hoist ke atas semua import, termasuk `const`. */
const tauri = vi.hoisted(() => ({
  desktop: false,
  invoke: vi.fn(async (_cmd: string, _args?: unknown): Promise<unknown> => null),
  listeners: new Map<string, (e: { payload: unknown }) => void>(),
  listen: vi.fn(),
  open: vi.fn(),
  reveal: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => tauri.desktop,
  invoke: (cmd: string, args?: unknown) => tauri.invoke(cmd, args),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: tauri.open }));
vi.mock('@tauri-apps/plugin-opener', () => ({ revealItemInDir: tauri.reveal }));

const INFO: StoreInfo = {
  dir: '/Users/x/Library/Application Support/kelas-malam',
  bytes: 3 * 1024 ** 3 + 512 * 1024 ** 2, // 3.5 GB
  tracks: 42,
  projects: 7,
  schemaVersion: 3,
};

const NEW_DIR = '/Volumes/Eksternal/kepustakaan';

/** Panggil handler `daw://store-relocate` yang terpasang — seperti Rust memancarkannya. */
function emitProgress(done: number, total: number): void {
  const h = tauri.listeners.get('daw://store-relocate');
  if (h === undefined) throw new Error('listener store-relocate belum terpasang');
  act(() => h({ payload: { done, total } }));
}

beforeEach(() => {
  tauri.desktop = true;
  tauri.listeners.clear();
  tauri.invoke.mockReset();
  tauri.invoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'store_info') return INFO;
    return null;
  });
  tauri.listen.mockReset();
  tauri.listen.mockImplementation(async (name: string, handler: Listener) => {
    tauri.listeners.set(name, handler);
    return () => tauri.listeners.delete(name);
  });
  tauri.open.mockReset();
  tauri.reveal.mockReset();
  tauri.reveal.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

const panel = (): HTMLElement => screen.getByRole('region', { name: 'penyimpanan' });

describe('di web', () => {
  it('tidak dirender sama sekali dan tidak ada invoke', () => {
    tauri.desktop = false;
    const { container } = render(<StoreSettings />);
    expect(container.innerHTML).toBe('');
    expect(screen.queryByRole('region', { name: 'penyimpanan' })).toBeNull();
    expect(tauri.invoke).not.toHaveBeenCalled();
  });

  it('layar pengaturan (⌘,) tetap tanpa bagian PENYIMPANAN', () => {
    tauri.desktop = false;
    render(<KeymapEditor open onClose={() => {}} onCaptureChange={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'pintasan keyboard' })).toBeTruthy();
    expect(screen.queryByText('PENYIMPANAN')).toBeNull();
    expect(tauri.invoke).not.toHaveBeenCalled();
  });
});

describe('di desktop', () => {
  it('menampilkan path, ukuran, jumlah lagu/project, versi skema dari store_info', async () => {
    render(<StoreSettings />);
    await waitFor(() => expect(screen.getByTestId('store-dir').textContent).toBe(INFO.dir));
    expect(tauri.invoke).toHaveBeenCalledWith('store_info', {});
    expect(screen.getByTestId('store-bytes').textContent).toBe('3.5 GB');
    expect(screen.getByTestId('store-count').textContent).toBe('42 lagu · 7 project');
    expect(screen.getByTestId('store-schema').textContent).toBe('v3');
    expect(within(panel()).getByText(STORE_HELP)).toBeTruthy();
  });

  it('muncul sebagai bagian PENYIMPANAN di layar pengaturan (⌘,)', async () => {
    render(<KeymapEditor open onClose={() => {}} onCaptureChange={() => {}} />);
    const dialog = screen.getByRole('dialog', { name: 'pintasan keyboard' });
    expect(within(dialog).getByText('PENYIMPANAN')).toBeTruthy();
    await waitFor(() => expect(within(dialog).getByTestId('store-dir').textContent).toBe(INFO.dir));
  });

  it('store_info gagal → pesan galat, bukan panel yang menggantung di "membaca…"', async () => {
    tauri.invoke.mockRejectedValueOnce({ code: 'IO', message: 'library.sqlite terkunci' });
    render(<StoreSettings />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/library\.sqlite terkunci/));
  });

  it('BUKA DI FINDER memanggil revealItemInDir dengan path folder', async () => {
    render(<StoreSettings />);
    await waitFor(() => screen.getByTestId('store-dir'));
    fireEvent.click(screen.getByRole('button', { name: revealLabel(navigator.userAgent) }));
    await waitFor(() => expect(tauri.reveal).toHaveBeenCalledWith(INFO.dir));
  });

  it('batal di dialog pilih folder → tidak ada store_relocate, tidak ada konfirmasi', async () => {
    tauri.open.mockResolvedValueOnce(null);
    render(<StoreSettings />);
    await waitFor(() => screen.getByTestId('store-dir'));
    fireEvent.click(screen.getByRole('button', { name: 'PINDAHKAN FOLDER…' }));
    await waitFor(() => expect(tauri.open).toHaveBeenCalledTimes(1));
    expect(tauri.open.mock.calls[0]?.[0]).toMatchObject({ directory: true, multiple: false });
    expect(screen.queryByRole('group', { name: 'konfirmasi pindah' })).toBeNull();
    expect(tauri.invoke.mock.calls.map(([c]) => c)).toEqual(['store_info']);
  });

  it('pilih folder → konfirmasi menyebut ukuran yang akan disalin; BATAL kembali tanpa memanggil Rust', async () => {
    tauri.open.mockResolvedValueOnce(NEW_DIR);
    render(<StoreSettings />);
    await waitFor(() => screen.getByTestId('store-dir'));
    fireEvent.click(screen.getByRole('button', { name: 'PINDAHKAN FOLDER…' }));
    const confirm = await screen.findByRole('group', { name: 'konfirmasi pindah' });
    expect(confirm.textContent).toContain('3.5 GB');
    expect(confirm.textContent).toContain(NEW_DIR);
    fireEvent.click(within(confirm).getByRole('button', { name: 'BATAL' }));
    expect(screen.queryByRole('group', { name: 'konfirmasi pindah' })).toBeNull();
    expect(tauri.invoke.mock.calls.map(([c]) => c)).toEqual(['store_info']);
  });

  it('PINDAHKAN → listener dipasang SEBELUM store_relocate, progres dari event, sukses memperbarui info', async () => {
    tauri.open.mockResolvedValueOnce(NEW_DIR);
    let finish: (v: StoreInfo) => void = () => {};
    let listenedBeforeInvoke = false;
    tauri.invoke.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === 'store_info') return INFO;
      if (cmd === 'store_relocate') {
        expect(args).toEqual({ newDir: NEW_DIR });
        listenedBeforeInvoke = tauri.listeners.has('daw://store-relocate');
        return new Promise<StoreInfo>((r) => {
          finish = r;
        });
      }
      return null;
    });

    render(<StoreSettings />);
    await waitFor(() => screen.getByTestId('store-dir'));
    fireEvent.click(screen.getByRole('button', { name: 'PINDAHKAN FOLDER…' }));
    const confirm = await screen.findByRole('group', { name: 'konfirmasi pindah' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'PINDAHKAN' }));

    await waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith('store_relocate', { newDir: NEW_DIR }));
    expect(listenedBeforeInvoke).toBe(true);

    emitProgress(1024 * 1024, 4 * 1024 * 1024);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('25');
    expect(screen.getByTestId('store-progress').textContent).toContain('1.0 MB / 4.0 MB');
    // Tombol pindah tidak ada selama menyalin — dua relokasi beruntun tidak mungkin.
    expect(screen.queryByRole('button', { name: 'PINDAHKAN FOLDER…' })).toBeNull();

    emitProgress(4 * 1024 * 1024, 4 * 1024 * 1024);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');

    await act(async () => {
      finish({ ...INFO, dir: NEW_DIR });
    });
    await waitFor(() => expect(screen.getByTestId('store-dir').textContent).toBe(NEW_DIR));
    expect(screen.getByRole('status').textContent).toContain(NEW_DIR);
    expect(screen.queryByRole('progressbar')).toBeNull();
    // Listener dilepas sesudah selesai — bukan dibiarkan menumpuk tiap relokasi.
    expect(tauri.listeners.has('daw://store-relocate')).toBe(false);
    expect(screen.getByRole('button', { name: 'PINDAHKAN FOLDER…' })).toBeTruthy();
  });

  it('gagal DISK_FULL → pesan Rust apa adanya (ukuran & sisa ruang) + "folder lama tetap utuh", info lama tetap', async () => {
    tauri.open.mockResolvedValueOnce(NEW_DIR);
    const message = 'butuh 3.5 GB, sisa ruang di /Volumes/Eksternal hanya 1.2 GB';
    tauri.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'store_info') return INFO;
      if (cmd === 'store_relocate') throw { code: 'DISK_FULL', message };
      return null;
    });

    render(<StoreSettings />);
    await waitFor(() => screen.getByTestId('store-dir'));
    fireEvent.click(screen.getByRole('button', { name: 'PINDAHKAN FOLDER…' }));
    const confirm = await screen.findByRole('group', { name: 'konfirmasi pindah' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'PINDAHKAN' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Disk tujuan penuh');
    expect(alert.textContent).toContain(message);
    expect(alert.textContent).toContain(OLD_DIR_INTACT);
    expect(screen.getByTestId('store-dir').textContent).toBe(INFO.dir);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(tauri.listeners.has('daw://store-relocate')).toBe(false);
    expect(screen.getByRole('button', { name: 'PINDAHKAN FOLDER…' })).toBeTruthy();
  });

  it('gagal dengan pesan string polos (command belum terstruktur) → tetap terbaca + folder lama utuh', async () => {
    tauri.open.mockResolvedValueOnce(NEW_DIR);
    tauri.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'store_info') return INFO;
      if (cmd === 'store_relocate') throw 'verifikasi salinan gagal: 3 berkas berbeda';
      return null;
    });
    render(<StoreSettings />);
    await waitFor(() => screen.getByTestId('store-dir'));
    fireEvent.click(screen.getByRole('button', { name: 'PINDAHKAN FOLDER…' }));
    const confirm = await screen.findByRole('group', { name: 'konfirmasi pindah' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'PINDAHKAN' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(`verifikasi salinan gagal: 3 berkas berbeda ${OLD_DIR_INTACT}`);
  });
});

describe('logika murni', () => {
  it('formatStoreBytes: GB hanya mulai 1024 MB, sisanya mengikuti formatBytes kepustakaan', () => {
    expect(formatStoreBytes(500)).toBe('500 B');
    expect(formatStoreBytes(700 * 1024 ** 2)).toBe('700.0 MB');
    expect(formatStoreBytes(1024 ** 3)).toBe('1.0 GB');
    expect(formatStoreBytes(INFO.bytes)).toBe('3.5 GB');
  });

  it('relocatePercent: total 0 → 0 (bukan NaN), dijepit 0..100', () => {
    expect(relocatePercent({ done: 0, total: 0 })).toBe(0);
    expect(relocatePercent({ done: 5, total: 0 })).toBe(0);
    expect(relocatePercent({ done: 1, total: 4 })).toBe(25);
    expect(relocatePercent({ done: 9, total: 4 })).toBe(100);
  });

  it('confirmRelocateMessage menyebut ukuran, isi, tujuan, dan kapan folder lama dihapus', () => {
    const m = confirmRelocateMessage(INFO, NEW_DIR);
    expect(m).toContain('3.5 GB');
    expect(m).toContain('42 lagu, 7 project');
    expect(m).toContain(NEW_DIR);
    expect(m).toMatch(/sesudah salinan diverifikasi/);
  });

  it('relocateFailureMessage: DISK_FULL diberi label, kode lain hanya pesan; selalu diakhiri folder lama utuh', () => {
    expect(relocateFailureMessage({ code: 'DISK_FULL', message: 'sisa 1 GB' })).toBe(
      `Disk tujuan penuh: sisa 1 GB ${OLD_DIR_INTACT}`,
    );
    expect(relocateFailureMessage({ code: 'INVALID', message: 'folder tujuan di dalam folder lama' })).toBe(
      `folder tujuan di dalam folder lama ${OLD_DIR_INTACT}`,
    );
  });

  it('revealLabel mengikuti pengelola berkas OS', () => {
    expect(revealLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('BUKA DI FINDER');
    expect(revealLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('BUKA DI EXPLORER');
    expect(revealLabel('Mozilla/5.0 (X11; Linux x86_64)')).toBe('BUKA FOLDER');
  });
});
