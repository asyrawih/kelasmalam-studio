/**
 * BEAT SYNC — matematika murni "berapa cepat dan di mana", tanpa store dan
 * tanpa Web Audio.
 *
 * ## Beat sync punya TIGA bagian, dan sebelumnya kita hanya punya satu
 *
 *  1. **Tempo** — samakan BPM. Ini yang dulu sudah ada (`faderForBpm`).
 *  2. **Fase** — sejajarkan KETUKANNYA. Ini yang dulu tidak ada sama sekali,
 *     dan ketiadaannya adalah alasan sebenarnya orang merasa "SYNC-nya tidak
 *     kena": dua lagu 128 BPM yang mulai di detik berbeda akan berjalan sama
 *     cepat SELAMANYA sambil ketukannya meleset tetap — seperti dua jam yang
 *     sama-sama akurat tapi disetel beda 200 ms.
 *  3. **Leader/follower** — siapa acuannya, dan kapan difase ulang.
 *
 * Bentuknya mengikuti `Developer Guide SyncLock` milik Mixxx, satu-satunya
 * algoritma beat sync yang terbuka dan matang: leader/follower, faktor ×2/÷2
 * otomatis, dan fase lewat **beat distance**.
 *
 * ## SATU HAL YANG SENGAJA TIDAK DITIRU DARI MIXXX
 *
 * Mixxx mengoreksi fase TERUS-MENERUS: tiap callback ia menghitung selisih beat
 * distance dan menggeser rate follower sampai ±5%. Kita tidak, dan itu keputusan
 * sadar dengan dua alasan:
 *
 *  - Deck di sini adalah `AudioBufferSourceNode` ber-`playbackRate` KONSTAN yang
 *    dijalankan satu jam audio yang sama. Sekali sejajar, ia tetap sejajar
 *    secara matematis. Mixxx butuh loop itu karena melayani scratch, grid
 *    variabel, dan sumber drift-nya sendiri.
 *  - MASTER TEMPO belum ada (`recordbox/00-plan.md`, Utang 2). Rate yang
 *    digoyang terus-menerus berarti PITCH yang bergetar terus-menerus. Obatnya
 *    lebih buruk daripada penyakitnya.
 *
 * Satu-satunya sumber drift yang tersisa adalah grid yang BPM-nya meleset — dan
 * itu urusan `analysis/grid-edit.ts`, bukan urusan berkas ini. Yang disediakan
 * di sini sebagai gantinya adalah `phaseErrorBeats`, supaya drift itu bisa
 * DILIHAT (phase meter) alih-alih baru terdengar dua lagu kemudian.
 */

import { beatIndexAt, type BeatGrid } from '../studio/analysis/beat-grid';
import { TEMPO_RANGES, faderForBpm, tempoRatio, type DeckTempo, type Samples, type TempoRange } from './model';

/** Satu deck sebagaimana dibutuhkan perhitungan sync. */
export interface SyncDeck {
  readonly grid: BeatGrid | null;
  readonly playhead: Samples;
  readonly sampleRate: number;
  readonly tempo: DeckTempo;
}

export interface SyncPlan {
  /** BPM yang akan benar-benar terdengar di follower. */
  readonly targetBpm: number;
  /** `targetBpm / bpm grid follower`. Selalu di sekitar 1 setelah pelipatan. */
  readonly ratio: number;
  /**
   * Pangkat dua yang dipakai: `targetBpm = leaderBpm × 2^octave`.
   *
   * `0` = tempo sama; `−1` = follower berjalan SETENGAH tempo leader (deck 87
   * mengikuti master 174); `+1` = dua kali. Dipajang sebagai badge `÷2` / `×2`
   * — dua deck yang menyala SYNC sambil menampilkan 174 dan 87 tanpa penjelasan
   * terlihat seperti kerusakan.
   */
  readonly octave: number;
  readonly fader: number;
  /** Rentang yang dipakai — bisa lebih lebar dari yang sedang dipilih user. */
  readonly rangePct: TempoRange;
  readonly rangeWidened: boolean;
  /**
   * Koreksi FASE, dalam sample SOURCE follower. Ditambahkan ke playhead-nya.
   * Selalu koreksi TERKECIL yang mungkin (maksimal setengah periode).
   */
  readonly deltaSamples: Samples;
}

