/**
 * Path dan nama route yang DIBAGI dua app (docs/25 P3).
 *
 * Konstanta path tinggal di sini supaya `shell.goto.*`, menu native
 * (`menu.rs` → `window/menu-ids.ts`), dan halaman yang menautkan halaman lain
 * menyebut string yang sama di web maupun desktop. TABELNYA tidak: web punya
 * landing + halaman legal dan path tak dikenal jatuh ke landing; desktop
 * membuka Studio untuk apa pun yang tidak dikenal (docs/25 §5). Tiap app
 * membangun `routeOf`-nya dari daftar route yang memang ia punya lewat
 * [`makeRouteOf`], jadi menambah halaman keempat tetap satu baris di app —
 * dan halaman yang tidak ada di sebuah app memang tidak bisa dituju di sana.
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

/** Path kanonis tiap route — satu jawaban untuk `pathOf` di semua app. */
export const PATH_OF: Readonly<Record<Route, string>> = {
  landing: HOME_PATH,
  studio: STUDIO_PATH,
  dj: DJ_PATH,
  roblox: ROBLOX_PATH,
  'proof-stem': PROOF_STEM_PATH,
  'privacy-policy': PRIVACY_POLICY_PATH,
  'terms-of-service': TERMS_OF_SERVICE_PATH,
};

export function pathOf(route: Route): string {
  return PATH_OF[route];
}

/**
 * `routeOf` untuk satu app: hanya `routes` yang dikenali, sisanya `fallback`.
 * Trailing slash diabaikan supaya `/studio/` tidak jatuh ke fallback.
 */
export function makeRouteOf<R extends Route>(
  routes: readonly R[],
  fallback: R,
): (pathname: string) => R {
  const table = new Map<string, R>();
  for (const r of routes) table.set(PATH_OF[r], r);
  return (pathname) => table.get(pathname.replace(/\/+$/, '')) ?? fallback;
}
