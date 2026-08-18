/**
 * Toolbar menu: satu popup terbuka, tutup saat klik di luar / Esc, dan isinya
 * benar-benar komponen aslinya — bukan salinan.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { studioActions, studioStore } from '../store';
import { BeatProvider } from '../timeline';
import { MenuBar } from './MenuBar';
import { STUDIO_MENUS } from './StudioMenus';
import { TransportButtons } from './TransportButtons';

Element.prototype.getBoundingClientRect = () =>
  ({ x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 60, width: 1200, height: 60, toJSON: () => ({}) }) as DOMRect;

function Bar(): JSX.Element {
  return (
    <BeatProvider>
      <MenuBar menus={STUDIO_MENUS} leading={<TransportButtons />} />
      <div data-outside style={{ height: '200px' }} />
    </BeatProvider>
  );
}

function icon(id: string): HTMLElement {
  const el = document.querySelector(`[data-menu-button="${id}"]`);
  if (el === null) throw new Error(`ikon ${id} tidak ada`);
  return el as HTMLElement;
}

function popover(): Element | null {
  return document.querySelector('[data-menu-popover]');
}

beforeEach(() => studioActions.__resetForTest());
afterEach(() => {
  act(() => studioActions.closeMenu());
  cleanup();
});

describe('toolbar menu', () => {
  it('tidak ada popup yang terbuka saat mulai', () => {
    render(<Bar />);
    expect(popover()).toBeNull();
    expect(studioStore.getState().openMenu).toBeNull();
  });

  it('menekan ikon membuka popup-nya, menekan lagi menutup', () => {
    render(<Bar />);
    fireEvent.click(icon('beat'));
    expect(document.querySelector('[data-menu-popover="beat"]')).not.toBeNull();
    expect(icon('beat').getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(icon('beat'));
    expect(popover()).toBeNull();
  });

  it('hanya SATU popup terbuka — membuka yang lain menutup yang pertama', () => {
    render(<Bar />);
    fireEvent.click(icon('beat'));
    fireEvent.click(icon('mix'));
    // Beberapa popup sekaligus akan menutupi permukaan kerja yang justru
    // sedang dilihat.
    expect(document.querySelectorAll('[data-menu-popover]')).toHaveLength(1);
    expect(document.querySelector('[data-menu-popover="mix"]')).not.toBeNull();
  });

  it('klik di luar menutup', () => {
    render(<Bar />);
    fireEvent.click(icon('loop'));
    expect(popover()).not.toBeNull();
    fireEvent.pointerDown(document.querySelector('[data-outside]')!);
    expect(popover()).toBeNull();
  });

  it('klik DI DALAM popup tidak menutupnya', () => {
    render(<Bar />);
    fireEvent.click(icon('beat'));
    fireEvent.pointerDown(document.querySelector('[data-menu-popover="beat"]')!);
    expect(popover()).not.toBeNull();
  });

  it('Esc menutup', () => {
    render(<Bar />);
    fireEvent.click(icon('help'));
    expect(popover()).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(popover()).toBeNull();
  });

  it('menu LOOP berisi waveform DAN kontrol loop yang sesungguhnya', () => {
    render(<Bar />);
    fireEvent.click(icon('loop'));
    const pop = document.querySelector('[data-menu-popover="loop"]')!;
    expect(pop.querySelector('[data-clip-wave]')).not.toBeNull();
    expect(pop.querySelector('[data-beat-group="LOOP"]')).not.toBeNull();
    // GRID tidak ikut di sini — ia punya menunya sendiri, dan tombol yang sama
    // muncul di dua tempat membuat orang menekan yang salah.
    expect(pop.querySelector('[data-beat-group="GRID"]')).toBeNull();
  });

  it('menu BEAT hanya berisi GRID', () => {
    render(<Bar />);
    fireEvent.click(icon('beat'));
    const pop = document.querySelector('[data-menu-popover="beat"]')!;
    expect(pop.querySelector('[data-beat-group="GRID"]')).not.toBeNull();
    expect(pop.querySelector('[data-beat-group="LOOP"]')).toBeNull();
  });

  it('menu clip menyebut clip MANA yang diubahnya', () => {
    render(<Bar />);
    const label = studioStore.getState().lanes[0]!.clips[0]!.label;
    for (const id of ['beat', 'loop', 'clip', 'stem']) {
      fireEvent.click(icon(id));
      const pop = document.querySelector(`[data-menu-popover="${id}"]`)!;
      // Popup yang mengedit sesuatu tanpa menyebut apa yang diedit adalah cara
      // paling mudah membuat orang mengubah clip yang salah.
      expect(pop.querySelector('[data-clip-header]'), id).not.toBeNull();
      expect(pop.textContent, id).toContain(label);
    }
  });

  it('semua menu bisa dibuka tanpa melempar', () => {
    render(<Bar />);
    for (const m of STUDIO_MENUS) {
      fireEvent.click(icon(m.id));
      expect(document.querySelector(`[data-menu-popover="${m.id}"]`), m.id).not.toBeNull();
    }
  });

  it('toolbar menempel di atas lewat sticky', () => {
    render(<Bar />);
    const bar = document.querySelector('[data-menu-bar]') as HTMLElement;
    // `fixed` akan melepasnya dari alur dokumen dan menutupi konten sejak awal.
    expect(bar.style.position).toBe('sticky');
    expect(bar.style.top).toBe('0px');
  });
});

describe('transport di toolbar', () => {
  it('PLAY tidak bersembunyi di balik menu', () => {
    render(<Bar />);
    const bar = document.querySelector('[data-menu-bar]') as HTMLElement;
    const play = screen.getByRole('button', { name: 'play' });
    // Perintah yang dipakai setiap beberapa detik tidak boleh butuh dua klik.
    expect(bar.contains(play)).toBe(true);
    expect(play.closest('[data-menu-popover]')).toBeNull();
  });

  it('menekannya benar-benar menjalankan transport', () => {
    render(<Bar />);
    expect(studioStore.getState().playing).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'play' }));
    expect(studioStore.getState().playing).toBe(true);
  });
});
