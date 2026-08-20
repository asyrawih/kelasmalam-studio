import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { CollectionBrowser } from './CollectionBrowser';
import { djActions, djStore } from '../store';
import { studioActions, studioStore, type StudioAsset } from '../../studio/store';
import { buildEnvelope } from '../../studio/timeline/envelope';

const SR = 48_000;
const FRAMES = SR * 4;
const asset = (id: number): StudioAsset =>
  ({
    id, name: `LAGU ${id}`,
    envelope: buildEnvelope({ numberOfChannels: 1, length: FRAMES, getChannelData: () => new Float32Array(FRAMES) }),
    frames: FRAMES, sampleRate: SR, tempo: null, tempoPending: false,
    tempoOctave: 0, bpmOverride: null, beatOffsetOverride: null,
  }) as unknown as StudioAsset;

beforeEach(() => {
  cleanup();
  djActions.__resetForTest();
  studioActions.__resetForTest?.();
  act(() => studioActions.registerAsset(asset(5)));
});

/**
 * Alur hapus dari UI.
 *
 * Penjaga terpentingnya: konfirmasi harus BISA DISELESAIKAN. Versi pertamanya
 * membatalkan konfirmasi di `onPointerLeave`, dan karena sasarannya selebar
 * 18 px, tangan hampir selalu bergeser sedikit di antara dua klik — yang
 * terlihat adalah `HAPUS?` berkedip kembali jadi `✕` berulang-ulang, sebuah
 * tombol yang ditekan berkali-kali dan tidak pernah melakukan apa pun.
 */
describe('alur hapus dari UI', () => {
  const btn = () => screen.getByTitle(/hapus "LAGU 5"/);

  it('dua klik benar-benar menghapus asetnya', async () => {
    render(<CollectionBrowser />);
    fireEvent.click(btn());
    expect(btn().textContent).toBe('HAPUS?');

    await act(async () => {
      fireEvent.click(btn());
      await Promise.resolve();
    });
    expect(studioStore.getState().assets[5]).toBeUndefined();
  });

  it('pointer yang bergeser keluar-masuk TIDAK membatalkan konfirmasi', async () => {
    render(<CollectionBrowser />);
    fireEvent.click(btn());
    // Persis yang terjadi di tangan: kursor melewati tepi tombol sebelum
    // klik kedua.
    fireEvent.pointerLeave(btn());
    fireEvent.pointerEnter(btn());
    expect(btn().textContent).toBe('HAPUS?');

    await act(async () => {
      fireEvent.click(btn());
      await Promise.resolve();
    });
    expect(studioStore.getState().assets[5]).toBeUndefined();
  });

  it('konfirmasi batal sendiri setelah beberapa detik', () => {
    vi.useFakeTimers();
    try {
      render(<CollectionBrowser />);
      fireEvent.click(btn());
      expect(btn().textContent).toBe('HAPUS?');
      // Tombol berbahaya tidak boleh tinggal bersenjata tanpa batas.
      act(() => void vi.advanceTimersByTime(6000));
      expect(btn().textContent).toBe('✕');
    } finally {
      vi.useRealTimers();
    }
  });

  it('lebar tombol TETAP — layout tidak bergeser di antara dua klik', () => {
    render(<CollectionBrowser />);
    const before = btn().style.width;
    fireEvent.click(btn());
    expect(btn().style.width).toBe(before);
  });

  it('penolakan dilaporkan DI Collection, bukan hanya di baris FX yang jauh', async () => {
    // Lagu yang dipakai clip Studio tidak boleh terhapus dari sini.
    const lanes = studioStore.getState().lanes;
    const first = lanes[0];
    if (first === undefined) throw new Error('tanpa lane');
    act(() =>
      studioActions.hydrate({
        lanes: [
          {
            ...first,
            name: 'LANE UJI',
            clips: [
              {
                id: 'c1', assetId: 5, chain: [], start: 0, len: 10, sourceStart: 0,
                sourceLen: 10, label: 'X', gainDb: 0, fadeInMs: 0, fadeOutMs: 0,
                fadeCurve: 'equalPower', seed: 1,
              },
            ],
          },
        ],
      }),
    );

    render(<CollectionBrowser />);
    // Judulnya sudah berubah jadi penjelasan "tidak bisa dihapus", jadi
    // tombolnya dicari lewat isinya — dan itu sendiri sudah setengah pesan.
    const kill = () => screen.getByRole('button', { name: /^(✕|HAPUS\?)$/ });
    fireEvent.click(kill());
    await act(async () => {
      fireEvent.click(kill());
      await Promise.resolve();
    });

    expect(studioStore.getState().assets[5]).toBeDefined();
    expect(screen.getByText(/dipakai 1 clip di Studio/)).toBeTruthy();
    expect(djStore.getState().notice).toMatch(/dipakai 1 clip/);
  });
});
