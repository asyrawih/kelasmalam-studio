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
 * itu adalah Studio. Konstanta path dan `pathOf` dari
 * `@kelasmalam/shell/routes` (docs/25 P3) — yang milik app hanya DAFTAR-nya.
 */

import { makeRouteOf, type Route as AnyRoute } from '@kelasmalam/shell/routes';

export { DJ_PATH, HOME_PATH, PROOF_STEM_PATH, ROBLOX_PATH, STUDIO_PATH, pathOf } from '@kelasmalam/shell/routes';

export type Route = Extract<AnyRoute, 'studio' | 'dj' | 'roblox' | 'proof-stem'>;

/** Trailing slash diabaikan; yang tidak dikenal (termasuk `/`) = studio. */
export const routeOf: (pathname: string) => Route = makeRouteOf<Route>(['studio', 'dj', 'roblox', 'proof-stem'], 'studio');
