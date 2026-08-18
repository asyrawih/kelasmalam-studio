/**
 * Melipat blok Clip Detail.
 *
 * Yang dijaga di sini bukan "tombolnya berfungsi", melainkan janji yang membuat
 * melipat BOLEH dilakukan sama sekali: blok yang tertutup tetap MENYATAKAN
 * keadaannya. Fade yang aktif dan stem yang dibuang sama-sama mengubah suara,
 * dan menyembunyikannya tanpa jejak berarti user tidak bisa tahu kenapa
 * clip-nya terdengar begitu.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { studioActions, studioStore } from '../store';
import { ClipDetailPanel } from './ClipDetailPanel';

const SR = 48_000;

Element.prototype.getBoundingClientRect = () =>
  ({ x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 150, width: 400, height: 150, toJSON: () => ({}) }) as DOMRect;

function header(id: string): HTMLElement {
  const el = document.querySelector(`[data-detail-section="${id}"] button`);
  if (el === null) throw new Error(`blok ${id} tidak ada`);
  return el as HTMLElement;
}

function clipId(): string {
  return studioStore.getState().selectedClipId!;
}

/** Clip pertama di lane pertama — dipakai setelah seleksi dilepas. */
function clipId0(): string {
  return studioStore.getState().lanes[0]!.clips[0]!.id;
}

beforeEach(() => {
  studioActions.__resetForTest();
  const lane = studioStore.getState().lanes[0]!;
  const clip = lane.clips[0]!;
  studioActions.updateClip(clip.id, { start: 0, len: 10 * SR, fadeInMs: 0, fadeOutMs: 0 });
  studioActions.selectClip(clip.id, lane.id);
});

afterEach(cleanup);

describe('Clip Detail selalu terpasang', () => {
  it('tanpa seleksi pun tetap memajang sebuah clip — panel tidak pernah kosong', () => {
    act(() => studioActions.clearClipSelection());
    render(<ClipDetailPanel />);
    // Panel yang muncul-hilang mendorong timeline naik-turun di bawah kursor,
    // sehingga klik berikutnya mendarat di tempat yang berbeda dari yang
    // dilihat mata. Selama project punya clip, panel ini selalu berisi.
    expect(screen.queryByText('PILIH CLIP DI TIMELINE')).toBeNull();
    expect(document.querySelector('[data-detail-section="beat"]')).not.toBeNull();
    expect(screen.getByText('TIDAK TERPILIH')).toBeTruthy();
  });

  it('TETAP menampilkan clip terakhir setelah seleksi dilepas', () => {
    render(<ClipDetailPanel />);
    const label = studioStore.getState().lanes[0]!.clips[0]!.label;
    expect(screen.getByText(label)).toBeTruthy();

    // Inilah yang terjadi puluhan kali saat menarik kotak seleksi. Kalau
    // panelnya mengempis, timeline di bawahnya melompat — dan kotak yang
    // sedang ditarik diukur terhadap timeline itu.
    act(() => studioActions.clearClipSelection());
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByText('TIDAK TERPILIH')).toBeTruthy();
    // Isinya tetap ada, jadi tingginya tidak berubah.
    expect(document.querySelector('[data-detail-section="beat"]')).not.toBeNull();
  });

  it('penanda TIDAK TERPILIH hilang lagi begitu clip dipilih ulang', () => {
    render(<ClipDetailPanel />);
    act(() => studioActions.clearClipSelection());
    expect(screen.getByText('TIDAK TERPILIH')).toBeTruthy();
    act(() => studioActions.selectClip(clipId0()));
    expect(screen.queryByText('TIDAK TERPILIH')).toBeNull();
  });

  it('menghapus clip yang dipajang JATUH ke clip lain, bukan mengempis', () => {
    // Dua clip supaya ada yang tersisa setelah satu dihapus.
    const laneId = studioStore.getState().lanes[0]!.id;
    act(() =>
      studioActions.addClip(laneId, {
        ...studioStore.getState().lanes[0]!.clips[0]!,
        id: 'sisa',
        label: 'SISA',
        start: 40 * SR,
      }),
    );
    act(() => studioActions.selectClip(clipId0()));
    render(<ClipDetailPanel />);
    const shown = studioStore.getState().lanes[0]!.clips.find((c) => c.id !== 'sisa')!;

    act(() => studioActions.removeClip(shown.id));
    // Tinggi panel tidak boleh berubah tepat setelah menekan X — timeline di
    // bawahnya akan melompat, persis masalah yang sama dengan kotak seleksi.
    expect(screen.queryByText('PILIH CLIP DI TIMELINE')).toBeNull();
    expect(document.querySelector('[data-detail-section="beat"]')).not.toBeNull();
    // Dan yang dipajang bukan clip yang baru dihapus.
    expect(screen.queryByText(shown.label)).toBeNull();
  });

  it('memilih clip di bawah playhead lebih dulu saat jatuh', () => {
    const laneId = studioStore.getState().lanes[0]!.id;
    act(() =>
      studioActions.addClip(laneId, {
        ...studioStore.getState().lanes[0]!.clips[0]!,
        id: 'jauh',
        label: 'JAUH',
        start: 60 * SR,
      }),
    );
    act(() => studioActions.setPlayhead(61 * SR)); // di dalam 'JAUH'
    const first = studioStore.getState().lanes[0]!.clips.find((c) => c.id !== 'jauh')!;
    act(() => studioActions.selectClip(first.id));
    render(<ClipDetailPanel />);
    act(() => studioActions.removeClip(first.id));
    expect(screen.getByText('JAUH')).toBeTruthy();
  });

  it('project tanpa clip sama sekali memang kosong', () => {
    for (const c of studioStore.getState().lanes.flatMap((l) => l.clips)) {
      act(() => studioActions.removeClip(c.id));
    }
    render(<ClipDetailPanel />);
    expect(screen.getByText('PILIH CLIP DI TIMELINE')).toBeTruthy();
  });

  it('badge hilang begitu clip yang dipajang memang dipilih', () => {
    const id = clipId0();
    act(() => studioActions.clearClipSelection());
    render(<ClipDetailPanel />);
    expect(screen.getByText('TIDAK TERPILIH')).toBeTruthy();
    act(() => studioActions.selectClip(id));
    expect(screen.queryByText('TIDAK TERPILIH')).toBeNull();
  });
});

