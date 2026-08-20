/**
 * Jembatan tipis: URL → byte → jalur import yang sama dengan drop file.
 *
 * Sengaja terpisah dari `url-import.ts` (yang murni jaringan, tanpa store) dan
 * dari `audio-import.ts` (yang murni decode) supaya keduanya tetap bisa dites
 * tanpa saling menyeret.
 */

import { importBytesToLane, type DropResult, type LaneImportOptions } from './audio-import';
import { fetchAudioUrl } from './url-import';

export async function importUrlToLane(
  text: string,
  laneId: string,
  startSamples: number,
  projectSampleRate: number,
  opts: LaneImportOptions = {},
): Promise<DropResult> {
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
