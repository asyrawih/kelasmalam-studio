/**
 * Jembatan tipis: URL → byte → jalur import yang sama dengan drop file.
 *
 * Sengaja terpisah dari `url-import.ts` (yang murni jaringan, tanpa store) dan
 * dari `audio-import.ts` (yang murni decode) supaya keduanya tetap bisa dites
 * tanpa saling menyeret.
 *
 * ## YouTube, hanya di desktop
 *
 * `classifyUrl` menggolongkan YouTube sebagai `needs-server`: dari browser
 * memang tidak akan pernah bisa. Di desktop ada jalan lain — yt-dlp yang
 * dijalankan Rust (docs/23) — jadi link YouTube dibelokkan ke sana SEBELUM
 * menyentuh `fetch`. Di web pesannya tetap yang lama: unduh dulu, lalu drop
 * berkasnya.
 */

import { getPlatformHost } from '../../platform';
import { importYoutubeToLane } from '../../youtube/import';
import { importBytesToLane, type DropResult, type LaneImportOptions } from './audio-import';
import { classifyUrl, fetchAudioUrl } from './url-import';

export async function importUrlToLane(
  text: string,
  laneId: string,
  startSamples: number,
  projectSampleRate: number,
  opts: LaneImportOptions = {},
): Promise<DropResult> {
  const cls = classifyUrl(text);
  if (cls.kind === 'needs-server' && cls.service === 'YouTube' && getPlatformHost().kind === 'desktop') {
    return importYoutubeToLane(text, laneId, startSamples, projectSampleRate, opts);
  }

  const got = await fetchAudioUrl(text);
  if (!got.ok || got.bytes === undefined) {
    return { ok: false, reason: got.reason ?? 'gagal mengambil URL' };
  }
  return importBytesToLane(
    got.bytes,
    got.name ?? 'AUDIO',
    laneId,
    startSamples,
    projectSampleRate,
    opts,
  );
}
