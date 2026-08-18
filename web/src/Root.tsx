/**
 * Router seadanya: `/` menampilkan landing page, `/studio` menampilkan editor.
 *
 * Tidak ada react-router di sini dan sengaja tidak ditambahkan — hanya ada dua
 * halaman, tanpa parameter path, tanpa nested route. Satu `useState` +
 * `history.pushState` sudah cukup, dan ~10 kB dependency untuk itu tidak
 * sebanding di aplikasi yang bundle-nya sudah berisi WASM engine.
 *
 * Deep link ke `/studio` bekerja karena hosting-nya sudah punya SPA fallback:
 * `deploy/nginx.conf` (`try_files ... /index.html`) dan
 * `deploy/vercel-config.json` (rewrite terakhir ke `/index.html`).
 *
 * Studio TIDAK dirender saat berada di landing. Ini bukan sekadar hemat
 * render: App memasang interval playhead, autosave persistence, dan mencoba
 * membangun AudioContext begitu ia mount — semuanya tidak boleh jalan di
 * halaman marketing.
 */

import { useCallback, useEffect, useState } from 'react';
import { App } from './App';
import { LandingPage } from './landing';

const STUDIO_PATH = '/studio';
const HOME_PATH = '/';

export type Route = 'landing' | 'studio';

/** Trailing slash diabaikan supaya `/studio/` tidak jatuh ke landing. */
export function routeOf(pathname: string): Route {
  return pathname.replace(/\/+$/, '') === STUDIO_PATH ? 'studio' : 'landing';
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
    return <App createEngine={createEngine} onClose={() => navigate(HOME_PATH)} />;
  }
  return <LandingPage onOpenStudio={() => navigate(STUDIO_PATH)} />;
}
