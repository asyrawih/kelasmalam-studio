/**
 * Pintu `app-shell` milik app: gabungan `@kelasmalam/shell` (registry command,
 * keymap, palette — docs/25 P1) dan yang tetap di sini karena bergantung pada
 * app (`AppShell`, `routes`, `VersionTag` → `build-info`). Importer lama
 * (`from '../app-shell'`) tidak perlu tahu pembagian itu.
 */

export { AppShell, type AppShellProps } from './AppShell';
export { routeOf, pathOf, type Route } from './routes';
export { VersionTag, type VersionTagProps } from './VersionTag';
export { useCommands, chordLabel, chordFor, type Command, type CommandHold, type CommandId } from '@kelasmalam/shell';
