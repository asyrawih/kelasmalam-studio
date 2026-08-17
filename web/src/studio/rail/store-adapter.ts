/**
 * Jembatan rail → `studio/store.ts`.
 *
 * Store dipakai APA ADANYA (rail tidak menyimpan state sendiri). File ini hanya
 * menyediakan hook selector yang sudah "aman" untuk rail dan menggabungkan
 * beberapa action yang di rail selalu berjalan bersama (mis. preset EQ =
 * `setPreset` + `setLaneEq` ke lane terpilih).
 *
 * Aturan store: selector HARUS mengembalikan nilai yang stabil secara referensi.
 * Semua selector di sini mengembalikan primitif atau objek yang memang tersimpan
 * di state — tidak ada objek baru per panggilan (itu penyebab loop re-render).
 */

import { studioActions, studioStore, useStudio, type StudioAppState } from '../store';
import {
  EQ_PRESETS,
  cloneEq,
  type EqBandId,
  type EqPreset,
  type StudioLane,
} from '../model';

export { studioActions, studioStore, useStudio };
export type { StudioAppState };

// ── Selector primitif ────────────────────────────────────────────────────────

export const useTab = (): StudioAppState['tab'] => useStudio((s) => s.tab);
export const usePlaying = (): boolean => useStudio((s) => s.playing);
export const useSpeed = (): StudioAppState['speed'] => useStudio((s) => s.speed);
export const useLanes = (): readonly StudioLane[] => useStudio((s) => s.lanes);
export const useSelectedLaneId = (): string | null => useStudio((s) => s.selectedLaneId);
export const useFormat = (): StudioAppState['format'] => useStudio((s) => s.format);
export const usePreset = (): EqPreset => useStudio((s) => s.preset);
export const useExportProgress = (): number | null => useStudio((s) => s.exportProgress);
export const useSampleRate = (): number => useStudio((s) => s.sampleRate);
export const useProjectName = (): string => useStudio((s) => s.projectName);

/** Lane terpilih — objek dari state, jadi referensinya stabil. */
export function useSelectedLane(): StudioLane | null {
  return useStudio((s) => s.lanes.find((l) => l.id === s.selectedLaneId) ?? null);
}

// ── Action gabungan ──────────────────────────────────────────────────────────

/**
 * Preset EQ berlaku ke LANE TERPILIH: store menyimpan nama preset-nya
 * (`setPreset`, dipakai untuk sorotan tombol) sementara nilai band-nya hidup di
 * lane (`setLaneEq`). Keduanya harus bergerak bersama, jadi digabung di sini.
 */
export function applyEqPreset(preset: EqPreset): void {
  studioActions.setPreset(preset);
  const laneId = studioStore.getState().selectedLaneId;
  if (laneId !== null) studioActions.setLaneEq(laneId, cloneEq(EQ_PRESETS[preset]));
}

/**
 * Ubah satu band EQ lane. Hanya field yang berubah yang dikirim: drag node
 * mengubah freq+gain sekaligus, double-click hanya gain.
 */
export function setEqBand(
  laneId: string,
  bandId: EqBandId,
  patch: { freq?: number; gainDb?: number; q?: number },
): void {
  studioActions.setLaneEqBand(laneId, bandId, patch);
}
