/**
 * Link YouTube → clip di lane, HANYA desktop (docs/23).
 *
 * Dipanggil `url-to-lane.ts` untuk link YouTube yang di-drop atau di-paste
 * ke lane. Jalurnya sama dengan `YouTubeDialog`: `youtube_info` untuk judul
 * dan ekstensi, `youtube_bytes` untuk audionya, lalu `importBytesToLane` —
 * decoder dan bentuk clip yang SAMA dengan drop berkas.
 *
 * Perkakas yang belum terpasang TIDAK diunduh diam-diam dari sini: drop
 * satu link yang lalu mengunduh 40 MB binari tanpa ditanya adalah kejutan.
 * Pesannya menunjuk ke dialog YOUTUBE, tempat unduhan itu terlihat.
 */

import { importBytesToLane, type DropResult, type LaneImportOptions } from '../studio/timeline/audio-import';
import { isLocalError } from '../platform/local-invoke';
import { subscribeYoutubeProgress, youtubeAudio, youtubeFileName, youtubeInfo, youtubeStatus } from './api';

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
    return { ok: false, reason: reasonOf(cause) };
  }
}
