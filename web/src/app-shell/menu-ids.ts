/**
 * Id command yang boleh dipakai MENU NATIVE desktop (docs/20 §2d, fase D5).
 *
 * Menu Rust di `desktop/src-tauri/src/menu.rs` harus memakai SUBSET dari
 * daftar ini — tiap item menu mengirim `daw://menu-command` dengan salah satu
 * id di bawah, dan `app-shell/desktop.ts` menyerahkannya ke registry yang sama
 * dengan keyboard dan palette `⌘K`.
 *
 * Daftar ini adalah daftar yang DIHARAPKAN, bukan yang dibaca dari registry
 * saat runtime: gunanya justru supaya ada tes (`menu-ids.test.tsx`) yang
 * gagal kalau sebuah id di sini diganti namanya di halaman pemiliknya — bug
 * yang kalau tidak dijaga hanya muncul sebagai item menu yang diam saja di
 * mesin user. Sisi Rust tidak bisa ikut tes itu, jadi kalau menambah id di
 * `menu.rs`, tambahkan di sini dulu.
 *
 * Halaman pemilik tiap id ditentukan dari awalannya (`menuCommandRoute`):
 * `shell.*` hidup di semua halaman; `library.*` ikut Studio (dock kepustakaan
 * dirender di sana); `dj.*` dan `roblox.*` ikut halamannya. Id yang dipanggil
 * saat halamannya tidak aktif diabaikan dengan peringatan — lihat
 * `dispatchMenuCommand`.
 */

import type { Route } from './routes';

export const DESKTOP_MENU_COMMAND_IDS = [
  // ── Aplikasi (menu app / File / View) — semua halaman ──
  /** "Pengaturan…" — `⌘,` konvensi macOS; membuka editor pintasan. */
  'shell.preferences',
  'shell.palette',
  'shell.keymap',
  'shell.goto.home',
  'shell.goto.studio',
  'shell.goto.dj',
  'shell.goto.roblox',
  'shell.goto.proof-stem',

  // ── Studio ──
  // Studio belum mendaftarkan command transport ke registry (docs/15 "Yang
  // SENGAJA belum dipindahkan"); yang bisa dipanggil menu baru dock kepustakaan.
  'library.toggle',

  // ── DJ ──
  'dj.deckA.playPause',
  'dj.deckB.playPause',
  'dj.focused.playPause',
  'dj.focus.toggle',
  'dj.crossfader.center',
  'dj.fx.toggle',
  'dj.grid.toggle',
  'dj.grid.undo',
  'dj.grid.redo',

  // ── Roblox ──
  'roblox.bersihkan-selesai',
  'roblox.kosongkan',
] as const;

export type DesktopMenuCommandId = (typeof DESKTOP_MENU_COMMAND_IDS)[number];

/** Awalan id → halaman pemilik. Awalan baru di daftar HARUS ditambahkan di sini. */
const ROUTE_BY_PREFIX: Readonly<Record<string, Route | 'any'>> = {
  shell: 'any',
  library: 'studio',
  dj: 'dj',
  roblox: 'roblox',
};

/**
 * Halaman yang mendaftarkan sebuah id menu, atau `'any'` untuk command shell
 * yang hidup di mana pun. Dipakai tes penjaga untuk tahu halaman mana yang
 * harus dirender sebelum memeriksa registry. Awalan tanpa pemilik melempar —
 * itu kesalahan penulisan daftar, dan tes yang memanggilnya harus gagal keras.
 */
export function menuCommandRoute(id: string): Route | 'any' {
  const prefix = id.split('.')[0] ?? '';
  const route = ROUTE_BY_PREFIX[prefix];
  if (route === undefined) throw new Error(`awalan id menu "${prefix}" tidak punya halaman pemilik`);
  return route;
}
