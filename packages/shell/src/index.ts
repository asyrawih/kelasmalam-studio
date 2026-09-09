/**
 * `@kelasmalam/shell` — registry command, keymap, dispatcher keyboard, dan
 * command palette (docs/15), tanpa satu pun cabang platform (docs/25 §1b).
 *
 * Yang SENGAJA tidak ada di sini: `AppShell` (komposisi halaman milik tiap
 * app), `routes` (tabel per app), `VersionTag` (bergantung `build-info` app),
 * `KeymapEditor` (punya slot `storeSettings` yang diisi app), dan
 * `window/desktop.ts` (menu native, judul jendela Tauri — hanya di
 * `apps/desktop`). Yang MURNI dari urusan jendela — aturan judul dan alasan
 * penjaga tutup (`title.ts`) — ada di sini, karena web dan desktop memakai
 * aturan yang sama lewat pintu yang berbeda (docs/25 P2).
 */

export * from './command';
export * from './keymap';
export * from './keys';
export * from './useCommands';
export * from './CommandPalette';
export * from './useKeyDispatch';
export * from './title';
