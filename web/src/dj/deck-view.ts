/**
 * `DeckState` (store DJ) × `StudioAsset` (kepustakaan) → segala yang perlu
 * DILIHAT.
 *
 * Ada sebagai fungsi MURNI, bukan sebagai field di store, karena separuh isinya
 * berasal dari asset — dan asset bisa berubah dari halaman lain: user mengetik
 * BPM manual atau menggeser downbeat di `/studio`, dan `resolveBeatGrid`
 * langsung memberi jawaban lain. Menyimpannya di store berarti angka BPM di
 * deck bisa basi tanpa ada satu pun yang memberi tahu.
 *
 * Aturan yang dipakai di seluruh folder ini: **kalau sebuah nilai bisa berubah
 * dari luar deck, turunkan — jangan simpan.**
 */

import { resolveBeatGridAt, type BeatGrid } from '../studio/analysis/beat-grid';
import { TEMPO_UNCERTAIN, type StudioAsset } from '../studio/store';
import {
  deckPositionSec,
  deckRemainingSec,
  effectiveBpm,
  loopLen,
  tempoPercent,
  type DeckState,
  type Samples,
} from './model';

export interface DeckView {
  readonly deck: DeckState;
  readonly asset: StudioAsset | undefined;
  /** `null` = deck kosong ATAU materinya tidak bisa di-grid. */
  readonly grid: BeatGrid | null;
  /** BPM materi sebelum tempo fader. */
  readonly baseBpm: number | null;
  /** BPM yang benar-benar terdengar. */
  readonly effBpm: number | null;
  readonly tempoPct: number;
  readonly positionSec: number;
  readonly remainingSec: number;
  readonly durationSec: number;
  readonly loopBeats: number | null;
  readonly loopSamples: Samples | null;
  /**
   * true kalau deck menunjuk `assetId` yang TIDAK ada di kepustakaan.
   *
   * Terpisah dari "deck kosong": UI menulis "ASSET HILANG" dan mematikan
   * transport, bukan diam dan bukan crash. Deck sengaja TIDAK di-eject otomatis
   * — menghapus keadaan user secara diam-diam adalah cara termudah
   * menghilangkan hot cue yang butuh sepuluh menit dipasang, dan cue-nya tetap
   * berlaku lagi begitu asset-nya kembali.
   */
  readonly missing: boolean;
  /** true selama `tempoPending` — UI menulis "ANALISIS…", bukan angka. */
  readonly analyzing: boolean;
  /** true kalau BPM-nya ada tapi keyakinannya rendah — angkanya ditandai. */
  readonly bpmUncertain: boolean;
}

export function deckView(deck: DeckState, asset: StudioAsset | undefined): DeckView {
  const missing = deck.assetId !== null && asset === undefined;
  /*
   * Grid dibaca DI POSISI PLAYHEAD, bukan di awal lagu.
   *
   * Untuk lagu bertempo tetap — yaitu hampir semuanya — keduanya sama persis.
   * Bedanya baru muncul pada lagu yang punya anchor ruas (`[Dynamic]`), dan di
   * sanalah satu baris ini menjadi seluruh perbedaannya: SEMUA yang menumpang
   * grid deck (quantize, loop, beat jump, SYNC, metronom, FX) membacanya dari
   * `view.grid`, jadi mereka ikut pindah ruas tanpa satu pun tahu tentang ruas.
   *
   * Titik masuk tunggal itu yang membuat `[Dynamic]` mungkin tanpa menyisir
   * ulang enam pemanggil — dan yang menjamin mereka tidak pernah bisa memakai
   * ruas yang berbeda dari yang digambar.
   */
  const sr = deck.sampleRate > 0 ? deck.sampleRate : 48_000;
  const grid = asset === undefined ? null : resolveBeatGridAt(asset, deck.playhead / sr);
  const baseBpm = grid === null ? null : grid.bpm;
  const len = loopLen(deck.loop);

  return {
    deck,
    asset,
    grid,
    baseBpm,
    effBpm: effectiveBpm(baseBpm, deck.tempo),
    tempoPct: tempoPercent(deck.tempo),
    positionSec: deckPositionSec(deck),
    remainingSec: deckRemainingSec(deck),
    durationSec: deck.frames / (deck.sampleRate > 0 ? deck.sampleRate : 48_000),
    loopBeats: deck.loop.beats,
    loopSamples: len,
    missing,
    analyzing: asset?.tempoPending === true,
    // "Tidak yakin" hanya berlaku untuk angka HASIL DETEKSI. BPM yang diketik
    // user (`bpmOverride`) adalah keputusannya sendiri dan tidak pantas
    // ditandai ragu — sama seperti `BpmCell` di Studio memperlakukannya.
    bpmUncertain:
      asset !== undefined &&
      asset.bpmOverride === null &&
      asset.tempo !== null &&
      asset.tempo.confidence < TEMPO_UNCERTAIN,
  };
}

/** Region loop untuk `ScrollingWave`, atau `null` kalau tidak ada loop. */
export function loopRegion(
  deck: DeckState,
): { readonly sourceStart: Samples; readonly sourceLen: Samples } | null {
  const len = loopLen(deck.loop);
  if (len === null || deck.loop.inAt === null) return null;
  return { sourceStart: deck.loop.inAt, sourceLen: len };
}
