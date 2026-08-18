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

/** BPM sumber setelah koreksi oktaf user (×2 / ÷2). */
export function correctedBpm(asset: StudioAsset): number | null {
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
  const value = computePlayheadTempo(s);
  memoKey = s;
  memoValue = value;
  return value;
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
