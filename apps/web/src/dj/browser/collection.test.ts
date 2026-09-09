import { describe, expect, it } from 'vitest';

import type { StudioAsset } from '../../studio/store';
import { filterSort, rowsOf, type CollectionRow } from './collection';

const asset = (id: number, name: string, bpm: number | null, frames: number): StudioAsset =>
  ({
    id,
    name,
    envelope: { frames: 0, levels: [] },
    frames,
    sampleRate: 48_000,
    tempo: bpm === null ? null : { bpm, confidence: 0.5, beatOffsetSec: 0 },
    tempoPending: false,
    tempoOctave: 0,
    bpmOverride: null,
    beatOffsetOverride: null,
  }) as unknown as StudioAsset;

const rows = (): CollectionRow[] =>
  rowsOf({
    1: asset(1, 'CHARLIE', 128, 48_000 * 300),
    2: asset(2, 'alpha', null, 48_000 * 100),
    3: asset(3, 'Bravo', 90, 48_000 * 200),
  });

describe('rowsOf', () => {
  it('BPM null untuk materi yang tidak bisa di-grid — bukan 0', () => {
    const r = rows().find((x) => x.asset.id === 2);
    expect(r?.bpm).toBeNull();
  });

  it('durasi diturunkan dari frames dan sample rate', () => {
    const r = rows().find((x) => x.asset.id === 1);
    expect(r?.durationSec).toBeCloseTo(300, 6);
  });
});

describe('filterSort', () => {
  it('menyaring tanpa peduli besar-kecil huruf', () => {
    expect(filterSort(rows(), 'BRA', 'name', true).map((r) => r.name)).toEqual(['Bravo']);
    expect(filterSort(rows(), '  ', 'name', true)).toHaveLength(3);
  });

  it('urut BPM menaruh yang TIDAK DIKETAHUI di akhir', () => {
    const asc = filterSort(rows(), '', 'bpm', true).map((r) => r.bpm);
    expect(asc).toEqual([90, 128, null]);
  });

  it('...dan tetap di akhir saat arahnya dibalik', () => {
    // Kalau `null` ikut dibalik, seluruh lagu yang belum dianalisis akan
    // menumpuk di PUNCAK daftar — tepat menutupi lagu yang sedang dicari.
    const desc = filterSort(rows(), '', 'bpm', false).map((r) => r.bpm);
    expect(desc).toEqual([128, 90, null]);
  });

  it('urut nama tidak peduli besar-kecil huruf', () => {
    expect(filterSort(rows(), '', 'name', true).map((r) => r.name)).toEqual([
      'alpha',
      'Bravo',
      'CHARLIE',
    ]);
  });

  it('urut waktu memakai durasi, bukan nama', () => {
    expect(filterSort(rows(), '', 'time', true).map((r) => r.name)).toEqual([
      'alpha',
      'Bravo',
      'CHARLIE',
    ]);
  });
});
