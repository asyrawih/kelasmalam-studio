/**
 * Impor YouTube — HANYA desktop (docs/23).
 *
 * Tidak ada versi web: browser tidak bisa mengambil audio YouTube (tidak ada
 * URL audio publik, domainnya memblokir CORS), dan tidak ada server milik
 * kita yang mau mengunduhnya atas nama user. Di desktop yang bekerja adalah
 * binari `yt-dlp` + `qjs` yang diunduh sekali ke `<app_data_dir>/tools/` dan
 * dijalankan Rust sebagai subprocess; modul ini pembungkus bertipe
 * command-nya (`youtube_*` di `local-commands.ts`), pengenal URL, dan cache
 * status perkakas seumur sesi (lihat "Cache status perkakas" di bawah).
 *
 * Pemakainya dua: `YouTubeDialog` (tempel URL, lihat judulnya, taruh ke lane)
 * dan `import.ts` (link YouTube yang di-drop/di-paste ke lane, hanya di
 * desktop — lihat `url-to-lane.ts`).
 */

import { callLocal, isLocalError } from '../platform/local-invoke';
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

// ── Cache status perkakas ──────────────────────────────────────────────────
//
// `youtube_status` yang menjawab `ready` berarti Rust sudah menjalankan
// `yt-dlp --version`: bundel PyInstaller yang membongkar runtime Python-nya
// dulu setiap start — 1–3 detik dan berat CPU. Yang menanyakannya sering:
// `YouTubeDialog` tiap dibuka dan `import.ts` tiap link di-drop. Tanpa cache,
// buka-tutup modal berkali = proses Python berkali.
//
// Rust sendiri sudah men-cache versinya per sidik jari berkas
// (`youtube.rs::status`), jadi ini lapis kedua: yang dihapus di sini adalah
// IPC-nya (plus dua `stat` berkas di sisi Rust), dan — yang kelihatan user —
// dialog bisa langsung menampilkan SIAP tanpa kedip "MEMERIKSA PERKAKAS".
// Lapis Rust tetap diperlukan: proses desktop bisa memanggil `status` dari
// jalur lain, dan sidik jari berkas adalah satu-satunya yang tahu binari
// diganti dari luar app.
//
// Yang di-cache HANYA status yang `ready`. "Belum terpasang" murah di sisi
// Rust (berkasnya tidak ada, tidak ada proses yang dijalankan) dan bisa
// berubah kapan saja, jadi ia selalu ditanyakan lagi. Umur cache = satu sesi
// aplikasi, tanpa TTL: yang bisa membuatnya salah hanyalah binari yang
// berubah, dan itu selalu lewat `youtubeSetup`/`youtubeUpdate` di modul ini
// atau berakhir sebagai galat `IO` (yt-dlp gagal dijalankan) yang juga
// membuang cache-nya.
let cachedStatus: YoutubeStatus | null = null;

/** Pemeriksaan yang sedang berjalan; dua pemanggil bersamaan ikut yang sama. */
let inFlightStatus: Promise<YoutubeStatus> | null = null;

/** Status yang sudah diketahui TANPA menyentuh Rust; `null` = belum pernah `ready`. */
export function peekYoutubeStatus(): YoutubeStatus | null {
  return cachedStatus;
}

/** Buang status yang di-cache — pemeriksaan berikutnya menanyakan Rust lagi. */
export function forgetYoutubeStatus(): void {
  cachedStatus = null;
}

/**
 * Buang cache kalau `cause` menandakan yt-dlp-nya sendiri tidak bisa
 * dijalankan: binari hilang/rusak membuat `spawn` di Rust gagal, dan itu
 * sampai ke sini sebagai kode `IO`. Kode `YOUTUBE` TIDAK membuangnya — itu
 * yt-dlp yang menjawab dengan keluhannya sendiri (video privat, dibatasi
 * umur, URL salah), jadi perkakasnya jelas hidup.
 */
export function forgetYoutubeStatusIfToolsBroken(cause: unknown): void {
  if (isLocalError(cause) && cause.code === 'IO') forgetYoutubeStatus();
}

/**
 * `youtube_status` lewat cache di atas: jawaban `ready` yang pernah didapat
 * dipakai ulang sepanjang sesi, dan dua pemanggil yang datang bersamaan
 * (modal dibuka sementara link di-drop) hanya menghasilkan satu IPC.
 */
export function youtubeStatus(): Promise<YoutubeStatus> {
  if (cachedStatus !== null) return Promise.resolve(cachedStatus);
  if (inFlightStatus !== null) return inFlightStatus;
  const pending: Promise<YoutubeStatus> = callLocal('youtube_status', {})
    .then((s) => {
      if (s.ready) cachedStatus = s;
      return s;
    })
    .finally(() => {
      // Hanya kalau belum digantikan pemeriksaan yang lebih baru.
      if (inFlightStatus === pending) inFlightStatus = null;
    });
  inFlightStatus = pending;
  return pending;
}

/**
 * Unduh yt-dlp + qjs yang belum ada. Progres lewat `subscribeYoutubeProgress`
 * (`phase: 'tools'`). Jawabannya adalah status baru sesudah unduhan, jadi
 * langsung menjadi isi cache — tidak ada `youtube_status` menyusul.
 */
export function youtubeSetup(): Promise<YoutubeStatus> {
  return callLocal('youtube_setup', {}).then((s) => {
    cachedStatus = s.ready ? s : null;
    return s;
  });
}

/** Ganti yt-dlp dengan rilis terbaru kalau berbeda. `true` = diganti. */
export function youtubeUpdate(): Promise<boolean> {
  return callLocal('youtube_update', {}).then(
    (changed) => {
      // Diganti → versi di cache basi. Tidak diganti → cache masih sah.
      if (changed) forgetYoutubeStatus();
      return changed;
    },
    (cause: unknown) => {
      // Gagal di tengah jalan: tidak ada jaminan soal berkas di disk.
      forgetYoutubeStatus();
      throw cause;
    },
  );
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
