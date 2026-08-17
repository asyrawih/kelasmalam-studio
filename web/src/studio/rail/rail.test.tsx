/**
 * Smoke test rail: render di ketiga tab tanpa melempar, plus cek matematika
 * taper fader dan statistik compile.
 *
 * Konfigurasi vitest/jsdom sudah ada (`web/vitest.config.ts`).
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { StudioRail } from './index';
import { dbToFader, faderToDb, formatDb } from './fader';
import { computeStats } from './CompileCard';
import { studioActions, studioStore } from './store-adapter';
import { defaultEq, DEFAULT_FADE_CURVE, type StudioState } from '../model';

// jsdom melaporkan semua elemen berukuran 0; beri ukuran realistis supaya
// jalur perhitungan fraksi drag benar-benar dieksekusi.
const RECT = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 200,
  bottom: 8,
  width: 200,
  height: 8,
  toJSON: () => ({}),
};
Element.prototype.getBoundingClientRect = () => RECT as DOMRect;

// jsdom belum mengimplementasikan Pointer Capture; `useDrag` memakainya.
// Tanpa stub ini pointerdown melempar dan seluruh jalur drag tidak pernah diuji.
const captured = new Set<number>();
Element.prototype.setPointerCapture = function (id: number) {
  captured.add(id);
};
Element.prototype.releasePointerCapture = function (id: number) {
  captured.delete(id);
};
Element.prototype.hasPointerCapture = function (id: number) {
  return captured.has(id);
};

afterEach(() => {
  cleanup();
  studioActions.__resetForTest();
});

describe('StudioRail', () => {
  for (const tab of ['mix', 'eq', 'compile'] as const) {
    it(`render tanpa melempar di tab ${tab}`, () => {
      studioActions.setTab(tab);
      const { container } = render(<StudioRail />);
      expect(container.firstChild).toBeTruthy();
      expect(screen.getByText('Transport')).toBeTruthy();
    });
  }

  it('tab bar mengganti panel', () => {
    studioActions.setTab('mix');
    render(<StudioRail />);
    expect(screen.getByText('Lane Mixer')).toBeTruthy();
    fireEvent.click(screen.getByText('EQ'));
    expect(screen.getByText('Equalizer')).toBeTruthy();
  });

  it('klik fader mengubah gain lane (tidak ada NaN)', () => {
    studioActions.setTab('mix');
    render(<StudioRail />);
    const fader = screen.getAllByRole('slider')[0]!;
    fireEvent.pointerDown(fader, { button: 0, clientX: 100, pointerId: 1 });
    const now = fader.getAttribute('aria-valuenow');
    expect(now).not.toBeNull();
    expect(Number.isNaN(Number(now))).toBe(false);
  });
});

describe('EQ kurva', () => {
  const laneEq = (): ReturnType<typeof defaultEq> => {
    const s = studioStore.getState();
    return s.lanes.find((l) => l.id === s.selectedLaneId)!.eq;
  };

  it('menyeret node mengubah freq DAN gain band terkait di store', () => {
    studioActions.setTab('eq');
    studioActions.selectLane(studioStore.getState().lanes[0]!.id);
    const { container } = render(<StudioRail />);
    const surface = container.querySelector('[aria-label="Kurva EQ parametrik"]')!;

    // RECT = 200×8. Node LOW ada di x = logX(90)*200 ≈ 34, y = 4 (0 dB).
    const before = laneEq().bands[0]!;
    fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 34, clientY: 4 });
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 100, clientY: 1 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 100, clientY: 1 });

    const after = laneEq().bands[0]!;
    expect(after.id).toBe('low');
    expect(Number.isNaN(after.freq)).toBe(false);
    expect(Number.isNaN(after.gainDb)).toBe(false);
    expect(after.freq).toBeGreaterThan(before.freq); // digeser ke kanan
    expect(after.gainDb).toBeGreaterThan(0); // digeser ke atas
    // Band lain tidak ikut bergerak.
    expect(laneEq().bands[1]!.gainDb).toBe(0);
  });

  it('klik jauh dari node tidak mengubah apa pun', () => {
    studioActions.setTab('eq');
    studioActions.selectLane(studioStore.getState().lanes[0]!.id);
    const { container } = render(<StudioRail />);
    const surface = container.querySelector('[aria-label="Kurva EQ parametrik"]')!;
    fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 199, clientY: 8 });
    expect(laneEq().bands.every((b) => b.gainDb === 0)).toBe(true);
  });

  it('preset diterapkan ke lane terpilih', () => {
    studioActions.setTab('eq');
    studioActions.selectLane(studioStore.getState().lanes[0]!.id);
    render(<StudioRail />);
    fireEvent.click(screen.getByText('CLUB'));
    expect(studioStore.getState().preset).toBe('CLUB');
    expect(laneEq().bands.find((b) => b.id === 'low')!.gainDb).toBeGreaterThan(0);

    fireEvent.click(screen.getByText('FLAT'));
    expect(laneEq().bands.every((b) => b.gainDb === 0)).toBe(true);
  });
});

describe('taper fader', () => {
  it('unity tepat di 75% travel', () => {
    expect(faderToDb(0.75)).toBeCloseTo(0, 6);
    expect(dbToFader(0)).toBeCloseTo(0.75, 6);
  });

  it('dbToFader adalah inverse faderToDb', () => {
    for (const t of [0.1, 0.3, 0.55, 0.8, 1]) {
      expect(dbToFader(faderToDb(t))).toBeCloseTo(t, 5);
    }
  });

  it('travel 0 = senyap', () => {
    expect(formatDb(faderToDb(0))).toBe('-inf');
  });
});

describe('computeStats', () => {
  const base: StudioState = {
    projectName: 'X',
    sampleRate: 48_000,
    duration: 48_000 * 120,
    lanes: [
      {
        id: 'a',
        name: 'A',
        color: '#ffd400',
        mute: false,
        solo: false,
        gainDb: 0,
        speedRatio: 1,
        eq: defaultEq(),
        clips: [
          {
            id: 'c',
            assetId: 0,
            start: 0,
            len: 48_000 * 120,
            sourceStart: 0,
            sourceLen: 48_000,
            label: 'C',
            gainDb: 0,
            fadeInMs: 0,
            fadeOutMs: 0,
            fadeCurve: DEFAULT_FADE_CURVE,
            seed: 1,
          },
        ],
      },
    ],
    playing: false,
    playhead: 0,
    speed: 1,
    selectedLaneId: 'a',
    selectedClipId: null,
    pxPerSecond: null,
    tab: 'compile',
    format: 'WAV',
    preset: 'FLAT',
    exportProgress: null,
  };

  it('WAV 16-bit stereo 120 s ≈ 22 MB', () => {
    const s = computeStats(base);
    expect(s.activeLanes).toBe(1);
    expect(s.outputSeconds).toBeCloseTo(120, 3);
    expect(s.bytes / (1024 * 1024)).toBeCloseTo(21.97, 1);
  });

  it('MP3 memakai bitrate, bukan bytes-per-sample', () => {
    const s = computeStats({ ...base, format: 'MP3' });
    expect(s.bytes).toBeCloseTo((120 * 192_000) / 8, 0);
  });

  it('speed 2x memotong panjang output', () => {
    expect(computeStats({ ...base, speed: 2 }).outputSeconds).toBeCloseTo(60, 3);
  });
});
