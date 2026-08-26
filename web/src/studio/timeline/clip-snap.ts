import type { StudioLane } from '../model';
import type { ClipOrigin } from '../store';

export interface ClipSnapResult {
  readonly deltaSamples: number;
  readonly guideSample: number | null;
}

/** Toleransi magnet dalam piksel, stabil pada semua level zoom. */
export const SNAP_THRESHOLD_PX = 10;

/** Snap rombongan clip ke edge clip diam dan cegah overlap pada lane tujuan. */
export function snapClipMove(
  lanes: readonly StudioLane[],
  origins: readonly ClipOrigin[],
  rawDelta: number,
  deltaLanes: number,
  samplesPerPx: number,
): ClipSnapResult {
  if (origins.length === 0) return { deltaSamples: rawDelta, guideSample: null };
  const moving = new Set(origins.map((origin) => origin.id));
  const threshold = Math.max(1, samplesPerPx * SNAP_THRESHOLD_PX);
  let delta = Math.round(rawDelta);
  let guide: number | null = null;

  const clipFor = (id: string) => lanes.flatMap((lane) => lane.clips).find((clip) => clip.id === id);
  let best = threshold + 1;
  for (const origin of origins) {
    const clip = clipFor(origin.id);
    const targetLane = lanes[origin.laneIndex + deltaLanes];
    if (clip === undefined || targetLane === undefined) continue;
    const movingEdges = [origin.start + delta, origin.start + delta + clip.len];
    for (const fixed of targetLane.clips) {
      if (moving.has(fixed.id)) continue;
      for (const fixedEdge of [fixed.start, fixed.start + fixed.len]) {
        for (const movingEdge of movingEdges) {
          const correction = fixedEdge - movingEdge;
          if (Math.abs(correction) <= threshold && Math.abs(correction) < best) {
            best = Math.abs(correction);
            delta += correction;
            guide = fixedEdge;
          }
        }
      }
    }
  }

  // Magnet tidak boleh membiarkan dua audio menempati waktu yang sama pada
  // lane yang sama. Koreksi berulang menangani deretan clip yang rapat.
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;
    for (const origin of origins) {
      const clip = clipFor(origin.id);
      const targetLane = lanes[origin.laneIndex + deltaLanes];
      if (clip === undefined || targetLane === undefined) continue;
      const start = origin.start + delta;
      const end = start + clip.len;
      for (const fixed of targetLane.clips) {
        if (moving.has(fixed.id) || end <= fixed.start || start >= fixed.start + fixed.len) continue;
        const cameFromLeft = origin.start + clip.len <= fixed.start || rawDelta >= 0;
        delta = cameFromLeft ? fixed.start - origin.start - clip.len : fixed.start + fixed.len - origin.start;
        guide = cameFromLeft ? fixed.start : fixed.start + fixed.len;
        changed = true;
      }
    }
    if (!changed) break;
  }

  return { deltaSamples: delta, guideSample: guide };
}
