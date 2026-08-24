/**
 * BEAT GRID — matematika murni "di mana ketukannya", tanpa React dan tanpa
 * Web Audio, supaya bisa dites langsung.
 *
 * Bahannya sudah lama ada tapi belum pernah dipakai: `crates/analysis` mengukur
 * BPM DAN fase ketukan (`beat_offset_sec`), dan keduanya sudah sampai ke
 * `StudioAsset.tempo` — lalu berhenti di sana. docs/10 menyebutnya sendiri
 * "bahan untuk snap-to-beat". Modul ini yang memakainya.
 *
 * DUA HAL YANG PERLU DIPAHAMI SEBELUM MENGUBAH FILE INI:
 *
 * 1. GRID MILIK ASSET, BUKAN CLIP. Ketukan adalah sifat materi rekamannya;
 *    dua clip dari lagu yang sama punya grid yang sama. Karena itu semua posisi
 *    di sini SOURCE-space (sample di dalam asset), bukan timeline-space.
 *    Konversi ke timeline hanya terjadi di titik pemotongan, dengan
 *    `lane.speedRatio` — aturan dua-koordinat docs/07 §8d.
 *
 * 2. NOMOR BAR-NYA ARBITER. Yang dideteksi Rust adalah fase KETUKAN, bukan
 *    fase birama — tidak ada yang tahu ketukan mana yang "satu". Jadi bar 1
 *    didefinisikan sebagai bar yang dimulai di ketukan pertama, dan itulah
 *    kenapa offset bisa digeser user sampai sejauh SATU BAR penuh (bukan satu
 *    ketukan): menggeser downbeat ke tempat yang benar memang butuh sebanyak
 *    itu.
 */

import type { Samples } from '../model';
import type { StudioAsset } from '../store';
import { correctedBpm } from './playhead-tempo';

/** Birama tetap 4/4 untuk sekarang. Dijadikan field di `BeatGrid` supaya
 *  penambahan 3/4 nanti tidak perlu menyisir ulang seluruh pemakainya. */
export const BEATS_PER_BAR = 4;

/** Rentang BPM yang boleh diketik manual. Lebih lebar dari `BPM_MIN/MAX`
 *  detektor (60–200): user boleh tahu lebih banyak daripada mesin. */
export const MIN_GRID_BPM = 30;
export const MAX_GRID_BPM = 300;

/**
 * Batas jumlah garis yang dikembalikan `beatLinesIn`. Clip 10 menit pada 174
 * BPM punya ±1700 ketukan — masih wajar; yang dijaga di sini adalah grid rusak
 * (BPM sangat tinggi × durasi panjang) yang bisa membekukan tab lewat satu
 * loop. Penggambar TETAP harus menipiskan sendiri kalau garisnya lebih rapat
 * dari beberapa piksel.
 */
export const MAX_BEAT_LINES = 8192;

export interface BeatGrid {
  readonly bpm: number;
  /**
   * Posisi ketukan pertama (detik, SOURCE-space), sudah dinormalkan ke
   * `[0, satu bar)`. Grid itu periodik, jadi nilai di luar rentang itu tidak
   * menghasilkan grid yang berbeda — hanya nomor bar yang bergeser.
   */
  readonly offsetSec: number;
  readonly beatsPerBar: number;
  /** true kalau BPM atau offset-nya berasal dari user, bukan dari deteksi. */
  readonly manual: boolean;
}

export interface BeatLine {
  /** Posisi di SOURCE-space. */
  readonly at: Samples;
  /** Indeks ketukan dari ketukan pertama (0 = ketukan pertama). */
  readonly beat: number;
  /** Indeks bar, 0-based. Lihat catatan "nomor bar-nya arbiter" di atas. */
  readonly bar: number;
  /** true di ketukan pertama tiap bar. */
  readonly downbeat: boolean;
}

export function clampGridBpm(bpm: number): number {
  if (!Number.isFinite(bpm)) return MIN_GRID_BPM;
  return Math.min(MAX_GRID_BPM, Math.max(MIN_GRID_BPM, bpm));
}

/** Detik per ketukan. Satu-satunya tempat 60/bpm ditulis. */
export function secPerBeat(grid: BeatGrid): number {
  return 60 / grid.bpm;
}

export function samplesPerBeat(grid: BeatGrid, sr: number): number {
  return (60 / grid.bpm) * sr;
}

export function samplesPerBar(grid: BeatGrid, sr: number): number {
  return samplesPerBeat(grid, sr) * grid.beatsPerBar;
}

/**
 * Grid yang berlaku untuk sebuah asset, atau null kalau memang belum ada
 * jawabannya.
 *
 * Override user MENANG atas deteksi, tapi tidak MENGHAPUSNYA — `bpmOverride`
 * saja yang diisi tetap memakai `beatOffsetSec` hasil deteksi, dan tombol AUTO
 * bisa mengembalikan keduanya. Itu sebabnya keduanya field terpisah dan bukan
 * satu objek `BeatGrid` yang menimpa.
 *
 * Koreksi oktaf (×2 / ÷2) dibaca lewat `correctedBpm` yang sudah ada — rumusnya
 * tidak boleh ditulis dua kali.
 */
