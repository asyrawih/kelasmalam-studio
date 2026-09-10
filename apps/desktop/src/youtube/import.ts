/**
 * Link YouTube → clip di lane, HANYA desktop (docs/23).
 *
 * Dipanggil `url-to-lane.ts` (lewat `youtubeUrlImporter` yang didaftarkan
 * `main.tsx`, docs/25 §1c) untuk link YouTube yang di-drop atau di-paste ke
 * lane. Jalurnya sama dengan `YouTubeDialog`: `youtube_info` untuk judul dan
 * ekstensi, `youtube_bytes` untuk audionya, lalu `importBytesToLane` —
 * decoder dan bentuk clip yang SAMA dengan drop berkas.
 *
 * Perkakas yang belum terpasang TIDAK diunduh diam-diam dari sini: drop
 * satu link yang lalu mengunduh 40 MB binari tanpa ditanya adalah kejutan.
 * Pesannya menunjuk ke dialog YOUTUBE, tempat unduhan itu terlihat.
 */

import { importBytesToLane, type DropResult, type LaneImportOptions } from '@kelasmalam/studio/studio/timeline/audio-import';
import type { UrlImporter } from '@kelasmalam/studio/studio/timeline/url-to-lane';
import { isLocalError } from '../platform/local-invoke';
import {
  forgetYoutubeStatusIfToolsBroken,
  subscribeYoutubeProgress,
  youtubeAudio,
  youtubeFileName,
  youtubeInfo,
  youtubeStatus,
} from './api';

export const YOUTUBE_TOOLS_MISSING =
  'perkakas YouTube (yt-dlp) belum terpasang — buka YOUTUBE di header lalu tekan SIAPKAN';

function reasonOf(cause: unknown): string {
  if (isLocalError(cause)) return cause.message;
  return cause instanceof Error ? cause.message : String(cause);
}

export async function importYoutubeToLane(
  text: string,
  laneId: string,
  startSamples: number,
  projectSampleRate: number,
  opts: LaneImportOptions = {},
): Promise<DropResult> {
  const url = text.trim();
  try {
    // Lewat cache `api.ts`: link kedua yang di-drop tidak menjalankan
    // `yt-dlp --version` lagi, dan status yang belum `ready` tetap ditanyakan
    // (murah — berkasnya tidak ada) supaya SIAPKAN yang baru selesai terbaca.
    const status = await youtubeStatus();
    if (!status.ready) return { ok: false, reason: YOUTUBE_TOOLS_MISSING };

    opts.onProgress?.({ stage: 'reading', ratio: null });
    const info = await youtubeInfo(url);

    // Progres unduhan → tahap `reading` dengan rasio; event video lain (dua
    // impor bersamaan) disaring lewat id.
    const unsubscribe = subscribeYoutubeProgress((p) => {
      if (p.phase !== 'audio' || p.name !== info.id) return;
      opts.onProgress?.({ stage: 'reading', ratio: p.total > 0 ? Math.min(1, p.done / p.total) : null });
    });
    let bytes: ArrayBuffer;
    try {
      bytes = await youtubeAudio(url);
    } finally {
      unsubscribe();
    }

    return importBytesToLane(bytes, youtubeFileName(info), laneId, startSamples, projectSampleRate, opts);
  } catch (cause: unknown) {
    // Binari hilang/rusak (`spawn` gagal → kode `IO`) membatalkan cache
    // `ready`; drop berikutnya memeriksa perkakas lagi.
    forgetYoutubeStatusIfToolsBroken(cause);
    return { ok: false, reason: reasonOf(cause) };
  }
}

/**
 * Importer yang didaftarkan `main.tsx` ke `registerUrlImporter` (docs/25 §1c):
 * hanya link yang `classifyUrl` golongkan sebagai YouTube; host lain yang
 * butuh server (SoundCloud, Mixcloud) TIDAK ikut dibelokkan — mereka tetap
 * mendapat pesan lama dari `url-to-lane.ts`.
 */
export const youtubeUrlImporter: UrlImporter = {
  matches: (cls) => cls.kind === 'needs-server' && cls.service === 'YouTube',
  import: (text, laneId, startSamples, projectSampleRate, opts) =>
    importYoutubeToLane(text, laneId, startSamples, projectSampleRate, opts),
};
