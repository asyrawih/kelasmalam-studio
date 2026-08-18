import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BpmCell, tempoNote } from './BpmCell';
import type { PlayheadTempo } from '../analysis/playhead-tempo';
import { studioActions, studioStore, type StudioAsset } from '../store';
import { DEFAULT_FADE_CURVE, type StudioClip } from '../model';

const SR = 48_000;

const base: PlayheadTempo = {
  primary: null,
  others: [],
  pending: false,
  unknown: false,
  idle: true,
};

const entry = (over: Partial<NonNullable<PlayheadTempo['primary']>> = {}) => ({
  laneId: 'l1',
  laneName: 'Lane 1',
  clipId: 'c1',
  bpm: 128,
  sourceBpm: 128,
  confidence: 0.6,
  speedFactor: 1,
  ...over,
});

describe('nota BPM', () => {
  it('menyebut analisis yang sedang berjalan', () => {
    expect(tempoNote({ ...base, idle: false, pending: true })).toBe('MENGANALISIS…');
  });

  it('membedakan materi tanpa ketukan dari playhead kosong', () => {
    expect(tempoNote({ ...base, idle: false, unknown: true })).toBe('TANPA KETUKAN JELAS');
    expect(tempoNote(base)).toBeUndefined();
  });

  it('melaporkan selisih ke lane lain — itu yang dipakai beatmatch', () => {
    const t: PlayheadTempo = {
      ...base,
      idle: false,
      primary: entry(),
      others: [entry({ laneId: 'l2', laneName: 'Lane 2', bpm: 124.5 })],
    };
    expect(tempoNote(t)).toBe('LANE 2 −3.5');
  });

  it('menyatakan seirama saat dua lane sudah sama', () => {
    const t: PlayheadTempo = {
      ...base,
      idle: false,
      primary: entry(),
      others: [entry({ laneId: 'l2', laneName: 'Lane 2', bpm: 128.01 })],
    };
    expect(tempoNote(t)).toBe('SEIRAMA · 2 LANE');
  });

  it('menampilkan BPM sumber saat kecepatan bukan 1×', () => {
    const t: PlayheadTempo = {
      ...base,
      idle: false,
      primary: entry({ bpm: 134.4, sourceBpm: 128, speedFactor: 1.05 }),
    };
    expect(tempoNote(t)).toBe('SUMBER 128.0');
  });

  it('menandai keyakinan rendah', () => {
    const t: PlayheadTempo = {
      ...base,
      idle: false,
      primary: entry({ confidence: 0.05 }),
    };
    expect(tempoNote(t)).toBe('TIDAK YAKIN');
  });
});

function asset(id: number, bpm: number, confidence: number): StudioAsset {
  return {
    id,
    name: `a${id}`,
    envelope: { levels: [], frames: 0 } as unknown as StudioAsset['envelope'],
    frames: 60 * SR,
    sampleRate: SR,
    tempo: { bpm, confidence, beatOffsetSec: 0 },
    tempoPending: false,
    tempoOctave: 0,
    bpmOverride: null,
    beatOffsetOverride: null,
  };
}

function clip(id: string, assetId: number): StudioClip {
  return {
    id,
    assetId,
    start: 0,
    len: 30 * SR,
    sourceStart: 0,
    sourceLen: 30 * SR,
    label: id,
    gainDb: 0,
    fadeInMs: 0,
    fadeOutMs: 0,
    fadeCurve: DEFAULT_FADE_CURVE,
    seed: 1,
    chain: [],
  };
}

describe('sel BPM', () => {
  beforeEach(() => {
    studioActions.__resetForTest();
    for (const lane of studioStore.getState().lanes) {
      for (const c of lane.clips) studioActions.removeClip(c.id);
    }
  });
  afterEach(cleanup);

  it('menampilkan strip kosong sebagai — tanpa tombol oktaf', () => {
    render(<BpmCell />);
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.queryByText('×2')).toBeNull();
  });

  it('menampilkan BPM dan tombol oktaf saat ada clip aktif', () => {
    const laneId = studioStore.getState().lanes[0]!.id;
    studioActions.registerAsset(asset(7, 128, 0.6));
    studioActions.addClip(laneId, clip('c1', 7));
    studioActions.setPlayhead(5 * SR);

    render(<BpmCell />);
    expect(screen.getByText('128.0')).toBeTruthy();
    expect(screen.getByText('×2')).toBeTruthy();
  });

  /**
   * Tinggi sel tidak boleh bergantung pada isinya. Baris nota BpmCell
   * muncul-hilang tiap kali playhead melewati sambungan clip, dan strip ini
   * baris `auto` di grid halaman — kalau nodenya ikut hilang, seluruh timeline
   * di bawahnya naik-turun mengikuti kursor saat scrub.
   */
  it('baris nota tetap ada walau tidak ada yang perlu dikatakan', () => {
    const { container } = render(<BpmCell />);
    const cellEl = container.firstElementChild as HTMLElement;
    expect(cellEl.children).toHaveLength(3); // label, nilai, nota
    expect(cellEl.children[2]?.textContent).toBe('');
  });

  it('menandai angka yang tidak diyakini dengan "?"', () => {
    const laneId = studioStore.getState().lanes[0]!.id;
    studioActions.registerAsset(asset(8, 96, 0.04));
    studioActions.addClip(laneId, clip('c1', 8));
    studioActions.setPlayhead(5 * SR);

    render(<BpmCell />);
    expect(screen.getByText('96.0?')).toBeTruthy();
  });
});
