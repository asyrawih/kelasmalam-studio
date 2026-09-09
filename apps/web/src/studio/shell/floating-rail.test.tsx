import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { studioActions } from '../store';
import { ReorderableStack } from './ReorderableStack';

const items = [
  { id: 'timeline' as const, node: <div data-testid="timeline">TIMELINE</div> },
  { id: 'clip-detail' as const, node: <div data-testid="detail">DETAIL</div> },
];
const aside = (
  <div data-testid="rail">
    <button type="button">TOMBOL RAIL</button>
  </div>
);

const panel = (): HTMLElement => screen.getByTestId('rail').parentElement!.parentElement!;

describe('rail melayang saat mode penuh layar', () => {
  beforeEach(() => {
    studioActions.__resetForTest();
    studioActions.clearMaximize();
  });

  it('tidak dirender sama sekali saat tidak ada panel yang dibentangkan', () => {
    render(<ReorderableStack items={items} overlayAside={aside} />);
    expect(screen.queryByTestId('rail')).toBeNull();
  });

  it('muncul DI DALAM overlay saat dibentangkan — bukan di luar', () => {
    studioActions.toggleMaximize('timeline');
    const { container } = render(<ReorderableStack items={items} overlayAside={aside} />);

    const rail = screen.getByTestId('rail');
    // Elemen fullscreen adalah anak pertama; rail harus berada di dalamnya,
    // kalau tidak ia tidak akan terlihat saat browser masuk fullscreen native.
    const overlay = container.firstElementChild!;
    expect(overlay.contains(rail)).toBe(true);
  });

  it('tersembunyi dulu, lalu terbuka saat pointer masuk', () => {
    studioActions.toggleMaximize('timeline');
    render(<ReorderableStack items={items} overlayAside={aside} />);

    const el = panel();
    expect(el.style.transform).toContain('calc(100% -');

    fireEvent.pointerEnter(el);
    expect(el.style.transform).toBe('translateX(0)');

    fireEvent.pointerLeave(el);
    expect(el.style.transform).toContain('calc(100% -');
  });

  it('fokus keyboard juga membukanya — kalau tidak, isinya bisa di-Tab tapi tak terlihat', () => {
    studioActions.toggleMaximize('timeline');
    render(<ReorderableStack items={items} overlayAside={aside} />);

    const el = panel();
    fireEvent.focus(screen.getByRole('button', { name: 'TOMBOL RAIL' }));
    expect(el.style.transform).toBe('translateX(0)');
  });

  it('tetap terbuka saat fokus pindah antar elemen DI DALAM rail', () => {
    studioActions.toggleMaximize('timeline');
    render(<ReorderableStack items={items} overlayAside={aside} />);

    const el = panel();
    const btn = screen.getByRole('button', { name: 'TOMBOL RAIL' });
    fireEvent.focus(btn);
    // relatedTarget masih di dalam rail → jangan menutup.
    fireEvent.blur(btn, { relatedTarget: screen.getByTestId('rail') });
    expect(el.style.transform).toBe('translateX(0)');
  });
});
