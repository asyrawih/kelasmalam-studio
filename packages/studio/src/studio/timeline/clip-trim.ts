/**
 * TRIM & SLIP — mengubah JENDELA sebuah clip ke dalam materinya, bukan materinya.
 *
 * Tiga gerakan, semuanya non-destruktif dan bisa dibalik hanya dengan menarik
 * lagi ke arah sebaliknya:
 *
 *   trim kanan  tepi kanan bergerak, tepi KIRI diam    → berapa banyak yang terdengar
 *   trim kiri   tepi kiri bergerak, tepi KANAN diam    → mulai dari bagian mana
 *   slip        kedua tepi DIAM, isinya yang bergeser  → bagian mana yang muncul di jendela itu
 *
 * Ditulis sebagai fungsi murni karena semuanya melintasi dua ruang koordinat
 * sekaligus (timeline ↔ source, lewat `speedRatio`) dan salahnya tidak terlihat
 * dari layar — hanya terdengar sebagai clip yang mulai dari titik yang sedikit
 * berbeda dari yang digambar.
 *
 * ATURAN YANG MENJAGA TEPI TIDAK MELAYANG: sisi yang seharusnya diam dihitung
 * sebagai ANGKA TETAP, bukan diturunkan ulang dari sisi yang bergerak. Kalau
 * keduanya dihitung dari selisih, pembulatan sample menumpuk di setiap
 * `pointermove` dan setelah beberapa detik menyeret, tepi yang tidak disentuh
 * sudah berpindah beberapa milidetik.
 */

import { timelineLenFor, type Samples, type StudioClip } from '../model';
import { activeLoopLen } from './clip-loop';

/**
 * Materi yang HARUS ada di dalam asset untuk clip ini.
 *
 * Untuk clip biasa itu seluruh jendelanya. Untuk clip yang LOOP cukup satu
 * putaran: sisanya dipasok oleh pengulangan, bukan oleh materi baru — jadi clip
 * yang loop memang boleh dipanjangkan melewati ujung file, dan justru itulah
 * gunanya. Batas asset tetap ditegakkan atas putaran itu sendiri; melewatinya
 * membuat `AudioBufferSourceNode.start()` melempar dan clip-nya bisu.
 */
function requiredSourceLen(clip: StudioClip, sourceLen: Samples): Samples {
  const loop = activeLoopLen({ ...clip, sourceLen });
  return loop ?? sourceLen;
}

/** Panjang minimum sebuah clip, dalam sample SOURCE. */
export const MIN_SOURCE_LEN: Samples = 1;

/**
 * Tarik tepi KANAN ke posisi timeline `at`. Tepi kiri (`start`) tidak bergerak.
 *
 * `assetFrames` membatasi seberapa jauh clip bisa dipanjangkan: melewati ujung
 * materi, `AudioBufferSourceNode.start()` melempar dan `graph-builder`
 * MELEWATI clip itu — clip terlihat ada di layar tapi bisu. `undefined` berarti
 * batasnya tidak diketahui (clip demo tanpa asset), dan tidak dipaksakan.
 */
export function trimRight(
  clip: StudioClip,
  speedRatio: number,
  at: Samples,
  assetFrames?: Samples,
): StudioClip {
  const wantedLen = Math.round(at) - clip.start;
  const wantedSource = Math.max(MIN_SOURCE_LEN, Math.round(wantedLen * speedRatio));
  // Clip yang loop tidak dibatasi ujung materi: yang harus muat di dalam asset
  // cuma satu putaran, dan itu sudah muat sejak loop-nya dipasang.
  const roomNeeded = requiredSourceLen(clip, wantedSource);
  const maxSource =
    assetFrames === undefined || roomNeeded < wantedSource
      ? Number.MAX_SAFE_INTEGER
      : Math.max(0, assetFrames - clip.sourceStart);
  const sourceLen = Math.max(MIN_SOURCE_LEN, Math.min(maxSource, wantedSource));
  if (sourceLen === clip.sourceLen) return clip;
  return { ...clip, sourceLen, len: timelineLenFor(sourceLen, speedRatio) };
}

/**
 * Tarik tepi KIRI ke posisi timeline `at`. Tepi kanan tidak bergerak.
 *
 * Tepi kanan dipatok sebagai `sourceStart + sourceLen` di ruang SOURCE lalu
 * `start` diturunkan darinya — bukan sebaliknya. Itu yang membuat ujung kanan
 * tetap di tempat yang sama persis sepanjang tarikan.
 */
export function trimLeft(clip: StudioClip, speedRatio: number, at: Samples): StudioClip {
  const rightSource = clip.sourceStart + clip.sourceLen;
  const deltaSource = Math.round((Math.round(at) - clip.start) * speedRatio);
  const sourceStart = Math.max(
    0,
    Math.min(rightSource - MIN_SOURCE_LEN, clip.sourceStart + deltaSource),
  );
  const sourceLen = rightSource - sourceStart;
  const len = timelineLenFor(sourceLen, speedRatio);
  // Tepi kanan yang dipertahankan, jadi `start` mundur dari sana. Kalau hasilnya
  // negatif, clip-nya yang dipendekkan — timeline tidak punya waktu negatif.
  const rightTimeline = clip.start + clip.len;
  const start = Math.max(0, rightTimeline - len);
  if (sourceStart === clip.sourceStart && start === clip.start) return clip;
  return { ...clip, start, len, sourceStart, sourceLen };
}

/**
 * Geser materi di dalam jendela yang ukurannya TETAP.
 *
 * `originSourceStart` = nilai saat tarikan dimulai, bukan nilai sekarang.
 * Menggeser relatif terhadap nilai sekarang menumpuk galat pembulatan di setiap
 * `pointermove`, dan setelah beberapa detik menyeret, jarak yang ditempuh tidak
 * lagi sama dengan jarak yang ditempuh jari.
 */
export function slipClip(
  clip: StudioClip,
  originSourceStart: Samples,
  deltaSource: number,
  assetFrames?: Samples,
): StudioClip {
  // Yang harus tetap di dalam asset adalah materi yang benar-benar dibaca: satu
  // putaran untuk clip yang loop, seluruh jendela untuk clip biasa.
  const maxStart =
    assetFrames === undefined
      ? Number.MAX_SAFE_INTEGER
      : Math.max(0, assetFrames - requiredSourceLen(clip, clip.sourceLen));
  const sourceStart = Math.max(
    0,
    Math.min(maxStart, Math.round(originSourceStart + deltaSource)),
  );
  if (sourceStart === clip.sourceStart) return clip;
  return { ...clip, sourceStart };
}
