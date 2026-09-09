/**
 * Pintu `app-shell` milik app web: `AppShell` dan tabel route-nya. Registry
 * command, keymap, palette, `VersionTag`, dan `KeymapEditor` adalah milik
 * `@kelasmalam/shell` (docs/25 P1, P3) dan diimpor dari sana langsung.
 */

export { AppShell, type AppShellProps } from './AppShell';
export { routeOf, pathOf, type Route } from './routes';
