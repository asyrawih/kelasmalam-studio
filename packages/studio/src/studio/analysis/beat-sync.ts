/** Matematika tempo/beat/bar sync, dipisah dari store dan React agar teruji. */

import {
  MAX_LANE_SPEED,
  MIN_LANE_SPEED,
  type Samples,
  type StudioClip,
  type StudioLane,
} from '../model';
import type { StudioAsset } from '../store';
import {
  beatIndexAt,
  nearestTrackedBeat,
  resolveBeatGridAt,
  sourceAtBeat,
  type BeatDivision,
} from './beat-grid';

export type SyncAlignment = 'tempo' | BeatDivision;

export interface ClipSyncInput {
  readonly targetClip: StudioClip;
  readonly targetLane: StudioLane;
  readonly targetAsset: StudioAsset;
  readonly referenceClip: StudioClip;
  readonly referenceLane: StudioLane;
  readonly referenceAsset: StudioAsset;
  readonly playhead: Samples;
  readonly sampleRate: number;
  readonly alignment: SyncAlignment;
}

export interface ClipSyncResult {
  readonly laneSpeedRatio: number;
  /** Tetap sama untuk tempo-only; berubah untuk beat/bar sync. */
  readonly targetStart: Samples;
}

function sourceAtPlayhead(clip: StudioClip, lane: StudioLane, playhead: Samples): Samples {
  return clip.sourceStart + (playhead - clip.start) * lane.speedRatio;
}

function nearestGridSource(
  sourceAt: Samples,
  asset: StudioAsset,
  sampleRate: number,
  alignment: BeatDivision,
): { source: Samples; bpm: number } | null {
  const grid = resolveBeatGridAt(asset, sourceAt / sampleRate);
  if (grid === null) return null;
  if (alignment === 'beat') {
    const tracked = nearestTrackedBeat(asset, sourceAt, sampleRate);
    if (tracked !== null) return { source: tracked, bpm: grid.bpm };
  }
  const step = alignment === 'bar' ? grid.beatsPerBar : 1;
  const index = Math.round(beatIndexAt(sourceAt, grid, sampleRate) / step) * step;
  return { source: sourceAtBeat(index, grid, sampleRate), bpm: grid.bpm };
}

/**
 * Samakan tempo target dengan reference, lalu opsional sejajarkan beat/bar
 * terdekat di sekitar playhead. Tidak mengubah source region mana pun.
 */
export function computeClipSync(input: ClipSyncInput): ClipSyncResult | null {
  const {
    targetClip,
    targetLane,
    targetAsset,
    referenceClip,
    referenceLane,
    referenceAsset,
    playhead,
    sampleRate,
    alignment,
  } = input;
  if (!(sampleRate > 0)) return null;

  const targetAt = sourceAtPlayhead(targetClip, targetLane, playhead);
  const referenceAt = sourceAtPlayhead(referenceClip, referenceLane, playhead);
  const targetGrid = resolveBeatGridAt(targetAsset, targetAt / sampleRate);
  const referenceGrid = resolveBeatGridAt(referenceAsset, referenceAt / sampleRate);
  if (targetGrid === null || referenceGrid === null || !(targetGrid.bpm > 0)) return null;

  const wantedSpeed = (referenceGrid.bpm * referenceLane.speedRatio) / targetGrid.bpm;
  if (!Number.isFinite(wantedSpeed) || wantedSpeed <= 0) return null;
  const laneSpeedRatio = Math.max(MIN_LANE_SPEED, Math.min(MAX_LANE_SPEED, wantedSpeed));
  if (alignment === 'tempo') return { laneSpeedRatio, targetStart: targetClip.start };

  const targetMark = nearestGridSource(targetAt, targetAsset, sampleRate, alignment);
  const referenceMark = nearestGridSource(referenceAt, referenceAsset, sampleRate, alignment);
  if (targetMark === null || referenceMark === null) return null;

  const referenceTimeline =
    referenceClip.start +
    (referenceMark.source - referenceClip.sourceStart) / referenceLane.speedRatio;
  const targetStart =
    referenceTimeline - (targetMark.source - targetClip.sourceStart) / laneSpeedRatio;

  return { laneSpeedRatio, targetStart: Math.max(0, Math.round(targetStart)) };
}
