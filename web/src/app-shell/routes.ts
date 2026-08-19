/**
 * Tabel path → route. Dipisah dari komponen supaya bisa dites tanpa React, dan
 * supaya halaman keempat cukup menambah SATU baris di sini.
 */

export type Route = 'landing' | 'studio' | 'dj';

export const HOME_PATH = '/';
export const STUDIO_PATH = '/studio';
export const DJ_PATH = '/dj';

const TABLE: Readonly<Record<string, Route>> = {
  [STUDIO_PATH]: 'studio',
  [DJ_PATH]: 'dj',
};

/** Trailing slash diabaikan supaya `/studio/` tidak jatuh ke landing. */
export function routeOf(pathname: string): Route {
  return TABLE[pathname.replace(/\/+$/, '')] ?? 'landing';
}

export function pathOf(route: Route): string {
  if (route === 'studio') return STUDIO_PATH;
  if (route === 'dj') return DJ_PATH;
  return HOME_PATH;
}
