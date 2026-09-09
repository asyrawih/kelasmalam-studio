/**
 * Pintu untuk mendapatkan `PlatformHost` (kontrak di `host.ts`).
 *
 * Paket ini tidak tahu web maupun desktop (docs/25 §1d): tidak ada
 * pemeriksaan Tauri, tidak ada `createWebHost()`. Yang memutuskan host mana yang
 * dipakai adalah APP, lewat `registerPlatformHostResolver`.
 *
 * Kenapa RESOLVER (fungsi), bukan `setPlatformHost(instance)` di `main.tsx`:
 * worker tidak pernah menjalankan `main.tsx`. Modul yang butuh host di dalam
 * worker (mis. `proof-stem/scnet-model.ts` lewat `stem/auto-stem.worker.ts`)
 * mengimpor modul platform milik app-nya, dan modul itulah yang mendaftarkan
 * resolver saat dimuat — di main thread maupun di worker. Jadi worker tetap
 * mendapat host yang benar (web, karena penanda Tauri tidak ada di sana) tanpa
 * seorang pun harus mengingat memasangnya. Resolver dipanggil MALAS, sekali,
 * pada `getPlatformHost()` pertama.
 */

import type { PlatformHost } from './host';

let host: PlatformHost | null = null;
let resolver: (() => PlatformHost) | null = null;

function missing(): never {
  throw new Error(
    'PlatformHost belum terdaftar: modul platform app harus memanggil ' +
      'registerPlatformHostResolver() saat dimuat (apps/web/src/platform/index.ts).',
  );
}

/** Dipanggil app (main thread maupun worker) saat modul platform-nya dimuat. */
export function registerPlatformHostResolver(fn: () => PlatformHost): void {
  resolver = fn;
  host = null;
}

export function getPlatformHost(): PlatformHost {
  host ??= (resolver ?? missing)();
  return host;
}

/** `null` mengembalikan pemilihan otomatis lewat resolver yang terdaftar. */
export function setPlatformHostForTests(next: PlatformHost | null): void {
  host = next;
}
