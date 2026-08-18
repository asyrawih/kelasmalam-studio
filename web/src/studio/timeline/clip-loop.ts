/**
 * LOOP CLIP — region yang MENGISI clip, bukan yang memotongnya.
 *
 * Bedanya dengan `beat-cut.ts` cuma satu kalimat, tapi kalimat itu yang penting:
 *
 *   LOOP CUT   clip diganti oleh deretan clip baru sepanjang region.
 *   LOOP CLIP  clip TETAP satu clip di tempat & panjang yang sama; yang berubah
 *              adalah cara materinya dibaca — melingkar di `[sourceStart,
 *              sourceStart + loopLen)` sampai clip habis.
 *
 * Keduanya sengaja tetap ada. LOOP CUT membuat tiap pengulangan jadi objek
 * sendiri yang bisa digeser/dihapus/di-gain satu-satu; LOOP CLIP tidak menambah
 * apa pun ke timeline dan bisa dibatalkan dengan satu klik, jadi ia yang benar
 * saat yang diinginkan cuma "putar 2 bar ini terus sepanjang clip".
 *
 * FUNGSI MURNI, dengan alasan yang sama dengan `beat-cut.ts`: aritmetikanya
 * melintasi source <-> timeline dan salahnya tidak kelihatan di layar — hanya
 * terdengar sebagai sambungan loop yang meleset beberapa milidetik.
 */

import { timelineLenFor, type Samples, type StudioClip } from '../model';
import { clampFadeMs } from './fade';

/** Loop lebih pendek dari ini tidak lagi berbunyi sebagai materi, hanya klik. */
export const MIN_LOOP_LEN: Samples = 8;

/**
 * Panjang loop yang BENAR-BENAR berlaku untuk clip ini, atau null.
 *
 * null kalau tidak diset, tidak sah, atau tidak lebih pendek dari materi clip —
 * loop yang sama panjang (atau lebih panjang) dari clip tidak pernah sampai
 * berputar, jadi menandainya sebagai "sedang loop" hanya akan membuat UI
 * menyalakan lampu untuk sesuatu yang tidak terjadi.
 *
 * DITURUNKAN, bukan disimpan: `sourceLen` berubah setiap kali clip di-trim atau
 * lane-nya diberi speed, dan menyimpan "sedang loop atau tidak" sebagai bool
 * kedua berarti ada dua jawaban yang bisa berselisih.
 */
export function activeLoopLen(clip: StudioClip): Samples | null {
  const len = clip.loopLen;
  if (len === undefined || !Number.isFinite(len)) return null;
  const rounded = Math.round(len);
  if (rounded < MIN_LOOP_LEN) return null;
  if (rounded >= clip.sourceLen) return null;
  return rounded;
}

/** Buang `loopLen` yang rusak dari project lama / file yang diedit tangan. */
export function normalizeClipLoop(clip: StudioClip): StudioClip {
  const len = clip.loopLen;
  if (len === undefined) return clip;
  if (!Number.isFinite(len) || len < MIN_LOOP_LEN) {
    const { loopLen: _drop, ...rest } = clip;
    return rest;
  }
  const rounded = Math.round(len);
  return rounded === len ? clip : { ...clip, loopLen: rounded };
}

/**
 * Pasang region loop ke sebuah clip.
 *
 * POSISI DAN PANJANG CLIP DI TIMELINE TIDAK DISENTUH. Itu inti perintahnya:
 * user sudah menaruh clip ini di tempat yang benar, dan "putar 2 bar ini terus"
 * bukan alasan untuk memindahkannya atau memanjangkannya.
 *
 * Yang berubah hanya dua: titik masuk ke materi (`sourceStart` pindah ke awal
 * region) dan `loopLen`. `sourceLen` sengaja TIDAK ikut — ia pasangan `len`,
 * dan mengubahnya akan memendekkan clip di timeline.
 *
 * Fade ikut di-clamp ulang supaya clip yang datang dengan fade kelewat panjang
 * (dari state lama, atau dari clip yang baru saja dipendekkan) ikut dirapikan
 * di satu tempat yang sama dengan jalur LOOP CUT.
 */
export function applyClipLoop(
  clip: StudioClip,
  region: { readonly sourceStart: Samples; readonly sourceLen: Samples },
  sampleRate: number,
): StudioClip {
  const sourceStart = Math.max(0, Math.round(region.sourceStart));
  const loopLen = Math.max(MIN_LOOP_LEN, Math.round(region.sourceLen));
  const next: StudioClip = { ...clip, sourceStart, loopLen };
  return {
    ...next,
    fadeInMs: clampFadeMs(next, 'in', next.fadeInMs, sampleRate),
    fadeOutMs: clampFadeMs(next, 'out', next.fadeOutMs, sampleRate),
  };
}