export function resolveBeatGrid(asset: StudioAsset | undefined): BeatGrid | null {
  if (asset === undefined) return null;
  const detected = correctedBpm(asset);
  const raw = asset.bpmOverride ?? detected;
  if (raw === null || !Number.isFinite(raw) || raw <= 0) return null;

  const bpm = clampGridBpm(raw);
  const beatsPerBar = BEATS_PER_BAR;
  const rawOffset = asset.beatOffsetOverride ?? asset.tempo?.beatOffsetSec ?? 0;
  // Dinormalkan ke satu BAR, bukan satu ketukan: menggeser downbeat ke tempat
  // yang benar butuh rentang sebesar bar. Modulo dua langkah supaya nilai
  // negatif (nudge ke kiri melewati nol) tetap jatuh di rentang positif.
  const barSec = (60 / bpm) * beatsPerBar;
  const offsetSec = Number.isFinite(rawOffset) ? ((rawOffset % barSec) + barSec) % barSec : 0;

  return {
    bpm,
    offsetSec,
    beatsPerBar,
    manual: asset.bpmOverride !== null || asset.beatOffsetOverride !== null,
  };
}

/**
 * Satu titik tempat tempo BERGANTI, dan tempo yang berlaku sejak titik itu.
 *
 * Ini `[Dynamic]` rekordbox dalam bentuk paling kecil yang masih jujur: lagu
 * yang direkam manusia melambat dan mempercepat, dan satu BPM untuk seluruh
 * lagu memaksa user memilih bagian mana yang boleh benar. Anchor menjawabnya
 * dengan membelah lagu jadi ruas-ruas, masing-masing dengan tempo sendiri.
 *
 * `atSec` adalah anchor DAN batas kiri ruasnya sekaligus — grid ruas itu lewat
 * persis di sana. Keduanya sengaja satu angka: dua angka terpisah berarti ada
 * keadaan tempat garis grid tidak mendarat di titik yang barusan ditunjuk user,
 * dan tidak ada cara melihat kenapa dari layar.
 */
export interface BeatAnchor {
  readonly atSec: number;
  readonly bpm: number;
}

/** Satu ruas tempo: grid yang berlaku mulai `fromSec` sampai ruas berikutnya. */
export interface GridSegment {
  readonly fromSec: number;
  readonly grid: BeatGrid;
}

/**
 * Batas jumlah anchor per lagu. rekordbox sendiri tidak mengumumkan angkanya;
 * yang dijaga di sini adalah loop penggambar, bukan selera.
 */
export const MAX_BEAT_ANCHORS = 256;

/** Ruas grid sebuah asset, urut menaik. Ruas PERTAMA selalu grid dasarnya. */
export function gridSegments(asset: StudioAsset | undefined): readonly GridSegment[] {
  const base = resolveBeatGrid(asset);
  if (base === null) return [];
  // Ruas dasar mulai dari −∞, bukan dari 0: materi sebelum anchor pertama tetap
  // harus punya grid, dan `beatIndexAt` memang boleh negatif.
  const out: GridSegment[] = [{ fromSec: -Infinity, grid: base }];

  const anchors = asset?.beatAnchors ?? null;
  if (anchors === null) return out;

  const sane = anchors
    .filter((a) => Number.isFinite(a.atSec) && Number.isFinite(a.bpm) && a.bpm > 0)
    .slice(0, MAX_BEAT_ANCHORS)
    .slice()
    .sort((a, b) => a.atSec - b.atSec);

  for (const a of sane) {
    const bpm = clampGridBpm(a.bpm);
    const barSec = (60 / bpm) * BEATS_PER_BAR;
    // `atSec` dinormalkan dengan cara yang SAMA dengan `resolveBeatGrid`, jadi
    // grid ruas ini lewat persis di `atSec` — lihat catatan di `BeatAnchor`.
    const offsetSec = ((a.atSec % barSec) + barSec) % barSec;
    out.push({ fromSec: a.atSec, grid: { bpm, offsetSec, beatsPerBar: BEATS_PER_BAR, manual: true } });
  }
  return out;
}

/**
 * Grid yang berlaku DI SATU POSISI. Untuk lagu tanpa anchor tambahan ia
 * mengembalikan hal yang sama persis dengan `resolveBeatGrid`.
 *
 * Inilah yang dipakai deck: satu titik masuk, supaya quantize, loop, SYNC, dan
 * metronom tidak pernah bisa memakai ruas yang berbeda dari yang digambar.
 */
export function resolveBeatGridAt(asset: StudioAsset | undefined, atSec: number): BeatGrid | null {
  const segs = gridSegments(asset);
  if (segs.length === 0) return null;
  let found = segs[0]!;
  for (const s of segs) {
    if (s.fromSec <= atSec) found = s;
    else break;
  }
  return found.grid;
}

