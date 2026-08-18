import { describe, expect, it } from 'vitest';

import type { StudioAsset } from '../store';
import {
  BEATS_PER_BAR,
  MAX_GRID_BPM,
  beatLinesIn,
  resolveBeatGrid,
  samplesPerBar,
  samplesPerBeat,
  snapSourceToBeat,
  sourceAtBeat,
  type BeatGrid,
} from './beat-grid';

const SR = 48_000;

function asset(over: Partial<StudioAsset> = {}): StudioAsset {
  return {
    id: 1,
    name: 'a',
    envelope: { levels: [], frames: 0 } as unknown as StudioAsset['envelope'],
    frames: 60 * SR,
    sampleRate: SR,
    tempo: { bpm: 120, confidence: 0.5, beatOffsetSec: 0 },
    tempoPending: false,
    tempoOctave: 0,
    bpmOverride: null,
    beatOffsetOverride: null,
    ...over,
  };
}

const GRID: BeatGrid = { bpm: 120, offsetSec: 0, beatsPerBar: BEATS_PER_BAR, manual: false };

describe('resolveBeatGrid', () => {
  it('memakai hasil deteksi apa adanya', () => {
    const g = resolveBeatGrid(asset({ tempo: { bpm: 120, confidence: 0.5, beatOffsetSec: 0.25 } }));
    expect(g).not.toBeNull();
    expect(g!.bpm).toBe(120);
    expect(g!.offsetSec).toBeCloseTo(0.25, 6);
    expect(g!.manual).toBe(false);
  });

  it('null kalau belum ada tempo dan tidak ada override', () => {
    expect(resolveBeatGrid(asset({ tempo: null }))).toBeNull();
    expect(resolveBeatGrid(undefined)).toBeNull();
  });

  it('tetap memberi grid kalau HANYA bpmOverride yang diisi', () => {
    const g = resolveBeatGrid(asset({ tempo: null, bpmOverride: 90 }));
    expect(g).not.toBeNull();
    expect(g!.bpm).toBe(90);
    expect(g!.offsetSec).toBe(0);
    expect(g!.manual).toBe(true);
  });

  it('override BPM menang atas deteksi, offset deteksi tetap terpakai', () => {
    const g = resolveBeatGrid(
      asset({ tempo: { bpm: 128, confidence: 0.5, beatOffsetSec: 0.1 }, bpmOverride: 140 }),
    );
    expect(g!.bpm).toBe(140);
    expect(g!.offsetSec).toBeCloseTo(0.1, 6);
  });

  it('koreksi oktaf ×2 / ÷2 ikut terpakai', () => {
    expect(resolveBeatGrid(asset({ tempoOctave: 1 }))!.bpm).toBe(240);
    expect(resolveBeatGrid(asset({ tempoOctave: -1 }))!.bpm).toBe(60);
  });

  it('offset dinormalkan ke satu BAR, termasuk dari nilai negatif', () => {
    const barSec = 2; // 120 BPM, 4/4
    expect(resolveBeatGrid(asset({ beatOffsetOverride: 2.5 }))!.offsetSec).toBeCloseTo(0.5, 6);
    expect(resolveBeatGrid(asset({ beatOffsetOverride: -0.25 }))!.offsetSec).toBeCloseTo(
      barSec - 0.25,
      6,
    );
  });

  it('BPM di luar akal dibatasi, bukan diteruskan', () => {
    expect(resolveBeatGrid(asset({ bpmOverride: 10_000 }))!.bpm).toBe(MAX_GRID_BPM);
    expect(resolveBeatGrid(asset({ bpmOverride: Number.NaN }))).toBeNull();
  });
});

describe('geometri grid', () => {
  it('120 BPM = satu ketukan tiap 0,5 detik', () => {
    expect(samplesPerBeat(GRID, SR)).toBe(0.5 * SR);
    expect(samplesPerBar(GRID, SR)).toBe(2 * SR);
  });

  it('beatLinesIn memberi garis tiap 0,5 detik dengan downbeat tiap 4 ketukan', () => {
    const lines = beatLinesIn(GRID, SR, 0, 4 * SR);
    expect(lines).toHaveLength(8);
    expect(lines.map((l) => l.at)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((s) => s * SR));
    expect(lines.filter((l) => l.downbeat).map((l) => l.at)).toEqual([0, 2 * SR]);
    expect(lines[4]!.bar).toBe(1);
  });

  it('setengah-terbuka di ujung kanan — garis di batas tidak ikut', () => {
    const lines = beatLinesIn(GRID, SR, 0, 2 * SR);
    expect(lines.map((l) => l.at)).toEqual([0, 0.5, 1, 1.5].map((s) => s * SR));
  });

  it('region di tengah lagu tetap sejajar grid absolut', () => {
    const lines = beatLinesIn(GRID, SR, 10.2 * SR, 1.1 * SR);
    expect(lines.map((l) => l.at)).toEqual([10.5, 11].map((s) => s * SR));
  });

  it('offset menggeser seluruh grid', () => {
    const g: BeatGrid = { ...GRID, offsetSec: 0.25 };
    expect(beatLinesIn(g, SR, 0, 1.1 * SR).map((l) => l.at)).toEqual(
      [0.25, 0.75].map((s) => s * SR),
    );
  });

  it('len nol atau negatif tidak menghasilkan garis', () => {
    expect(beatLinesIn(GRID, SR, 0, 0)).toHaveLength(0);
    expect(beatLinesIn(GRID, SR, 0, -100)).toHaveLength(0);
  });
});

describe('snapSourceToBeat', () => {
  it('membulat ke ketukan terdekat di kedua arah', () => {
    expect(snapSourceToBeat(0.2 * SR, GRID, SR, 'beat')).toBe(0);
    expect(snapSourceToBeat(0.3 * SR, GRID, SR, 'beat')).toBe(0.5 * SR);
    expect(snapSourceToBeat(0.7 * SR, GRID, SR, 'beat')).toBe(0.5 * SR);
    expect(snapSourceToBeat(0.8 * SR, GRID, SR, 'beat')).toBe(1 * SR);
  });

  it('membulat ke bar terdekat di kedua arah', () => {
    expect(snapSourceToBeat(0.9 * SR, GRID, SR, 'bar')).toBe(0);
    expect(snapSourceToBeat(1.1 * SR, GRID, SR, 'bar')).toBe(2 * SR);
    expect(snapSourceToBeat(5.9 * SR, GRID, SR, 'bar')).toBe(6 * SR);
  });

  it('bisa mengembalikan posisi negatif — pemanggil yang membatasi', () => {
    expect(snapSourceToBeat(-0.4 * SR, GRID, SR, 'beat')).toBe(-0.5 * SR);
  });

  it('sourceAtBeat kebalikan dari indeks ketukan', () => {
    expect(sourceAtBeat(4, GRID, SR)).toBe(2 * SR);
    expect(sourceAtBeat(-2, GRID, SR)).toBe(-1 * SR);
  });
});
