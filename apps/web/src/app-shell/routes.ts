/**
 * Tabel path → route. Dipisah dari komponen supaya bisa dites tanpa React, dan
 * supaya halaman keempat cukup menambah SATU baris di sini.
 */

export type Route =
  | 'landing'
  | 'studio'
  | 'dj'
  | 'roblox'
  | 'proof-stem'
  | 'privacy-policy'
  | 'terms-of-service';

export const HOME_PATH = '/';
export const STUDIO_PATH = '/studio';
export const DJ_PATH = '/dj';
export const ROBLOX_PATH = '/roblox';
export const PROOF_STEM_PATH = '/proof-stem';
export const PRIVACY_POLICY_PATH = '/privacy-policy';
export const TERMS_OF_SERVICE_PATH = '/terms-of-service';

const TABLE: Readonly<Record<string, Route>> = {
  [STUDIO_PATH]: 'studio',
  [DJ_PATH]: 'dj',
  [ROBLOX_PATH]: 'roblox',
  [PROOF_STEM_PATH]: 'proof-stem',
  [PRIVACY_POLICY_PATH]: 'privacy-policy',
  [TERMS_OF_SERVICE_PATH]: 'terms-of-service',
};

/** Trailing slash diabaikan supaya `/studio/` tidak jatuh ke landing. */
export function routeOf(pathname: string): Route {
  return TABLE[pathname.replace(/\/+$/, '')] ?? 'landing';
}

export function pathOf(route: Route): string {
  if (route === 'studio') return STUDIO_PATH;
  if (route === 'dj') return DJ_PATH;
  if (route === 'roblox') return ROBLOX_PATH;
  if (route === 'proof-stem') return PROOF_STEM_PATH;
  if (route === 'privacy-policy') return PRIVACY_POLICY_PATH;
  if (route === 'terms-of-service') return TERMS_OF_SERVICE_PATH;
  return HOME_PATH;
}
