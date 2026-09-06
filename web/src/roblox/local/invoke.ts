/**
 * `invoke` bertipe untuk command Tauri yang dipakai halaman Roblox.
 *
 * Tipenya diambil dari KONTRAK (`platform/local-commands.ts`) — nama command,
 * bentuk argumen, dan bentuk hasil dijamin sama dengan yang dilihat sisi Rust.
 * Pembungkus ini tinggal di `roblox/` supaya tidak menyentuh `platform/`
 * yang dikerjakan agen lain; begitu keduanya bertemu, ia tinggal dipindah.
 *
 * ## Kenapa `import()` dinamis, bukan `import` statis
 *
 * `@tauri-apps/api/core` di-mock di beberapa suite tes dengan hanya `isTauri`
 * — tanpa `invoke`. Dengan import statis, mengakses `invoke` yang tidak ada di
 * mock adalah lemparan SINKRON di tempat yang tidak siap menangkapnya. Dengan
 * `import()` di dalam fungsi async, kegagalan apa pun menjadi promise yang
 * ditolak, dan setiap pemanggil di halaman ini memang sudah menunggu promise
 * yang bisa ditolak (Rust juga menolak dengan `LocalError`).
 */

import type { LocalCommandName, LocalCommands } from '../../platform/local-commands';

// Satu promise import per modul, dipakai bersama: `Promise.all` empat command
// saat restore memulai empat `import()` serempak, dan modul yang sama dimuat
// sekali saja — bukan empat kali, dengan hasil yang bisa berbeda di mocker tes.
let core: Promise<typeof import('@tauri-apps/api/core')> | null = null;
let event: Promise<typeof import('@tauri-apps/api/event')> | null = null;
const coreModule = () => (core ??= import('@tauri-apps/api/core'));
const eventModule = () => (event ??= import('@tauri-apps/api/event'));

export async function localInvoke<K extends LocalCommandName>(
  cmd: K,
  args: LocalCommands[K]['args'],
): Promise<LocalCommands[K]['result']> {
  const { invoke } = await coreModule();
  // Interface kontrak tidak punya index signature, jadi tidak otomatis cocok
  // dengan `Record<string, unknown>` milik Tauri — bentuknya sendiri sudah
  // dijaga oleh parameter `args` di atas.
  return (await invoke(cmd, args as unknown as Record<string, unknown>)) as LocalCommands[K]['result'];
}

/**
 * `library_put_bytes`: badan mentah, metadata lewat header — lagu 20 MB
 * sebagai JSON array angka adalah 80 MB teks yang di-parse main thread.
 */
export async function localPutBytes(bytes: Uint8Array, hash: string, ext: string): Promise<void> {
  const { invoke } = await coreModule();
  await invoke('library_put_bytes', bytes, { headers: { 'x-hash': hash, 'x-ext': ext } });
}

/** `listen` Tauri, dengan alasan dinamis yang sama seperti `localInvoke`. */
export async function localListen<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  const { listen } = await eventModule();
  return listen<T>(event, (e) => handler(e.payload));
}
