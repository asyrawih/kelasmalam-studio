/** Beat-grid ringan untuk waveform clip di arrangement. */

import { beatLinesIn, gridSegments, samplesPerBeat, trackedBeatSamples } from '../analysis/beat-grid';
import type { StudioAsset } from '../store';
import type { WaveWindow } from './wave-window';

export interface ArrangementGridLine {
  /** Posisi dalam CSS pixel, relatif terhadap canvas yang terlihat. */
  readonly x: number;
  readonly downbeat: boolean;
}

const MAX_LINES = 4096;
const MIN_BEAT_PX = 8;
const MIN_BAR_PX = 3;

/**
 * Bangun garis untuk irisan canvas yang tampak. Mendukung tempo segments dan
 * clip loop tanpa mengalokasikan canvas selebar keseluruhan lagu.
 */
export function arrangementGridLines(
  asset: StudioAsset | undefined,
  sourceStart: number,
  sourceLen: number,
  loopLen: number | null,
  sampleRate: number,
  fullWidth: number,
  win: WaveWindow | null,
): readonly ArrangementGridLine[] {
  if (asset === undefined || sourceLen <= 0 || sampleRate <= 0 || fullWidth <= 0) return [];
  const winX = win?.x ?? 0;
  const winW = win?.w ?? fullWidth;
  if (winW <= 0) return [];
  const logicalFrom = (winX / fullWidth) * sourceLen;
  const logicalTo = ((winX + winW) / fullWidth) * sourceLen;
  const tileLen = loopLen !== null && loopLen > 0 ? loopLen : sourceLen;
  const firstTile = Math.max(0, Math.floor(logicalFrom / tileLen));
  const lastTile = Math.max(firstTile, Math.floor(Math.max(logicalFrom, logicalTo - 1) / tileLen));
  const segments = gridSegments(asset);
  const out: ArrangementGridLine[] = [];
  const tracked = trackedBeatSamples(asset, sampleRate);

  for (let tile = firstTile; tile <= lastTile && out.length < MAX_LINES; tile += 1) {
    const tileLogical = tile * tileLen;
    const actualFrom = sourceStart + Math.max(0, logicalFrom - tileLogical);
    const actualTo = sourceStart + Math.min(tileLen, logicalTo - tileLogical);
    if (actualTo <= actualFrom) continue;

    // Marker individual menang atas grid hasil ekstrapolasi. Tanpa downbeat
    // tracker, semuanya sengaja garis beat biasa—setiap marker keempat belum
    // tentu merupakan beat pertama sebuah bar.
    if (tracked.length > 0) {
      const beatPx = tracked.length > 1
        ? (((tracked[tracked.length - 1]! - tracked[0]!) / (tracked.length - 1)) / sourceLen) * fullWidth
        : Infinity;
      if (beatPx >= MIN_BEAT_PX) {
        for (const at of tracked) {
          if (at < actualFrom || at >= actualTo) continue;
          const logical = tileLogical + (at - sourceStart);
          const x = (logical / sourceLen) * fullWidth - winX;
          if (x >= -1 && x <= winW + 1) out.push({ x, downbeat: false });
          if (out.length >= MAX_LINES) break;
        }
      }
      continue;
    }

    for (let i = 0; i < segments.length && out.length < MAX_LINES; i += 1) {
      const segment = segments[i]!;
      const nextAt = segments[i + 1]?.fromSec ?? Infinity;
      const from = Math.max(actualFrom, segment.fromSec * sampleRate);
      const to = Math.min(actualTo, nextAt * sampleRate);
      if (to <= from) continue;
      const beatPx = (samplesPerBeat(segment.grid, sampleRate) / sourceLen) * fullWidth;
      const showBeat = beatPx >= MIN_BEAT_PX;
      if (beatPx * segment.grid.beatsPerBar < MIN_BAR_PX) continue;

      for (const line of beatLinesIn(segment.grid, sampleRate, from, to - from)) {
        if (!line.downbeat && !showBeat) continue;
        const logical = tileLogical + (line.at - sourceStart);
        const x = (logical / sourceLen) * fullWidth - winX;
        if (x >= -1 && x <= winW + 1) out.push({ x, downbeat: line.downbeat });
        if (out.length >= MAX_LINES) break;
      }
    }
  }
  return out;
}

export function drawArrangementBeatGrid(
  ctx: CanvasRenderingContext2D,
  lines: readonly ArrangementGridLine[],
  height: number,
): void {
  const draw = (downbeat: boolean): void => {
    ctx.beginPath();
    for (const line of lines) {
      if (line.downbeat !== downbeat) continue;
      const x = Math.round(line.x) + 0.5;
      ctx.moveTo(x, downbeat ? 0 : height * 0.28);
      ctx.lineTo(x, downbeat ? height : height * 0.84);
    }
    ctx.strokeStyle = downbeat ? '#ffffffe0' : '#ffffff70';
    ctx.lineWidth = downbeat ? 1.5 : 1;
    ctx.stroke();
  };
  draw(false);
  draw(true);
}
