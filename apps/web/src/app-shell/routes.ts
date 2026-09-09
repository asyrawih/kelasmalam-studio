/**
 * Tabel route milik app WEB: semua halaman, termasuk landing dan dua halaman
 * legal; path yang tidak dikenal jatuh ke landing. Konstanta path dan
 * `pathOf` datang dari `@kelasmalam/shell/routes` (docs/25 P3) supaya kedua
 * app menyebut string yang sama; yang milik app hanya DAFTAR-nya.
 */

import { makeRouteOf, type Route } from '@kelasmalam/shell/routes';

export {
  DJ_PATH,
  HOME_PATH,
  PRIVACY_POLICY_PATH,
  PROOF_STEM_PATH,
  ROBLOX_PATH,
  STUDIO_PATH,
  TERMS_OF_SERVICE_PATH,
  pathOf,
  type Route,
} from '@kelasmalam/shell/routes';

export const routeOf: (pathname: string) => Route = makeRouteOf<Route>(
  ['studio', 'dj', 'roblox', 'proof-stem', 'privacy-policy', 'terms-of-service'],
  'landing',
);
