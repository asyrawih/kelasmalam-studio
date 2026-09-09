/**
 * Transport SoundCloud untuk desktop: dijawab DI DALAM PROSES oleh Rust,
 * bukan oleh server.
 *
 * Desktop tidak butuh `soundcloud.kelasmalam.app` sama sekali: pustaka
 * `soundclaude` yang menjalankan server itu ditanam di crate desktop
 * (`crates/desktop-host/src/soundcloud.rs`) dan berbicara langsung dengan
 * SoundCloud. Dua command (`soundcloud_json`, `soundcloud_bytes`) menerima
 * URL yang sama dengan yang dipakai web — hanya path + query yang dibaca —
 * dan menjawab dengan bentuk yang sama, jadi `SoundCloudApi` tidak tahu
 * bedanya. Tidak ada CORS, tidak ada server yang bisa "offline".
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