/** Lepaskan loop; clip kembali diputar lurus dari `sourceStart`. */
export function clearClipLoop(clip: StudioClip): StudioClip {
  if (clip.loopLen === undefined) return clip;
  const { loopLen: _drop, ...rest } = clip;
  return rest;
}

/**
 * Offset SOURCE tempat pemutaran harus dimulai kalau playhead jatuh
 * `intoClipSource` sample (SOURCE-space) di dalam clip.
 *
 * Ini modulo, dan modulo-lah seluruh isi fungsi ini: mulai dari tengah clip
 * yang sedang loop berarti mulai dari tengah PUTARAN yang sedang berjalan, dan
 * bukan dari awal region. Tanpa ini, menekan play di detik 30 akan terdengar
 * berbeda dari mendengarkannya sampai detik 30 — cacat yang cuma muncul saat
 * user melompat, jadi paling mudah lolos dari pengujian tangan.
 */
export function loopSourceOffset(
  clip: StudioClip,
  loopLen: Samples,
  intoClipSource: number,
): Samples {
  if (!(loopLen > 0)) return clip.sourceStart;
  const into = Math.max(0, intoClipSource);
  return clip.sourceStart + (into % loopLen);
}

/** Berapa kali region muncul di clip ini, pengulangan terakhir yang terpotong
 *  ikut dihitung. Untuk pembacaan angka di UI dan untuk menggambar ubinnya. */
export function loopTileCount(sourceLen: Samples, loopLen: Samples): number {
  if (!(loopLen > 0) || !(sourceLen > 0)) return 1;
  return Math.max(1, Math.ceil(sourceLen / loopLen));
}

/**
 * Jabarkan clip yang loop jadi deretan clip lurus yang berbunyi SAMA PERSIS.
 *
 * Ada karena jalur EXPORT tidak lewat Web Audio: ia mengirim snapshot ke engine
 * Rust, yang belum mengenal `loopLen`. Menjabarkannya di batas itu jauh lebih
 * aman daripada menambah field ke protokol snapshot — kalau engine dan preview
 * punya dua tafsir tentang loop, bedanya hanya akan terdengar di file hasil
 * export, tempat paling mahal untuk menemukan bug.
 *
 * SATU SELISIH YANG DIAKUI: fade-out dipasang di potongan TERAKHIR dan
 * `clampFadeMs` memendekkannya kalau potongan itu lebih pendek dari fade-nya.
 * Di preview, fade dijadwalkan di atas seluruh clip dan tidak peduli pada batas
 * putaran. Selisih ini hanya muncul kalau fade-out lebih panjang dari satu
 * putaran loop — tidak disembunyikan, tapi juga tidak dianggap cukup untuk
 * membenarkan jalur DSP kedua.
 */
export function expandLoopClip(
  clip: StudioClip,
  speedRatio: number,
  sampleRate: number,
  makeId: (index: number) => string,
): StudioClip[] {
  const loopLen = activeLoopLen(clip);
  if (loopLen === null) return [clip];

  const tiles = loopTileCount(clip.sourceLen, loopLen);
  const tileTimelineLen = timelineLenFor(loopLen, speedRatio);
  const out: StudioClip[] = [];

  for (let i = 0; i < tiles; i++) {
    const start = clip.start + i * tileTimelineLen;
    // Potongan terakhir dipotong tepat di ujung clip, bukan dibiarkan
    // melewatinya: clip yang loop berhenti di batasnya, dan ekor yang menonjol
    // keluar akan terdengar sebagai materi yang tidak pernah ada di preview.
    const len = Math.min(tileTimelineLen, clip.start + clip.len - start);
    if (len <= 0) break;
    const piece: StudioClip = {
      ...clip,
      id: i === 0 ? clip.id : makeId(i),
      start,
      len,
      sourceLen: Math.min(loopLen, Math.max(1, Math.round(len * speedRatio))),
      loopLen: undefined,
      // Fade milik CLIP, bukan milik putaran: hanya potongan pertama yang
      // membawa fade-in dan hanya yang terakhir yang membawa fade-out. Kalau
      // tiap potongan ikut membawa keduanya, tiap sambungan loop akan melubang.
      fadeInMs: i === 0 ? clip.fadeInMs : 0,
      fadeOutMs: 0,
      seed: clip.seed + i,
    };
    out.push(piece);
  }

  const last = out[out.length - 1];
  if (last !== undefined && clip.fadeOutMs > 0) {
    out[out.length - 1] = {
      ...last,
      fadeOutMs: clampFadeMs(last, 'out', clip.fadeOutMs, sampleRate),
    };
  }
  return out;
}
