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
 *
 * ## Dua tingkat: resolver APP dan resolver BAWAAN (docs/25 P2)
 *
 * Sejak ada dua app, modul bersama yang masih tinggal di `apps/web/src`
 * (studio, roblox, kepustakaan; TODO(P3)) mengimpor `apps/web/src/platform`
 * — yang mendaftarkan host WEB saat dimuat — dan modul-modul itu juga dimuat
 * oleh app DESKTOP. Kalau keduanya memakai satu slot, yang menang adalah yang
 * kebetulan dimuat terakhir, dan itu bukan sesuatu yang boleh ditentukan
 * urutan `import`. Maka:
 *
 *   - `registerDefaultPlatformHostResolver`: dipakai modul bersama
 *     (`apps/web/src/platform/index.ts`). Hanya berlaku kalau tidak ada
 *     resolver app. Di worker desktop hanya ini yang ada, dan host web memang
 *     yang benar di sana (tidak ada IPC di worker).
 *   - `registerPlatformHostResolver`: dipakai APP (`apps/desktop/src/platform/
 *     index.ts`). Selalu menang, apa pun urutan pemuatan.
 *
 * Di app web hanya bawaan yang terdaftar, jadi perilakunya persis seperti
 * sebelum P2.
 */

import type { PlatformHost } from './host';

let host: PlatformHost | null = null;
let resolver: (() => PlatformHost) | null = null;
let fallback: (() => PlatformHost) | null = null;

function missing(): never {
  throw new Error(
    'PlatformHost belum terdaftar: modul platform app harus memanggil ' +
      'registerPlatformHostResolver() (apps/desktop/src/platform/index.ts) atau ' +
      'registerDefaultPlatformHostResolver() (apps/web/src/platform/index.ts) saat dimuat.',
  );
}

/** Dipanggil APP (main thread maupun worker) saat modul platform-nya dimuat. Selalu menang. */
export function registerPlatformHostResolver(fn: () => PlatformHost): void {
  resolver = fn;
  host = null;
}

/**
 * Dipanggil modul BERSAMA yang membawa host bawaannya sendiri. Tidak menimpa
 * resolver app; host yang sudah dibuat dari bawaan sebelumnya dibuang supaya
 * bawaan yang baru berlaku pada `getPlatformHost()` berikutnya.
 */
export function registerDefaultPlatformHostResolver(fn: () => PlatformHost): void {
  fallback = fn;
  if (resolver === null) host = null;
}

export function getPlatformHost(): PlatformHost {
  host ??= (resolver ?? fallback ?? missing)();
  return host;
}

/** `null` mengembalikan pemilihan otomatis lewat resolver yang terdaftar. */
export function setPlatformHostForTests(next: PlatformHost | null): void {
  host = next;
}
