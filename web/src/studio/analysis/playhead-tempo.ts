/**
 * "Clip mana yang sedang aktif, dan berapa BPM-nya" — sumber tunggal untuk
 * readout BPM.
 *
 * Dipisah dari komponennya supaya bisa diuji tanpa merender apa pun. Aturan
 * di sini kecil-kecil tapi semuanya punya cara gagal yang tidak kelihatan dari
 * layar, dan itu justru yang perlu dikunci tes.
 *
 * DUA RUANG KECEPATAN, dan hanya satu yang relevan di sini:
 *   - `lane.speedRatio` × `state.speed` = yang benar-benar TERDENGAR sekarang.
 *     Itu yang dipakai, karena readout BPM menjawab "yang berbunyi ini berapa".
 *   - `state.renderSpeed` hanya berlaku saat COMPILE. Ia sudah punya selnya
 *     sendiri (COMPILE OUT); memasukkannya ke sini akan membuat angka BPM
 *     berubah saat user menggeser slider yang tidak mengubah apa pun yang
 *     sedang didengar.
 */

import { effectiveSpeed, isAudible } from '../model';
import type { StudioAppState, StudioAsset } from '../store';

export interface ActiveTempo {
  readonly laneId: string;
  readonly laneName: string;
  readonly clipId: string;
  /** BPM yang TERDENGAR: sumber × koreksi oktaf × kecepatan lane × transport. */
  readonly bpm: number;
  /** BPM materi sumber setelah koreksi oktaf user, sebelum kecepatan apa pun. */
  readonly sourceBpm: number;
  readonly confidence: number;
  /** `lane.speedRatio × state.speed`. 1 berarti materi diputar apa adanya. */
  readonly speedFactor: number;
}

export interface PlayheadTempo {
  /** Clip teratas di playhead yang tempo-nya sudah diketahui. */
  readonly primary: ActiveTempo | null;
  /** Clip aktif lain yang tempo-nya diketahui, urut lane. */
  readonly others: readonly ActiveTempo[];
  /** Ada clip di playhead yang analisisnya masih berjalan. */
  readonly pending: boolean;
  /** Ada clip di playhead yang sudah dianalisis dan memang tanpa tempo. */
  readonly unknown: boolean;
  /** Sama sekali tidak ada clip terdengar di posisi playhead. */
  readonly idle: boolean;
}

export interface BpmSyncPlan {
  readonly target: ActiveTempo;
  readonly reference: ActiveTempo;
  /** Nilai baru untuk `lane.speedRatio`. */
  readonly laneSpeedRatio: number;
}

/**
 * Rencana BPM-sync untuk materi yang sedang bertumpuk di playhead.
 *
 * Clip terpilih menjadi target bila ia sedang aktif. Tanpa pilihan aktif,
 * lane kedua mengikuti lane pertama. Hanya tempo yang disamakan; fase atau
 * posisi downbeat tidak digeser.
 */
export function bpmSyncPlan(t: PlayheadTempo, selectedClipId: string | null): BpmSyncPlan | null {
  if (t.primary === null) return null;
  const active = [t.primary, ...t.others];
  const selected = active.find((entry) => entry.clipId === selectedClipId);
  const target = selected ?? t.others.find((entry) => entry.laneId !== t.primary?.laneId);
  if (target === undefined) return null;
  const reference = active.find((entry) => entry.laneId !== target.laneId);
  if (reference === undefined || !(target.bpm > 0)) return null;

  // speedFactor = lane.speedRatio × transport speed. Transport sama untuk
  // kedua lane, jadi ia gugur dari rasio dan tidak perlu dibaca terpisah.
  return {
    target,
    reference,
    laneSpeedRatio: (target.speedFactor * reference.bpm) / target.bpm,
  };
}

/** BPM sumber setelah koreksi oktaf user (×2 / ÷2). */
export function correctedBpm(asset: StudioAsset): number | null {
  if (asset.bpmOverride !== null) return asset.bpmOverride;
  if (asset.tempo === null) return null;
  return asset.tempo.bpm * 2 ** asset.tempoOctave;
}

