/** Posisi terakhir cursor di area clip, dalam sample timeline. */
let cursorSamples: number | null = null;

export function setTimelineCursor(samples: number): void {
  cursorSamples = Number.isFinite(samples) ? Math.max(0, samples) : null;
}

export function clearTimelineCursor(): void {
  cursorSamples = null;
}

export function getTimelineCursor(): number | null {
  return cursorSamples;
}