export type SyncOutcome =
  | { readonly ok: true; readonly plan: SyncPlan }
  | { readonly ok: false; readonly reason: string };

/**
 * BPM yang benar-benar terdengar dari sebuah deck.
 *
 * **BEND SENGAJA TIDAK IKUT.** Jog bend adalah dorongan sesaat; kalau ia ikut
 * terbaca, satu sentuhan jog di leader akan mengubah tempo follower SECARA
 * PERMANEN. Mixxx menyebut hal yang sama untuk alasan yang sama: *instantaneous
 * BPM* dipakai untuk umpan balik controller, **tidak** untuk sinkronisasi
 * follower, supaya jitter tidak menghasilkan loop umpan balik.
 *
 * Bandingkan dengan FASE di bawah, yang justru memakai posisi playhead apa
 * adanya — di sana bend memang sudah terjadi dan hasilnya nyata.
 */
export function syncBpmOf(deck: SyncDeck): number | null {
  if (deck.grid === null) return null;
  const bpm = deck.grid.bpm * tempoRatio(deck.tempo);
  return bpm > 0 && Number.isFinite(bpm) ? bpm : null;
}

/**
 * Target BPM untuk follower, DILIPAT ke oktaf terdekat.
 *
 * Ini yang membuat deck 87 BPM bisa mengikuti master 174: keduanya sudah
 * nyambung beat-nya pada rasio 2:1, dan memaksakan 87 → 174 justru akan
 * menaikkan pitch satu oktaf penuh karena MASTER TEMPO belum ada.
 *
 * Pemilihannya di ruang LOG, bukan linier: itu metrik yang benar untuk rasio.
 * 100 lawan 140 karena itu memberi 1.4× (jarak log 0.485), bukan 0.7×
 * (jarak log 0.514) — dan memang 140 yang lebih dekat secara musikal.
 */
export function foldToOctave(
  selfGridBpm: number,
  leaderBpm: number,
): { readonly targetBpm: number; readonly octave: number } {
  if (!(selfGridBpm > 0) || !(leaderBpm > 0)) {
    return { targetBpm: leaderBpm, octave: 0 };
  }
  // `|| 0` membuang `-0`, yang `Object.is` anggap berbeda dari `0` dan karena
  // itu bocor ke perbandingan di pemanggil sebagai selisih yang tidak ada.
  const octave = Math.round(Math.log2(selfGridBpm / leaderBpm)) || 0;
  return { targetBpm: leaderBpm * 2 ** octave, octave };
}

/** Rentang TERKECIL yang sanggup memuat rasio ini, atau `null` kalau tidak ada. */
export function smallestRangeFor(ratio: number, current: TempoRange): TempoRange | null {
  const needPct = Math.abs(ratio - 1) * 100;
  for (const r of TEMPO_RANGES) {
    // Rentang yang lebih sempit dari pilihan user tidak pernah dipakai:
    // menyempitkannya diam-diam mengubah arti setiap gerakan fader sesudahnya.
    if (r < current) continue;
    if (needPct <= r + 1e-9) return r;
  }
  return null;
}

/**
 * Selisih FASE antara dua deck, dalam detik nyata, sudah dibungkus ke koreksi
 * terkecil. Positif berarti follower harus MAJU.
 *
 * ## Kenapa dihitung pada periode yang lebih KASAR
 *
 * Ini bagian yang paling mudah salah, dan Mixxx pernah kejeblos persis di sini
 * (isu #6618: fase kacau justru saat satu lagu setengah tempo yang lain).
 * Sebabnya: kalau ketukan follower dua kali lebih panjang, "samakan beat
 * distance" jadi ambigu — beat distance 0.5 milik leader bisa berarti dua
 * tempat berbeda di ketukan follower.
 *
 * Karena `Tf = Tl / 2^octave`, salah satu periode SELALU kelipatan bulat yang
 * lain. Jadi menyejajarkan pada periode yang lebih PANJANG otomatis
 * menyejajarkan yang lebih pendek juga, dan ambiguitasnya hilang.
 */