/**
 * Memo satu-slot terhadap REFERENSI state.
 *
 * `useStudio` dibangun di atas `useSyncExternalStore`, yang membandingkan
 * snapshot dengan `Object.is` dan tidak menerima fungsi kesetaraan. Selector
 * yang membangun objek baru tiap panggilan karenanya tidak pernah terlihat
 * sama, dan React akan me-render ulang tanpa henti — gejalanya bukan "lambat"
 * melainkan "Maximum update depth exceeded".
 *
 * Satu slot sudah cukup karena semua komponen membaca snapshot yang SAMA dalam
 * satu putaran render. Kuncinya referensi state, dan itu sah selama store
 * benar-benar imutabel (setiap aksi membuat objek baru lewat `set`) — kalau
 * suatu saat ada yang memutasi state di tempat, memo ini akan basi, dan itu
 * memang alasan tambahan untuk tidak pernah memutasinya.
 */
let memoKey: StudioAppState | null = null;
let memoValue: PlayheadTempo | null = null;

export function selectPlayheadTempo(s: StudioAppState): PlayheadTempo {
  if (memoKey === s && memoValue !== null) return memoValue;
  const next = computePlayheadTempo(s);
  // Referensi LAMA dipertahankan kalau isinya sama persis.
  //
  // Kunci berbasis referensi state saja tidak cukup: SETIAP aksi membuat state
  // baru, dan saat scrub itu berarti sekali per `pointermove`. Objek hasil yang
  // selalu baru terbaca sebagai "berubah" oleh `useSyncExternalStore`, jadi sel
  // BPM ikut render ulang puluhan kali per detik walau angkanya tidak bergerak
  // sedikit pun — playhead bergeser 3 px di dalam clip yang sama tidak mengubah
  // apa-apa yang dipajang. Perbandingan isi di bawah yang menghentikannya.
  const value = memoValue !== null && sameTempo(memoValue, next) ? memoValue : next;
  memoKey = s;
  memoValue = value;
  return value;
}

function sameEntry(a: ActiveTempo, b: ActiveTempo): boolean {
  return (
    a.laneId === b.laneId &&
    a.clipId === b.clipId &&
    a.laneName === b.laneName &&
    a.bpm === b.bpm &&
    a.sourceBpm === b.sourceBpm &&
    a.confidence === b.confidence &&
    a.speedFactor === b.speedFactor
  );
}

/** Kesetaraan ISI — bukan referensi. Semua field-nya primitif, jadi cukup satu
 *  lapis; kalau nanti ada field objek di sini, ia harus ikut dibandingkan atau
 *  memo di atas akan menahan nilai basi. */
function sameTempo(a: PlayheadTempo, b: PlayheadTempo): boolean {
  if (a.pending !== b.pending || a.unknown !== b.unknown || a.idle !== b.idle) return false;
  if (a.primary === null || b.primary === null) {
    if (a.primary !== b.primary) return false;
  } else if (!sameEntry(a.primary, b.primary)) {
    return false;
  }
  if (a.others.length !== b.others.length) return false;
  return a.others.every((o, i) => {
    const other = b.others[i];
    return other !== undefined && sameEntry(o, other);
  });
}

function computePlayheadTempo(s: StudioAppState): PlayheadTempo {
  const found: ActiveTempo[] = [];
  let pending = false;
  let unknown = false;
  let anyClip = false;

  for (const lane of s.lanes) {
    // Lane yang di-mute atau dibungkam SOLO tidak terdengar, jadi BPM-nya tidak
    // menjawab pertanyaan "yang berbunyi ini berapa".
    if (!isAudible(lane, s.lanes)) continue;
    for (const clip of lane.clips) {
      // Setengah-terbuka: pada batas tepat `start + len` clip berikutnya yang
      // berbunyi, bukan yang ini. Kalau keduanya dianggap aktif, readout akan
      // berkedip satu frame di setiap sambungan clip.
      if (s.playhead < clip.start || s.playhead >= clip.start + clip.len) continue;
      anyClip = true;

      const asset = s.assets[clip.assetId];
      if (asset === undefined) continue;
      if (asset.tempoPending) {
        pending = true;
        continue;
      }
      const source = correctedBpm(asset);
      if (source === null || asset.tempo === null) {
        unknown = true;
        continue;
      }
      const speedFactor = effectiveSpeed(lane, s.speed);
      found.push({
        laneId: lane.id,
        laneName: lane.name,
        clipId: clip.id,
        bpm: source * speedFactor,
        sourceBpm: source,
        confidence: asset.tempo.confidence,
        speedFactor,
      });
    }
  }

  const [primary = null, ...others] = found;
  return { primary, others, pending, unknown, idle: !anyClip };
}
