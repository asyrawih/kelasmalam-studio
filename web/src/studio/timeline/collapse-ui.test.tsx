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
  it('tetap ada saat tidak ada clip terpilih', () => {
    studioActions.selectClip(null);
    render(<ClipDetailPanel />);
    // Panel yang muncul-hilang mendorong timeline naik-turun di bawah kursor,
    // sehingga klik berikutnya mendarat di tempat yang berbeda dari yang
    // dilihat mata. Judulnya tetap; isinya yang kosong.
    expect(screen.getByText('PILIH CLIP DI TIMELINE')).toBeTruthy();
    expect(document.querySelector('[data-detail-section="beat"]')).toBeNull();
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

  it('clip yang dihapus tidak dipajang sebagai hantu', () => {
    render(<ClipDetailPanel />);
    const id = clipId0();
    act(() => studioActions.removeClip(id));
    expect(screen.getByText('PILIH CLIP DI TIMELINE')).toBeTruthy();
  });

  it('isinya muncul begitu ada yang dipilih', () => {
    const id = clipId();
    studioActions.selectClip(null);
    const view = render(<ClipDetailPanel />);
    expect(document.querySelector('[data-detail-section="beat"]')).toBeNull();
    cleanup();
    studioActions.selectClip(id);
    view.unmount();
    render(<ClipDetailPanel />);
    expect(document.querySelector('[data-detail-section="beat"]')).not.toBeNull();
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
