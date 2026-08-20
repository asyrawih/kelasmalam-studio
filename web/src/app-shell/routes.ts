/**
 * Tabel path → route. Dipisah dari komponen supaya bisa dites tanpa React, dan
 * supaya halaman keempat cukup menambah SATU baris di sini.
 */

export type Route = 'landing' | 'studio' | 'dj' | 'roblox';

export const HOME_PATH = '/';
export const STUDIO_PATH = '/studio';
export const DJ_PATH = '/dj';
export const ROBLOX_PATH = '/roblox';

const TABLE: Readonly<Record<string, Route>> = {
  [STUDIO_PATH]: 'studio',
  [DJ_PATH]: 'dj',
  [ROBLOX_PATH]: 'roblox',
};

/** Trailing slash diabaikan supaya `/studio/` tidak jatuh ke landing. */
export function routeOf(pathname: string): Route {
  return TABLE[pathname.replace(/\/+$/, '')] ?? 'landing';
}

export function pathOf(route: Route): string {
  if (route === 'studio') return STUDIO_PATH;
  if (route === 'dj') return DJ_PATH;
  if (route === 'roblox') return ROBLOX_PATH;
  return HOME_PATH;
}