describe('blok Clip Detail', () => {
  it('default: BEAT terbuka, REMOVE dan FADE terlipat', () => {
    render(<ClipDetailPanel />);
    expect(header('beat').getAttribute('aria-expanded')).toBe('true');
    expect(header('stem').getAttribute('aria-expanded')).toBe('false');
    expect(header('fade').getAttribute('aria-expanded')).toBe('false');
    // Isi blok yang terlipat memang tidak ada di DOM, bukan sekadar tersembunyi.
    expect(screen.queryByRole('button', { name: 'VOCAL' })).toBeNull();
  });

  it('mengkliknya membuka dan menutup, dan pilihannya tersimpan di store', () => {
    render(<ClipDetailPanel />);
    fireEvent.click(header('stem'));
    expect(studioStore.getState().clipDetailSections.stem).toBe(true);
    expect(screen.getByRole('button', { name: 'VOCAL' })).toBeTruthy();

    fireEvent.click(header('stem'));
    expect(studioStore.getState().clipDetailSections.stem).toBe(false);
    expect(screen.queryByRole('button', { name: 'VOCAL' })).toBeNull();
  });

  it('blok terlipat tetap menyatakan bahwa stem sedang dibuang', () => {
    render(<ClipDetailPanel />);
    expect(screen.getByText('clip utuh')).toBeTruthy();
    studioActions.setClipStem(clipId(), { vocal: 0 });
    cleanup();
    render(<ClipDetailPanel />);
    expect(screen.getByText('−VOCAL')).toBeTruthy();
  });

  it('blok terlipat tetap menyatakan fade yang aktif', () => {
    render(<ClipDetailPanel />);
    expect(screen.getByText('tanpa fade')).toBeTruthy();
    studioActions.updateClip(clipId(), { fadeInMs: 2000, fadeOutMs: 500 });
    cleanup();
    render(<ClipDetailPanel />);
    expect(screen.getByText(/IN 2\.00 s · OUT 0\.50 s/)).toBeTruthy();
  });

  it('ringkasan TIDAK diulang saat blok-nya terbuka', () => {
    studioActions.updateClip(clipId(), { fadeInMs: 2000, fadeOutMs: 500 });
    render(<ClipDetailPanel />);
    expect(screen.getByText(/IN 2\.00 s · OUT 0\.50 s/)).toBeTruthy();
    fireEvent.click(header('fade'));
    expect(screen.queryByText(/IN 2\.00 s · OUT 0\.50 s/)).toBeNull();
  });
});