/** Indeks ketukan (pecahan) di posisi source tertentu. Bisa negatif. */
export function beatIndexAt(at: Samples, grid: BeatGrid, sr: number): number {
  return (at - grid.offsetSec * sr) / samplesPerBeat(grid, sr);
}

/** Posisi source dari sebuah indeks ketukan. Kebalikan `beatIndexAt`. */
export function sourceAtBeat(beat: number, grid: BeatGrid, sr: number): Samples {
  return Math.round(grid.offsetSec * sr + beat * samplesPerBeat(grid, sr));
}

/**
 * Marker hasil tracker hanya sah selama grid deteksi belum diubah manual.
 * Mengganti BPM/offset atau menambah anchor membuat marker lama menunjuk model
 * tempo yang berbeda, jadi pada keadaan itu caller harus memakai grid periodik.
 */
export function trackedBeatSamples(asset: StudioAsset | undefined, sr: number): readonly Samples[] {
  if (
    asset === undefined ||
    asset.bpmOverride !== null ||
    asset.beatOffsetOverride !== null ||
    asset.tempoOctave !== 0 ||
    (asset.beatAnchors ?? null) !== null
  ) return [];
  return (asset.tempo?.beatTimesSec ?? [])
    .filter((sec) => Number.isFinite(sec) && sec >= 0)
    .map((sec) => Math.round(sec * sr));
}

/** Marker beat aktual terdekat, atau null bila asset hanya punya grid periodik. */
export function nearestTrackedBeat(asset: StudioAsset | undefined, at: Samples, sr: number): Samples | null {
  const beats = trackedBeatSamples(asset, sr);
  if (beats.length === 0) return null;
  let lo = 0;
  let hi = beats.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (beats[mid]! < at) lo = mid + 1;
    else hi = mid;
  }
  const right = beats[Math.min(lo, beats.length - 1)]!;
  const left = beats[Math.max(0, lo - 1)]!;
  return Math.abs(at - left) <= Math.abs(right - at) ? left : right;
}

/**
 * Semua garis grid di dalam region `[from, from + len)`.
 *
 * Setengah-terbuka di ujung kanan, alasannya sama dengan `computePlayheadTempo`:
 * garis persis di batas milik region berikutnya, kalau tidak ia tergambar dua
 * kali di sambungan dua clip.
 */
export function beatLinesIn(
  grid: BeatGrid,
  sr: number,
  from: Samples,
  len: Samples,
): readonly BeatLine[] {
  const out: BeatLine[] = [];
  if (len <= 0) return out;
  const spb = samplesPerBeat(grid, sr);
  if (!Number.isFinite(spb) || spb <= 0) return out;

  const end = from + len;
  let beat = Math.ceil(beatIndexAt(from, grid, sr));
  // Pembulatan pecahan bisa membuat ketukan yang duduk PERSIS di `from`
  // terlewat; mundur satu lalu buang yang benar-benar di luar jauh lebih murah
  // daripada mengarang epsilon.
  if (sourceAtBeat(beat - 1, grid, sr) >= from) beat -= 1;

  for (; out.length < MAX_BEAT_LINES; beat++) {
    const at = sourceAtBeat(beat, grid, sr);
    if (at >= end) break;
    if (at < from) continue;
    // `%` JavaScript mengembalikan sisa bertanda untuk beat negatif — dinormalkan
    // supaya downbeat tetap jatuh di tempat yang sama di kiri titik nol.
    const phase = ((beat % grid.beatsPerBar) + grid.beatsPerBar) % grid.beatsPerBar;
    out.push({
      at,
      beat,
      bar: Math.floor(beat / grid.beatsPerBar),
      downbeat: phase === 0,
    });
  }
  return out;
}

export type BeatDivision = 'beat' | 'bar';

/**
 * Titik grid terdekat dari sebuah posisi source, dengan langkah SEBEBAS APA PUN
 * dalam satuan ketukan.
 *
 * Pecahan diperlukan sejak loop bisa lebih pendek dari satu bar: loop 1/4 bar
 * yang hanya boleh mendarat di awal bar tidak akan pernah bisa ditaruh di
 * ketukan 2, 3, atau 4 — yang justru seluruh gunanya loop sependek itu.
 *
 * Tidak di-clamp — pemanggil yang tahu batas asset/clip-nya.
 */
export function snapSourceToGrid(
  at: Samples,
  grid: BeatGrid,
  sr: number,
  stepBeats: number,
): Samples {
  const step = Number.isFinite(stepBeats) && stepBeats > 0 ? stepBeats : 1;
  const idx = Math.round(beatIndexAt(at, grid, sr) / step) * step;
  return sourceAtBeat(idx, grid, sr);
}

/** Bentuk lama: menempel ke ketukan atau ke bar. */
export function snapSourceToBeat(
  at: Samples,
  grid: BeatGrid,
  sr: number,
  div: BeatDivision,
): Samples {
  return snapSourceToGrid(at, grid, sr, div === 'bar' ? grid.beatsPerBar : 1);
}