export function phaseDeltaSec(
  leader: SyncDeck,
  follower: SyncDeck,
  leaderBpm: number,
  targetBpm: number,
): number {
  if (leader.grid === null || follower.grid === null) return 0;
  if (!(leaderBpm > 0) || !(targetBpm > 0)) return 0;

  // Detik nyata per ketukan, masing-masing SETELAH tempo sync.
  const tl = 60 / leaderBpm;
  const tf = 60 / targetBpm;
  const p = Math.max(tl, tf);
  if (!(p > 0)) return 0;

  // Waktu nyata sejak titik nol grid masing-masing. Posisi playhead dipakai APA
  // ADANYA di sini — bend yang sudah terjadi memang bagian dari fase sekarang.
  const el = beatIndexAt(leader.playhead, leader.grid, leader.sampleRate) * tl;
  const ef = beatIndexAt(follower.playhead, follower.grid, follower.sampleRate) * tf;

  const raw = (el - ef) % p;
  // Dibungkus ke `[−p/2, p/2)`: koreksi 10 ms ke belakang selalu lebih baik
  // daripada 460 ms ke depan, dan keduanya menghasilkan grid yang sama.
  return ((raw + p * 1.5) % p) - p / 2;
}

/**
 * Sisa selisih fase dalam KETUKAN follower, `[−0.5, 0.5)`. Untuk phase meter.
 *
 * Dinyatakan dalam ketukan, bukan detik, karena itu satuan yang berarti di
 * layar: 0.5 selalu berarti "meleset setengah ketukan" pada tempo berapa pun.
 */
export function phaseErrorBeats(leader: SyncDeck, follower: SyncDeck): number | null {
  const leaderBpm = syncBpmOf(leader);
  const selfBpm = syncBpmOf(follower);
  if (leaderBpm === null || selfBpm === null || follower.grid === null) return null;

  const delta = phaseDeltaSec(leader, follower, leaderBpm, selfBpm);
  const beatSec = 60 / selfBpm;
  if (!(beatSec > 0)) return null;
  const beats = delta / beatSec;
  // Periode kasar bisa lebih panjang dari satu ketukan follower (saat oktafnya
  // berbeda), jadi hasilnya dibungkus sekali lagi ke satu ketukan.
  return ((((beats + 0.5) % 1) + 1) % 1) - 0.5;
}

/**
 * Rencana lengkap untuk menyelaraskan `follower` ke `leader`.
 *
 * Menolak dengan KALIMAT, bukan diam — dan hanya dua hal yang benar-benar bisa
 * menolak sekarang: materi tanpa grid, dan rasio yang tidak muat bahkan di
 * rentang terlebar. Kasus "di luar rentang ±10%" yang dulu sering muncul kini
 * diselesaikan sendiri oleh pelipatan oktaf dan pelebaran rentang.
 */
export function planSync(leader: SyncDeck, follower: SyncDeck): SyncOutcome {
  if (follower.grid === null) return { ok: false, reason: 'deck ini belum punya beat grid' };
  if (leader.grid === null) return { ok: false, reason: 'deck MASTER belum punya beat grid' };

  const leaderBpm = syncBpmOf(leader);
  if (leaderBpm === null) return { ok: false, reason: 'BPM deck MASTER tidak diketahui' };

  const selfGridBpm = follower.grid.bpm;
  const { targetBpm, octave } = foldToOctave(selfGridBpm, leaderBpm);
  const ratio = targetBpm / selfGridBpm;

  const rangePct = smallestRangeFor(ratio, follower.tempo.rangePct);
  if (rangePct === null) {
    const pct = Math.round((ratio - 1) * 1000) / 10;
    return { ok: false, reason: `selisih tempo ${pct}% tidak muat bahkan di rentang terlebar` };
  }

  const fader = faderForBpm(targetBpm, selfGridBpm, rangePct);
  if (fader === null) {
    // Tidak bisa terjadi: `smallestRangeFor` sudah memastikannya muat. Ada
    // sebagai jaring, bukan sebagai jalur.
    return { ok: false, reason: 'tempo di luar jangkauan fader' };
  }

  const deltaSec = phaseDeltaSec(leader, follower, leaderBpm, targetBpm);
  // Detik nyata → sample source: source maju `ratio × sr` sample tiap detik.
  const deltaSamples = Math.round(deltaSec * ratio * follower.sampleRate);

  return {
    ok: true,
    plan: {
      targetBpm,
      ratio,
      octave,
      fader,
      rangePct,
      rangeWidened: rangePct !== follower.tempo.rangePct,
      deltaSamples,
    },
  };
}
