/**
 * Tabel path → route milik app DESKTOP (docs/25 P2).
 *
 * Tidak ada `landing`, `privacy-policy`, `terms-of-service`: itu halaman
 * situs, bukan halaman aplikasi yang dipasang di mesin orang. `/` (dan path
 * apa pun yang tidak dikenal) jatuh ke STUDIO — aplikasi dibuka langsung di
 * tempat kerja, bukan di beranda (docs/25 §5 "Landing di desktop").
 *
 * `HOME_PATH` tetap `/` supaya command `shell.goto.home` (menu native
 * "Beranda", `src-tauri/src/menu.rs`) tetap punya sasaran; di desktop sasaran
 * itu adalah Studio.
 */

export type Route = 'studio' | 'dj' | 'roblox' | 'proof-stem';

export const HOME_PATH = '/';
export const STUDIO_PATH = '/studio';
export const DJ_PATH = '/dj';
export const ROBLOX_PATH = '/roblox';
export const PROOF_STEM_PATH = '/proof-stem';

const TABLE: Readonly<Record<string, Route>> = {
  [STUDIO_PATH]: 'studio',
  [DJ_PATH]: 'dj',
  [ROBLOX_PATH]: 'roblox',
  [PROOF_STEM_PATH]: 'proof-stem',
};

/** Trailing slash diabaikan; yang tidak dikenal (termasuk `/`) = studio. */
export function routeOf(pathname: string): Route {
  return TABLE[pathname.replace(/\/+$/, '')] ?? 'studio';
}

export function pathOf(route: Route): string {
  if (route === 'dj') return DJ_PATH;
  if (route === 'roblox') return ROBLOX_PATH;
  if (route === 'proof-stem') return PROOF_STEM_PATH;
  return STUDIO_PATH;
}
