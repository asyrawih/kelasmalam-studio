/**
 * Pembungkus route: kapan tombol UNGGAH boleh hidup.
 *
 * Satu aturan yang dijaga di sini dan tidak di tempat lain: **konfigurasi yang
 * ada tidak sama dengan backend yang hidup.** URL terisi + Worker mati adalah
 * keadaan paling sering saat pengembangan, dan badge yang berkata SIAP di situ
 * berbohong tepat di tempat yang paling mahal.
 */

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RobloxRoute } from './RobloxRoute';
import { robloxActions, robloxStore } from './store';
import type { Runner } from './backend/runner';

const fakeRunner = (): Runner => ({ run: vi.fn(), idle: async () => {} });

const uploadButton = (): HTMLButtonElement =>
  screen.getByRole('button', { name: /^UNGGAH/ }) as HTMLButtonElement;

beforeEach(() => robloxActions.__resetForTest());
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
