/**
 * Tabel path → route milik app DESKTOP (docs/25 P2).
 *
 * Tidak ada `landing`, `privacy-policy`, `terms-of-service`: itu halaman
 * situs, bukan halaman aplikasi yang dipasang di mesin orang. `/` (dan path
 * apa pun yang tidak dikenal) jatuh ke STUDIO — aplikasi dibuka langsung di
 * tempat kerja, bukan di beranda (docs/25 §5 "Landing di desktop").
 *
 * `composer` dan `dj` SENGAJA TIDAK ADA di sini. Keduanya masih hidup
 * sebagai paket (`@kelasmalam/composer`, `@kelasmalam/dj`) dan `dj` tetap
 * dipakai app web; yang dicabut hanyalah pintu masuknya di desktop, karena
 * belum dibutuhkan. Itu dilakukan dengan MENGHAPUSNYA dari daftar ini, bukan
 * dengan bendera `if` di dalam halaman (docs/25 §1c: "fitur ini ada atau
 * tidak dijawab lewat komposisi"). Mengembalikannya = menambah namanya lagi
 * di `Route` + `makeRouteOf`, dan cabangnya di `AppShell`.
 *
 * `HOME_PATH` tetap `/` supaya command `shell.goto.home` (menu native
 * "Beranda", `src-tauri/src/menu.rs`) tetap punya sasaran; di desktop sasaran
 * itu adalah Studio. Konstanta path dan `pathOf` dari
 * `@kelasmalam/shell/routes` (docs/25 P3) — yang milik app hanya DAFTAR-nya.
 */

import { makeRouteOf, type Route as AnyRoute } from '@kelasmalam/shell/routes';

export { HOME_PATH, PROOF_STEM_PATH, ROBLOX_PATH, STUDIO_PATH, pathOf } from '@kelasmalam/shell/routes';

export type Route = Extract<AnyRoute, 'studio' | 'roblox' | 'proof-stem'>;

/** Trailing slash diabaikan; yang tidak dikenal (termasuk `/`) = studio. */
export const routeOf: (pathname: string) => Route = makeRouteOf<Route>(['studio', 'roblox', 'proof-stem'], 'studio');
