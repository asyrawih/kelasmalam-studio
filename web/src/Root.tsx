/**
 * Router seadanya: `/` landing, `/studio` editor timeline, `/dj` mixer 2 deck.
 *
 * Tidak ada react-router di sini dan sengaja tidak ditambahkan — hanya ada
 * beberapa halaman, tanpa parameter path, tanpa nested route. Satu `useState` +
 * `history.pushState` sudah cukup, dan ~10 kB dependency untuk itu tidak
 * sebanding di aplikasi yang bundle-nya sudah berisi WASM engine.
 *
 * Pemetaannya sekarang TABEL, bukan perbandingan kesetaraan tunggal seperti
 * versi dua-halaman. Dengan tabel, halaman keempat cukup menambah satu baris
 * dan tidak menyentuh logikanya sama sekali.
 *
 * Deep link bekerja karena hosting-nya sudah punya SPA fallback:
 * `deploy/nginx.conf` (`try_files ... /index.html`) dan
 * `deploy/vercel-config.json` (rewrite terakhir ke `/index.html`). Tidak ada
 * konfigurasi yang perlu diubah untuk path baru.
 *
 * Halaman berat TIDAK dirender saat tidak sedang dibuka. Ini bukan sekadar
 * hemat render: `App` memasang interval playhead, autosave persistence, dan
 * mencoba membangun AudioContext begitu ia mount — semuanya tidak boleh jalan
 * di halaman marketing, dan `DjPage` punya interval-nya sendiri yang juga tidak
 * boleh jalan saat user sedang di Studio.
 */

import { useCallback, useEffect, useState } from 'react';
import { App } from './App';
import { DjPage } from './dj';
import { LandingPage } from './landing';

const HOME_PATH = '/';
export const STUDIO_PATH = '/studio';
export const DJ_PATH = '/dj';

export type Route = 'landing' | 'studio' | 'dj';

/** Path → route. Landing adalah jawaban default untuk apa pun yang tidak dikenal. */
const ROUTES: Readonly<Record<string, Route>> = {
  [STUDIO_PATH]: 'studio',
  [DJ_PATH]: 'dj',
};

/** Trailing slash diabaikan supaya `/studio/` tidak jatuh ke landing. */
export function routeOf(pathname: string): Route {
  return ROUTES[pathname.replace(/\/+$/, '')] ?? 'landing';
}

export interface RootProps {
  readonly createEngine?: () => Promise<unknown>;
}

export function Root({ createEngine }: RootProps): JSX.Element {
  const [route, setRoute] = useState<Route>(() => routeOf(window.location.pathname));

  // Tombol back/forward browser harus tetap berpindah halaman.
  useEffect(() => {
    const onPopState = (): void => setRoute(routeOf(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((path: string): void => {
    if (window.location.pathname !== path) {
      window.history.pushState(null, '', path);
    }
    setRoute(routeOf(path));
    window.scrollTo(0, 0);
  }, []);

  if (route === 'studio') {
    return (
      <App
        createEngine={createEngine}
        onClose={() => navigate(HOME_PATH)}
        onOpenDj={() => navigate(DJ_PATH)}
      />
    );
  }
  if (route === 'dj') {
    return <DjPage onClose={() => navigate(HOME_PATH)} />;
  }
  return (
    <LandingPage
      onOpenStudio={() => navigate(STUDIO_PATH)}
      onOpenDj={() => navigate(DJ_PATH)}
    />
  );
}
