import { describe, expect, it } from 'vitest';

import type { StudioAsset } from '../store';
import { arrangementGridLines } from './arrangement-beat-grid';

const SR = 48_000;
const asset = (bpm = 120): StudioAsset => ({
  id: 1, name: 'beat', contentHash: '', envelope: { levels: [], frames: 0 },
  frames: 20 * SR, sampleRate: SR, tempo: { bpm, confidence: 1, beatOffsetSec: 0 },
  tempoPending: false, tempoOctave: 0, bpmOverride: null, beatOffsetOverride: null,
  analysisLock: false,
});

describe('arrangement beat grid', () => {
  it('120 BPM membuat empat beat per bar dengan downbeat lebih jarang', () => {
    const lines = arrangementGridLines(asset(), 0, 4 * SR, null, SR, 400, null);
    expect(lines.map((line) => Math.round(line.x))).toEqual([0, 50, 100, 150, 200, 250, 300, 350]);
    expect(lines.filter((line) => line.downbeat).map((line) => Math.round(line.x))).toEqual([0, 200]);
    expect(lines.filter((line) => line.downbeat).map((line) => line.bar)).toEqual([0, 1]);
  });

  it('virtual window mengembalikan koordinat relatif terhadap canvas terlihat', () => {
    const lines = arrangementGridLines(asset(), 0, 4 * SR, null, SR, 400, { x: 100, w: 100 });
    expect(lines.filter((line) => line.x >= 0).map((line) => Math.round(line.x))).toEqual([0, 50]);
  });

  it('loop mengulang grid pada setiap tile', () => {
    const lines = arrangementGridLines(asset(), 0, 4 * SR, SR, SR, 400, null);
    expect(lines.map((line) => Math.round(line.x))).toEqual([0, 50, 100, 150, 200, 250, 300, 350]);
  });

  it('marker tracker menang atas ekstrapolasi periodik dan tidak mengarang downbeat', () => {
    const tracked = {
      ...asset(),
      tempo: {
        bpm: 120,
        confidence: 1,
        beatOffsetSec: 0,
        beatTimesSec: [0, 0.51, 1.01, 1.52],
      },
    };
    const lines = arrangementGridLines(tracked, 0, 2 * SR, null, SR, 200, null);
    expect(lines.map((line) => Math.round(line.x))).toEqual([0, 51, 101, 152]);
    expect(lines.every((line) => !line.downbeat)).toBe(true);
    expect(lines.filter((line) => line.barStart).map((line) => Math.round(line.x))).toEqual([0]);
  });
});
