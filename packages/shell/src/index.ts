/**
 * `@kelasmalam/shell` — registry command, keymap, dispatcher keyboard, dan
 * command palette (docs/15), tanpa satu pun cabang platform (docs/25 §1b).
 *
 * Yang SENGAJA tidak ada di sini: `AppShell` (komposisi halaman milik tiap
 * app), `routes` (tabel per app), `VersionTag` (bergantung `build-info` app),
 * `KeymapEditor` (bergantung `StoreSettings` kepustakaan), dan `desktop.ts`
 * (menu native, judul jendela). Semuanya tinggal di `apps/web/src/app-shell`,
 * yang `index.ts`-nya mengekspor ulang gabungan keduanya.
 */

export * from './command';
export * from './keymap';
export * from './keys';
export * from './useCommands';
export * from './CommandPalette';
export * from './useKeyDispatch';
