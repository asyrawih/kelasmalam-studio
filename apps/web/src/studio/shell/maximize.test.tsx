import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { studioActions, studioStore } from '../store';
import { ReorderableStack } from './ReorderableStack';

const items = [
  { id: 'timeline' as const, node: <div data-testid="timeline">TIMELINE</div> },
  { id: 'clip-detail' as const, node: <div data-testid="detail">DETAIL</div> },
];

describe('mode penuh layar', () => {
  beforeEach(() => {
    studioActions.__resetForTest();
    studioActions.clearMaximize();
  });

  it('hanya panel yang dibentangkan yang dirender', () => {
    const { rerender } = render(<ReorderableStack items={items} />);
    expect(screen.getByTestId('detail')).toBeTruthy();

    studioActions.toggleMaximize('timeline');
    rerender(<ReorderableStack items={items} />);

    expect(screen.getByTestId('timeline')).toBeTruthy();
    // Panel lain TIDAK ikut dirender — kalau ikut, canvas timeline akan hidup
    // dua kali dan sama-sama menggambar ulang.
    expect(screen.queryByTestId('detail')).toBeNull();
  });

  it('tombol bentangkan men-toggle, bukan hanya menyalakan', () => {
    render(<ReorderableStack items={items} />);
    fireEvent.click(screen.getByLabelText('bentangkan panel timeline'));
    expect(studioStore.getState().maximizedPanel).toBe('timeline');
    studioActions.toggleMaximize('timeline');
    expect(studioStore.getState().maximizedPanel).toBeNull();
  });

  it('Escape mengembalikan', () => {
    studioActions.toggleMaximize('timeline');
    render(<ReorderableStack items={items} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(studioStore.getState().maximizedPanel).toBeNull();
  });

  it('keluar dari fullscreen browser ikut menutup overlay', () => {
    studioActions.toggleMaximize('timeline');
    render(<ReorderableStack items={items} />);
    // Browser keluar fullscreen sendiri (Esc bawaan / user gesture).
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(studioStore.getState().maximizedPanel).toBeNull();
  });

  it('mencoba Fullscreen API, dan penolakannya tidak menjatuhkan apa pun', () => {
    const reject = vi.fn().mockRejectedValue(new Error('ditolak'));
    Object.defineProperty(Element.prototype, 'requestFullscreen', {
      value: reject,
      configurable: true,
      writable: true,
    });
    studioActions.toggleMaximize('timeline');
    expect(() => render(<ReorderableStack items={items} />)).not.toThrow();
    expect(reject).toHaveBeenCalled();
    // Overlay tetap tampil walau API-nya gagal — itu lapis yang menentukan.
    expect(screen.getByTestId('timeline')).toBeTruthy();
  });

  it('panel yang tidak ada di tumpukan ini tidak membajaknya', () => {
    studioActions.toggleMaximize('amplify'); // milik rail, bukan stack utama
    render(<ReorderableStack items={items} />);
    expect(screen.getByTestId('detail')).toBeTruthy();
  });
});
