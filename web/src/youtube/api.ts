/**
 * Impor YouTube — HANYA desktop (docs/23).
 *
 * Tidak ada versi web: browser tidak bisa mengambil audio YouTube (tidak ada
 * URL audio publik, domainnya memblokir CORS), dan tidak ada server milik
 * kita yang mau mengunduhnya atas nama user. Di desktop yang bekerja adalah
 * binari `yt-dlp` + `qjs` yang diunduh sekali ke `<app_data_dir>/tools/` dan
 * dijalankan Rust sebagai subprocess; modul ini hanya pembungkus bertipe
 * command-nya (`youtube_*` di `local-commands.ts`) plus pengenal URL.
 *
 * Pemakainya dua: `YouTubeDialog` (tempel URL, lihat judulnya, taruh ke lane)
 * dan `import.ts` (link YouTube yang di-drop/di-paste ke lane, hanya di
 * desktop — lihat `url-to-lane.ts`).
 */

import { callLocal } from '../platform/local-invoke';
import {
  LOCAL_EVENTS,
  type YoutubeInfo,
  type YoutubeProgress,
  type YoutubeStatus,
} from '../platform/local-commands';

export type { YoutubeInfo, YoutubeProgress, YoutubeStatus };

/** Host yang ditangani yt-dlp sebagai YouTube. `music.youtube.com` ikut lewat `.youtube.com`. */
const YOUTUBE_HOST = /(^|\.)youtube\.com$|(^|\.)youtu\.be$|(^|\.)youtube-nocookie\.com$/i;

/** `true` untuk URL http(s) yang host-nya YouTube. Teks lain (termasuk URL selain http) `false`. */
export function isYoutubeUrl(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '' || /\s/.test(trimmed)) return false;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return YOUTUBE_HOST.test(url.hostname.toLowerCase());
}

export function youtubeStatus(): Promise<YoutubeStatus> {
  return callLocal('youtube_status', {});
}

/** Unduh yt-dlp + qjs yang belum ada. Progres lewat `subscribeYoutubeProgress` (`phase: 'tools'`). */
export function youtubeSetup(): Promise<YoutubeStatus> {
  return callLocal('youtube_setup', {});
}

/** Ganti yt-dlp dengan rilis terbaru kalau berbeda. `true` = diganti. */
export function youtubeUpdate(): Promise<boolean> {
  return callLocal('youtube_update', {});
}

export function youtubeInfo(url: string): Promise<YoutubeInfo> {
  return callLocal('youtube_info', { url });
}

/** Byte audio (m4a bila ada). Progres lewat `subscribeYoutubeProgress` (`phase: 'audio'`, `name` = id video). */
export function youtubeAudio(url: string): Promise<ArrayBuffer> {
  return callLocal('youtube_bytes', { url });
}

/**
 * Dengarkan `daw://youtube-progress`. Mengembalikan pencabutnya SEGERA —
 * pemasangannya sendiri async (modul event Tauri di-`import()` dinamis
 * supaya bundel web tidak membawanya), dan mencabut sebelum terpasang tetap
 * benar: pendengar yang datang telat langsung dilepas lagi.
 */
export function subscribeYoutubeProgress(onProgress: (p: YoutubeProgress) => void): () => void {
  let disposed = false;
  let unlisten: (() => void) | null = null;
  void import('@tauri-apps/api/event')
    .then(({ listen }) =>
      listen<YoutubeProgress>(LOCAL_EVENTS.youtubeProgress, (event) => {
        if (!disposed) onProgress(event.payload);
      }),
    )
    .then((un) => {
      if (disposed) un();
      else unlisten = un;
    })
    .catch(() => {
      /* tanpa progres, unduhan tetap jalan — barnya saja yang diam */
    });
  return () => {
    disposed = true;
    unlisten?.();
  };
}

/** `191` → `3:11`; 0 → `—` (durasi tidak diketahui). */
export function formatYoutubeDuration(sec: number): string {
  if (!(sec > 0)) return '—';
  const whole = Math.round(sec);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** Nama berkas untuk clip: judul + ekstensi format audionya (`Lagu.m4a`). */
export function youtubeFileName(info: YoutubeInfo): string {
  const title = info.title.trim() === '' ? info.id : info.title.trim();
  const ext = info.ext.trim() === '' ? 'm4a' : info.ext.trim();
  return `${title}.${ext}`;
}
