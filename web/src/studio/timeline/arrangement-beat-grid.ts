/** Beat-grid ringan untuk waveform clip di arrangement. */

import { beatLinesIn, gridSegments, samplesPerBeat, trackedBeatSamples } from '../analysis/beat-grid';
import type { StudioAsset } from '../store';
import type { WaveWindow } from './wave-window';

export interface ArrangementGridLine {
  /** Posisi dalam CSS pixel, relatif terhadap canvas yang terlihat. */
  readonly x: number;
  readonly downbeat: boolean;
  /** Awal kelompok empat beat; provisional bila `downbeat === false`. */
  readonly barStart: boolean;
  /** Nomor kelompok bar visual. */
  readonly bar: number | null;
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
        for (const [beatIndex, at] of tracked.entries()) {
          if (at < actualFrom || at >= actualTo) continue;
          const logical = tileLogical + (at - sourceStart);
          const x = (logical / sourceLen) * fullWidth - winX;
          const visualBeat = tile * tracked.length + beatIndex;
          if (x >= -1 && x <= winW + 1) {
            out.push({
              x,
              downbeat: false,
              barStart: visualBeat % 4 === 0,
              bar: Math.floor(visualBeat / 4),
            });
          }
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

      const barSamples = samplesPerBeat(segment.grid, sampleRate) * segment.grid.beatsPerBar;
      // Hanya downbeat TERAKHIR sebelum jendela disertakan untuk meneruskan
      // tint ke sisi kiri. Memasukkan satu bar penuh akan menduplikasi marker
      // pada setiap tile loop.
      if (tile === firstTile && actualFrom > sourceStart && from === actualFrom) {
        const priorFrom = Math.max(segment.fromSec * sampleRate, from - barSamples);
        const prior = beatLinesIn(segment.grid, sampleRate, priorFrom, from - priorFrom)
          .filter((line) => line.downbeat)
          .at(-1);
        if (prior !== undefined) {
          const logical = tileLogical + (prior.at - sourceStart);
          out.push({
            x: (logical / sourceLen) * fullWidth - winX,
            downbeat: true,
            barStart: true,
            bar: prior.bar,
          });
        }
      }
      for (const line of beatLinesIn(segment.grid, sampleRate, from, to - from)) {
        if (!line.downbeat && !showBeat) continue;
        const logical = tileLogical + (line.at - sourceStart);
        const x = (logical / sourceLen) * fullWidth - winX;
        if (x >= -1 && x <= winW + 1) {
          out.push({ x, downbeat: line.downbeat, barStart: line.downbeat, bar: line.bar });
        }
        if (out.length >= MAX_LINES) break;
      }
    }
  }
  return out;
}

export function drawArrangementBeatGrid(
  ctx: CanvasRenderingContext2D,
  lines: readonly ArrangementGridLine[],
  _width: number,
  height: number,
): void {
  const bars = lines.filter((line) => line.barStart && line.bar !== null).sort((a, b) => a.x - b.x);

  const path = (downbeat: boolean): void => {
    ctx.beginPath();
    for (const line of lines) {
      if (line.downbeat !== downbeat) continue;
      const x = Math.round(line.x) + 0.5;
      ctx.moveTo(x, downbeat ? 0 : height * 0.28);
      ctx.lineTo(x, downbeat ? height : height * 0.84);
    }
  };
  const draw = (downbeat: boolean): void => {
    // Halo gelap dulu: garis tetap terbaca di puncak waveform putih/kuning.
    path(downbeat);
    ctx.strokeStyle = '#000000c7';
    ctx.lineWidth = downbeat ? 3 : 2.25;
    ctx.stroke();
    path(downbeat);
    ctx.strokeStyle = downbeat ? '#ff202b' : '#17c9ee';
    ctx.lineWidth = downbeat ? 1.5 : 1;
    ctx.stroke();
  };
  draw(false);

  // Batas kelompok 4 beat: merah seperti referensi DJ, tanpa bidang tint agar
  // waveform tetap menjadi informasi utama.
  for (const line of bars) {
    const x = Math.round(line.x) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.strokeStyle = '#000000d9';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.strokeStyle = '#ff202b';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Cap segitiga di atas/bawah membuat garis tetap terbaca saat transien besar
  // menutupi bagian tengahnya. Beat biasa abu-abu, batas bar merah.
  for (const line of lines) {
    if (line.x < -4) continue;
    const x = Math.round(line.x) + 0.5;
    const major = line.barStart;
    const color = major ? '#ff202b' : '#89939a';
    const half = major ? 4 : 2.5;
    const depth = major ? 6 : 4;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x - half, 1);
    ctx.lineTo(x + half, 1);
    ctx.lineTo(x, 1 + depth);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x - half, height - 1);
    ctx.lineTo(x + half, height - 1);
    ctx.lineTo(x, height - 1 - depth);
    ctx.closePath();
    ctx.fill();
  }
}
