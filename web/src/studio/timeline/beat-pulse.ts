/**
 * DENYUT KETUKAN di strip warna lane.
 *
 * Bagian yang bisa dihitung — "seberapa terang lane ini SEKARANG" — dipisah ke
 * fungsi murni supaya bisa dites tanpa rAF, tanpa canvas, dan tanpa jam.
 *
 * Sumber waktunya sengaja sama dengan waveform geser: `previewPositionSec()`
 * untuk mix utama dan `auditionPositionSourceSec()` untuk loop audisi, keduanya
 * dari `ctx.currentTime`. Playhead di store hanya maju 16×/detik; dipakai untuk
 * kilatan, denyutnya akan tersendat DAN meleset dari yang terdengar — dan
 * meleset di sini langsung terlihat, karena mata membandingkannya dengan
 * telinga.
 */

import { beatIndexAt, resolveBeatGrid } from '../analysis/beat-grid';
import { isAudible, type StudioLane } from '../model';
import type { StudioAsset } from '../store';

/**
 * Porsi satu ketukan yang dipakai kilatan, lalu padam.
 *
 * Sepertiga ketukan: cukup lama untuk terbaca sebagai kedipan pada 174 BPM
 * (≈115 ms), cukup pendek supaya pada 90 BPM lane tidak terlihat menyala terus.
 */
export const FLASH_FRACTION = 1 / 3;

/** Terang kilatan di ketukan biasa, relatif terhadap downbeat. */
export const OFFBEAT_LEVEL = 0.5;

/**
 * Terang strip lane, 0..1.
 *
 * `0` berarti tidak ada yang perlu digambar — lane bisu, tidak ada clip di
 * posisi itu, atau materinya tidak punya BPM.
 */
export function lanePulse(
  lane: StudioLane,
  lanes: StudioLane[],
  assets: Readonly<Record<number, StudioAsset>>,
  sampleRate: number,
  timelineSec: number,
  audition: { readonly clipId: string; readonly sourceSec: number } | null,
): number {
  // Lane yang di-mute atau dibungkam SOLO tidak berbunyi; strip yang tetap
  // berdenyut di sana akan terbaca sebagai "ini masih terdengar".
  if (!isAudible(lane, lanes)) return 0;

  const auditioned =
    audition === null ? undefined : lane.clips.find((c) => c.id === audition.clipId);

  let clip = auditioned;
  let sourceSec: number;
  if (auditioned !== undefined && audition !== null) {
    // Lane yang sedang diaudisi mengikuti pemutar audisi, bukan playhead
    // timeline — playhead itu berjalan di tempat lain.
    sourceSec = audition.sourceSec;
  } else {
    const at = timelineSec * sampleRate;
    clip = lane.clips.find((c) => at >= c.start && at < c.start + c.len);
    if (clip === undefined) return 0;
    // TIMELINE → SOURCE lewat rasio lane: lane 2× lebih cepat berarti tiap
    // detik timeline memakan dua detik materi, dan ketukannya ikut rapat.
    sourceSec =
      clip.sourceStart / sampleRate + (timelineSec - clip.start / sampleRate) * lane.speedRatio;
  }
  if (clip === undefined) return 0;

  const grid = resolveBeatGrid(assets[clip.assetId]);
  if (grid === null) return 0;

  const beat = beatIndexAt(sourceSec * sampleRate, grid, sampleRate);
  // `%` JavaScript mengembalikan sisa bertanda untuk posisi sebelum ketukan
  // pertama; dinormalkan supaya kilatan tidak melompat di sekitar nol.
  const frac = ((beat % 1) + 1) % 1;
  if (frac >= FLASH_FRACTION) return 0;

  // Kuadrat, bukan linear: peluruhan linear terbaca sebagai lampu yang
  // diredupkan pelan, bukan sebagai ketukan.
  const decay = (1 - frac / FLASH_FRACTION) ** 2;
  const index = Math.floor(beat);
  const phase = ((index % grid.beatsPerBar) + grid.beatsPerBar) % grid.beatsPerBar;
  return decay * (phase === 0 ? 1 : OFFBEAT_LEVEL);
}
