/**
 * State beat/loop yang DIBAGI antara topbar dan Clip Detail.
 *
 * Kenapa perlu: kontrolnya (BPM, zoom, panjang loop, LOOP PLAY) sekarang duduk
 * di bar sticky di atas halaman, sedangkan yang MEMAKAI hasilnya — grid di
 * waveform, jendela geser, tarikan untuk menaruh loop — ada di Clip Detail.
 * Keduanya cabang pohon yang berbeda, jadi state-nya tidak bisa lagi jadi milik
 * salah satunya.
 *
 * Context, bukan store: `bars`, `zoom`, dan posisi region adalah pilihan
 * SEMENTARA sebelum menekan tombol — bukan bagian dari karya. Yang benar-benar
 * milik project (BPM manual, offset downbeat, region yang sedang diaudisi)
 * memang sudah tersimpan di store.
 *
 * "Clip yang dipajang" juga ikut pindah ke sini, karena topbar dan Clip Detail
 * WAJIB menunjuk clip yang sama. Kalau masing-masing menghitungnya sendiri,
 * suatu saat keduanya akan berbeda dan tidak ada yang memberi tahu.
 */

import { createContext, useContext, useRef, type ReactNode } from 'react';

import { findClip, type StudioClip, type StudioLane } from '../model';
import { useStudio } from '../store';
import { useBeatState, type BeatState } from './BeatSection';

export interface ShownClip {
  readonly lane: StudioLane;
  readonly clip: StudioClip;
}

export interface BeatShared {
  /** Clip yang dipajang, atau null kalau project tidak punya clip. */
  readonly shown: ShownClip | null;
  /** true kalau yang dipajang memang sedang terpilih di timeline. */
  readonly isSelected: boolean;
  readonly beat: BeatState;
}

const Ctx = createContext<BeatShared | null>(null);

/**
 * Clip mana yang dipajang saat tidak ada yang terpilih dan clip terakhir sudah
 * hilang.
 *
 * Yang di bawah PLAYHEAD lebih dulu — itu clip yang paling mungkin sedang
 * dipikirkan user, dan pilihannya bisa ditebak dari layar. Kalau playhead
 * berada di ruang kosong, ambil clip paling awal. `null` hanya kalau project
 * benar-benar tidak punya clip.
 */
export function fallbackClip(lanes: readonly StudioLane[], playhead: number): ShownClip | null {
  let earliest: ShownClip | null = null;
  for (const lane of lanes) {
    for (const clip of lane.clips) {
      if (playhead >= clip.start && playhead < clip.start + clip.len) return { lane, clip };
      if (earliest === null || clip.start < earliest.clip.start) earliest = { lane, clip };
    }
  }
  return earliest;
}

export function BeatProvider({ children }: { readonly children: ReactNode }): JSX.Element {
  const lanes = useStudio((s) => s.lanes);
  const assets = useStudio((s) => s.assets);
  const selectedClipId = useStudio((s) => s.selectedClipId);
  const sampleRate = useStudio((s) => s.sampleRate);
  const playhead = useStudio((s) => s.playhead);

  /**
   * Clip yang dipajang BERTAHAN setelah seleksi dilepas.
   *
   * Alasannya tata letak, bukan kenyamanan: Clip Detail boleh diletakkan di ATAS
   * timeline, dan kalau isinya mengempis tiap kali seleksi kosong, timeline di
   * bawahnya melompat. Itu terjadi puluhan kali saat menarik KOTAK SELEKSI —
   * persis ketika posisi timeline harus diam, karena kotak yang ditarik diukur
   * terhadapnya. Keadaannya ditandai "TIDAK TERPILIH" di panel.
   */
  const stickyId = useRef<string | null>(null);
  if (selectedClipId !== null) stickyId.current = selectedClipId;
  // Di-resolve ulang dari `lanes`, bukan disimpan sebagai objek: clip-nya bisa
  // ikut berubah (atau dihapus) selama ia dipajang.
  let shown = findClip(lanes, selectedClipId ?? stickyId.current);
  if (shown === null) {
    shown = fallbackClip(lanes, playhead);
    if (shown !== null) stickyId.current = shown.clip.id;
  }

  const clip = shown?.clip;
  const beat = useBeatState(
    clip,
    clip === undefined ? undefined : assets[clip.assetId],
    sampleRate,
    shown?.lane.speedRatio ?? 1,
  );

  const value: BeatShared = {
    shown,
    isSelected: shown !== null && shown.clip.id === selectedClipId,
    beat,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBeatShared(): BeatShared {
  const v = useContext(Ctx);
  if (v === null) throw new Error('useBeatShared dipakai di luar <BeatProvider>');
  return v;
}
