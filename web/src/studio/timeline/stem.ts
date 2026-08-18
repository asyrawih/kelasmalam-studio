/**
 * Normalisasi & pembacaan `StudioClip.stem`.
 *
 * Dipisah dari `model.ts` dengan alasan yang sama seperti `normalizeClipFade`
 * di `fade.ts`: field baru yang opsional bisa sampai ke store sebagai
 * `undefined` dari project lama, ikut TERSIMPAN LAGI apa adanya, dan nilai
 * rusaknya bertahan selamanya kalau tidak dibereskan sekali di pintu masuk.
 */

import {
  STEM_BYPASS,
  clampStemMix,
  isStemBypass,
  type StemId,
  type StemMix,
  type StudioClip,
} from '../model';

/** Stem yang berlaku untuk sebuah clip — selalu objek utuh, tidak pernah undefined. */
export function stemOf(clip: StudioClip | undefined): StemMix {
  const s = clip?.stem;
  return s === undefined ? STEM_BYPASS : clampStemMix(s);
}

/**
 * Lengkapi/bersihkan `stem` dari project lama.
 *
 * Clip yang memang tidak punya `stem` DIBIARKAN tanpa field itu (bukan diisi
 * `STEM_BYPASS`): `isStemBypass(undefined)` sudah true, dan menuliskannya
 * membengkakkan setiap clip di setiap project yang tidak pernah memakai fitur
 * ini.
 */
export function normalizeClipStem(clip: StudioClip): StudioClip {
  if (clip.stem === undefined) return clip;
  const stem = clampStemMix(clip.stem);
  // Nilai yang sama dengan bypass tidak perlu disimpan — sekaligus membuat
  // `mixFingerprint` tidak melihat perubahan palsu setelah user mematikan
  // semua tombol REMOVE.
  if (isStemBypass(stem)) {
    const { stem: _dropped, ...rest } = clip;
    return rest;
  }
  const same =
    stem.vocal === clip.stem.vocal &&
    stem.bass === clip.stem.bass &&
    stem.other === clip.stem.other &&
    stem.bassSplitHz === clip.stem.bassSplitHz &&
    stem.voiceTopHz === clip.stem.voiceTopHz;
  return same ? clip : { ...clip, stem };
}

/** Label yang dipakai UI. Di satu tempat supaya tombol dan pesan tidak berbeda. */
export const STEM_LABELS: Record<StemId, string> = {
  vocal: 'VOCAL',
  bass: 'BASS',
  other: 'INSTRUMENT',
};

/** Ringkasan singkat untuk dipajang di badge clip / catatan panel. */
export function stemSummary(stem: StemMix): string | null {
  const removed = (Object.keys(STEM_LABELS) as StemId[]).filter((k) => stem[k] < 1);
  if (removed.length === 0) return null;
  return removed
    .map((k) => (stem[k] === 0 ? `−${STEM_LABELS[k]}` : `−${STEM_LABELS[k]} ${Math.round((1 - stem[k]) * 100)}%`))
    .join(' ');
}
