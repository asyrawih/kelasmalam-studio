/**
 * TAP TEMPO — BPM dari ketukan tangan.
 *
 * Berkas terpisah dari `grid-edit.ts` karena satu-satunya hal yang sulit di
 * sini bukan rumusnya (`60 / interval`), melainkan **menolak masukan buruk**,
 * dan itu punya alasannya sendiri-sendiri yang panjang. Rumusnya sendiri muat
 * dalam satu baris.
 *
 * Murni: menerima daftar cap waktu, mengembalikan angka. Tidak ada timer, tidak
 * ada state. Yang memegang deretan tap-nya adalah store — sehingga tombol TAP
 * di layar dan (nanti) tombol TAP di MIDI menambah ke deretan yang sama.
 */

import { clampGridBpm } from './beat-grid';

/**
 * Jeda yang memutus deretan. Di atas ini, tap berikutnya memulai pengukuran
 * baru alih-alih dianggap ketukan yang sangat lambat.
 *
 * Dua detik = 30 BPM, yaitu `MIN_GRID_BPM`. Angkanya bukan pilihan gaya:
 * apa pun yang lebih lambat dari itu memang tidak bisa dinyatakan sebagai grid
 * di aplikasi ini, jadi menafsirkannya sebagai ketukan hanya menghasilkan angka
 * yang akan ditolak `clampGridBpm` beberapa baris kemudian.
 */
export const TAP_RESET_MS = 2000;

/**
 * Tap minimal sebelum ada jawaban. Empat tap = tiga interval — cukup untuk
 * median yang berarti (lihat di bawah), dan itu satu bar penuh di 4/4 sehingga
 * ritme tangannya sudah tenang.
 *
 * Tiga tap (dua interval) tampak cukup dan tidak: median dari dua angka adalah
 * rata-ratanya, jadi seluruh ketahanan yang jadi alasan memakai median hilang
 * tepat di jumlah tap yang paling sering dipakai orang yang tidak sabar.
 */
export const MIN_TAPS = 4;

export interface TapResult {
  readonly bpm: number;
  /** Jumlah interval yang benar-benar dipakai (setelah pemangkasan). */
  readonly intervals: number;
}

/**
 * Buang tap yang terpisah lebih dari `TAP_RESET_MS` dari tap sesudahnya —
 * hanya deretan TERAKHIR yang tersisa.
 *
 * Dipisah dari `tapTempo` supaya store bisa memakainya untuk memangkas
 * deretannya sendiri: tanpa itu, array-nya tumbuh selama sesi dan sisa ketukan
 * dari lima menit lalu ikut digambar sebagai "tap ke-27".
 */
export function trimTapRun(timesMs: readonly number[]): readonly number[] {
  let start = 0;
  for (let i = 1; i < timesMs.length; i++) {
    const prev = timesMs[i - 1] ?? 0;
    const cur = timesMs[i] ?? 0;
    if (cur - prev > TAP_RESET_MS) start = i;
  }
  return start === 0 ? timesMs : timesMs.slice(start);
}

/**
 * BPM dari deretan cap waktu (ms), atau `null` kalau belum cukup.
 *
 * **MEDIAN, bukan rata-rata.** Satu tap yang meleset — telepon berdering, jari
 * tersangkut — menggeser rata-rata seluruh deretan, dan gejalanya adalah angka
 * yang "hampir benar" dan karena itu tidak dicurigai. Median mengabaikannya
 * sepenuhnya selama tap yang meleset masih minoritas, yang selalu benar untuk
 * orang yang sedang menepuk mengikuti lagu.
 *
 * **`hintBpm` mengunci OKTAF.** Orang menepuk setengah tempo tanpa sadar
 * sepanjang waktu, terutama pada lagu 170 BPM yang terasa seperti 85. Kalau
 * BPM acuan diberikan, hasilnya digandakan/dibagi dua sampai jatuh di dalam
 * rentang `[hint/√2, hint·√2)` — batas geometris, karena itulah titik di mana
 * "lebih dekat ke hint" berpindah pemilik antara `x` dan `2x`.
 *
 * Kalau `hintBpm` null (lagu yang benar-benar belum dikenal), tidak ada yang
 * bisa dijadikan acuan dan hasilnya diserahkan apa adanya — menebak di sana
 * hanya akan salah dengan percaya diri.
 */
export function tapTempo(timesMs: readonly number[], hintBpm: number | null = null): TapResult | null {
  const run = trimTapRun(timesMs);
  if (run.length < MIN_TAPS) return null;

  const gaps: number[] = [];
  for (let i = 1; i < run.length; i++) {
    const d = (run[i] ?? 0) - (run[i - 1] ?? 0);
    if (d > 0) gaps.push(d);
  }
  if (gaps.length < MIN_TAPS - 1) return null;

  const sorted = [...gaps].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median =
    sorted.length % 2 === 1
      ? (sorted[mid] ?? 0)
      : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  if (!(median > 0)) return null;

  return { bpm: clampGridBpm(octaveLock(60_000 / median, hintBpm)), intervals: gaps.length };
}

/** Gandakan/bagi dua `bpm` sampai jatuh sedekat mungkin ke `hint`. */
function octaveLock(bpm: number, hint: number | null): number {
  if (hint === null || !(hint > 0) || !(bpm > 0)) return bpm;
  // Pembulatan pada skala log2: langsung ke oktaf yang benar, tanpa loop yang
  // bisa tidak berhenti pada masukan yang aneh.
  const octaves = Math.round(Math.log2(hint / bpm));
  return bpm * 2 ** octaves;
}
