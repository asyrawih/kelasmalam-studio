/**
 * Transport SoundCloud untuk desktop: lewat Rust, bukan `fetch`.
 *
 * Dari WebView desktop, `fetch` ke server discovery mati di CORS — origin
 * `tauri://localhost` (macOS) dan `http://tauri.localhost` (Windows) bukan
 * origin yang dikenal server, dan tidak ada log di sisi mana pun yang
 * menyebutkannya. Rust tidak punya CORS. Dua command (`soundcloud_json`,
 * `soundcloud_bytes`) meneruskan permintaan; allowlist host-nya ada di Rust.
 *
 * `AbortSignal` dihormati sebisanya: command Tauri tidak bisa dibatalkan di
 * tengah, jadi yang bisa dijanjikan adalah hasilnya DIBUANG kalau sinyal
 * sudah dibatalkan — dialognya menutup, hasil pencarian yang datang telat
 * tidak menimpa apa pun.
 */

import { callLocal } from '../platform/local-invoke';
import type { SoundCloudTransport } from './api';

function abortError(): Error {
  const err = new Error('dibatalkan');
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

export const desktopTransport: SoundCloudTransport = {
  async json(url, signal) {
    throwIfAborted(signal);
    const reply = await callLocal('soundcloud_json', { url });
    throwIfAborted(signal);
    return reply;
  },
  async bytes(url, signal) {
    throwIfAborted(signal);
    const bytes = await callLocal('soundcloud_bytes', { url });
    throwIfAborted(signal);
    return bytes;
  },
};
