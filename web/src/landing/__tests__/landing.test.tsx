/**
 * Landing page + router.
 *
 * Yang dijaga di sini bukan tampilannya, melainkan tiga hal yang gampang
 * rusak diam-diam: halaman mount tanpa error, setiap CTA benar-benar
 * memanggil `onOpenStudio`, dan `/` TIDAK ikut me-mount studio (yang akan
 * menyalakan interval playhead + persistence di halaman marketing).
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LandingPage } from '../LandingPage';
import { AppShell } from '../../app-shell';
import { routeOf } from '../../app-shell/routes';
import { libraryActions } from '../../library/store';

afterEach(() => {
  cleanup();
  libraryActions.__resetForTest();
  window.history.pushState(null, '', '/');
});

describe('LandingPage', () => {
  it('mount tanpa error konsol', () => {
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => errors.push(a));
    expect(() => render(<LandingPage onOpenStudio={() => {}} />)).not.toThrow();
    spy.mockRestore();
    expect(errors, `console.error saat mount: ${JSON.stringify(errors)}`).toEqual([]);
  });

  it('semua CTA studio memanggil onOpenStudio', () => {
    const open = vi.fn();
    render(<LandingPage onOpenStudio={open} />);
    // Topbar + CTA penutup memakai label yang sama; hero memakai dua label lain.
    const buka = screen.getAllByRole('button', { name: 'BUKA STUDIO' });
    expect(buka).toHaveLength(2);
    for (const b of buka) fireEvent.click(b);
    fireEvent.click(screen.getByRole('button', { name: 'MULAI MIXING GRATIS' }));
    expect(open).toHaveBeenCalledTimes(3);
  });

  it('menyembunyikan tombol aplikasi di header sebelum login', () => {
    render(
      <LandingPage
        onOpenStudio={() => {}}
        onOpenDj={() => {}}
        onOpenRoblox={() => {}}
        showAppLinks={false}
      />,
    );
    expect(screen.queryByRole('button', { name: 'MODE DJ' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'ROBLOX' })).toBeNull();
    // CTA bawah tetap menjelaskan produk; yang hilang hanya tombol akses pada header.
    expect(screen.getAllByRole('button', { name: 'BUKA STUDIO' })).toHaveLength(1);
  });

  it('FAQ membuka dan menutup jawabannya', () => {
    render(<LandingPage onOpenStudio={() => {}} />);
    const first = screen.getByRole('button', { name: /Audio saya diupload ke server/ });
    // Item pertama terbuka sejak awal, sama seperti design (`faq: 0`).
    expect(first.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(first);
    expect(first.getAttribute('aria-expanded')).toBe('false');
  });

  it('memilih paket memindahkan sorotan', () => {
    render(<LandingPage onOpenStudio={() => {}} />);
    const lifetime = screen.getByRole('button', { name: 'AMBIL LIFETIME' });
    fireEvent.click(lifetime);
    // Kartu terpilih memakai latar #0f0d05 (design), yang lain surface-1.
    const card = lifetime.closest('div[style*="flex-direction"]');
    expect(card).not.toBeNull();
    expect(card?.getAttribute('style')).toContain('rgb(15, 13, 5)');
  });
});

describe('routeOf', () => {
  it('memetakan path ke halaman', () => {
    expect(routeOf('/')).toBe('landing');
    expect(routeOf('/apa-saja')).toBe('landing');
    expect(routeOf('/studio')).toBe('studio');
    expect(routeOf('/studio/')).toBe('studio');
    expect(routeOf('/dj')).toBe('dj');
    expect(routeOf('/dj/')).toBe('dj');
    expect(routeOf('/proof-stem')).toBe('proof-stem');
    expect(routeOf('/proof-stem/')).toBe('proof-stem');
  });

  it('path yang tidak dikenal jatuh ke landing, bukan melempar', () => {
    expect(routeOf('/dj/extra')).toBe('landing');
    expect(routeOf('')).toBe('landing');
  });
});

describe('AppShell', () => {
  it('membuka proof-stem sebagai halaman eksperimen publik', () => {
    window.history.pushState(null, '', '/proof-stem');
    render(<AppShell />);
    expect(screen.getByText('SOURCE TRACK')).toBeTruthy();
    expect(screen.getByText('STEM OUTPUTS')).toBeTruthy();
    expect(screen.queryByTestId('auth-guard')).toBeNull();
  });

  it('menahan protected route saat sesi Google belum ada', async () => {
    window.history.pushState(null, '', '/studio');
    render(
      <AppShell
        authApi={{
          me: async () => null,
          loginUrl: (next) => `https://auth.test/google?next=${encodeURIComponent(next)}`,
        }}
      />,
    );

    await waitFor(() => expect(screen.getByText('LOGIN DIPERLUKAN')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'MASUK DENGAN GOOGLE' })).toBeTruthy();
    expect(screen.queryByText('KELAS MALAM STUDIO')).toBeNull();
  });

  it('membuka protected route setelah sesi Google terverifikasi', async () => {
    window.history.pushState(null, '', '/dj');
    render(
      <AppShell
        authApi={{
          me: async () => ({ id: 'u1', email: 'user@example.com', name: 'User' }),
          loginUrl: () => 'https://auth.test/google',
        }}
      />,
    );

    await waitFor(() => expect(screen.getByText('KELAS MALAM DJ')).toBeTruthy());
    expect(screen.queryByTestId('auth-guard')).toBeNull();
  });

  it('menampilkan landing di `/` dan tidak me-mount studio', () => {
    window.history.pushState(null, '', '/');
    render(<AppShell />);
    expect(screen.getByRole('button', { name: 'MULAI MIXING GRATIS' })).toBeTruthy();
    // Header studio hanya ada di halaman studio.
    expect(screen.queryByRole('button', { name: /CLOSE/ })).toBeNull();
  });

  it('membuka halaman DJ lewat CTA, TANPA me-mount studio', () => {
    window.history.pushState(null, '', '/');
    render(<AppShell />);
    fireEvent.click(screen.getAllByRole('button', { name: 'MODE DJ' })[0] as HTMLElement);
    expect(window.location.pathname).toBe('/dj');
    expect(screen.getByText('KELAS MALAM DJ')).toBeTruthy();
    // `App` memasang interval playhead, autosave, dan mencoba membangun
    // AudioContext begitu ia mount — jadi bukti bahwa ia TIDAK ter-mount
    // adalah bagian dari kontrak router, bukan detail kosmetik.
    expect(screen.queryByText('KELAS MALAM STUDIO')).toBeNull();
    expect(screen.queryByRole('button', { name: /CLOSE/ })).toBeNull();
  });

  it('pindah ke studio saat CTA ditekan, dan kembali lewat popstate', () => {
    window.history.pushState(null, '', '/');
    render(<AppShell />);
    fireEvent.click(screen.getAllByRole('button', { name: 'BUKA STUDIO' })[0] as HTMLElement);
    expect(window.location.pathname).toBe('/studio');
    expect(screen.queryByRole('button', { name: 'MULAI MIXING GRATIS' })).toBeNull();

    window.history.pushState(null, '', '/');
    fireEvent.popState(window);
    expect(screen.getByRole('button', { name: 'MULAI MIXING GRATIS' })).toBeTruthy();
  });
});
