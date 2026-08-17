/**
 * Smoke test Audio Studio: render App dan tiap panel di jsdom, lalu jalankan
 * aksi store yang dipakai UI. Tujuannya menangkap kelas bug yang membunuh UI
 * sebelum sempat dilihat: getSnapshot yang tidak stabil (loop render), NaN dari
 * pembagian nol, dan crash saat elemen belum di-layout (ukuran 0).
 */

import { cleanup, render, screen } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { DEFAULT_FADE_CURVE, findClip, samplesToSec } from '../model';
import { studioActions, studioStore } from '../store';
import { ClipDetailPanel, LaneHeaders, OverviewStrip, TimelinePanel } from '../timeline';
import { ReadoutStrip, StudioHeader } from '../shell';

const RECT = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 900,
  bottom: 300,
  width: 900,
  height: 300,
  toJSON: () => ({}),
};

beforeEach(() => {
  Element.prototype.getBoundingClientRect = () => RECT as DOMRect;
  studioActions.__resetForTest();
});
afterEach(cleanup);

function expectNoConsoleError(fn: () => void): void {
  const errors: unknown[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...a) => errors.push(a));
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  expect(errors, `console.error: ${JSON.stringify(errors)}`).toEqual([]);
}

describe('App', () => {
  it('render tanpa engine', () => {
    expectNoConsoleError(() => {
      render(<App />);
    });
    expect(screen.getByText('AUDIO STUDIO')).toBeTruthy();
    expect(screen.getByText(/TIMELINE MIX/)).toBeTruthy();
    expect(screen.getAllByText('DROP AUDIO DI SINI').length).toBeGreaterThan(0);
  });

  it('render dengan createEngine yang gagal', () => {
    expectNoConsoleError(() => {
      render(
        <App
          createEngine={async () => {
            throw new Error('wasm belum dibuild');
          }}
        />,
      );
    });
  });

  it('playhead maju saat playing (tanpa engine)', () => {
    vi.useFakeTimers();
    try {
      render(<App />);
      const before = studioStore.getState().playhead;
      act(() => {
        studioActions.setPlaying(true);
      });
      act(() => {
        vi.advanceTimersByTime(600);
      });
      expect(studioStore.getState().playhead).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('panel sendiri-sendiri', () => {
  const panels: [string, () => JSX.Element][] = [
    ['StudioHeader', () => <StudioHeader />],
    ['ReadoutStrip', ReadoutStrip],
    ['TimelinePanel', TimelinePanel],
    ['ClipDetailPanel', ClipDetailPanel],
    ['LaneHeaders', LaneHeaders],
    ['OverviewStrip', () => <OverviewStrip viewLeftPct={0} viewWidthPct={100} />],
  ];

  for (const [name, Panel] of panels) {
    it(`${name} mount sendirian`, () => {
      expectNoConsoleError(() => {
        render(<Panel />);
      });
    });
  }

  it('tidak crash saat elemen berukuran 0 (belum di-layout)', () => {
    const zero = { ...RECT, width: 0, height: 0, right: 0, bottom: 0 };
    Element.prototype.getBoundingClientRect = () => zero as DOMRect;
    for (const [name, Panel] of panels) {
      expect(() => render(<Panel />), name).not.toThrow();
      cleanup();
    }
    expect(document.body.innerHTML).not.toContain('NaN');
  });
});

describe('aksi store', () => {
  it('tambah lane, ganti nama, mute/solo, hapus', () => {
    render(<TimelinePanel />);
    const before = studioStore.getState().lanes.length;
    act(() => studioActions.addLane());
    const added = studioStore.getState().lanes.at(-1);
    expect(studioStore.getState().lanes.length).toBe(before + 1);
    expect(added).toBeDefined();

    act(() => studioActions.renameLane(added!.id, 'DRUMS'));
    expect(studioStore.getState().lanes.at(-1)?.name).toBe('DRUMS');

    act(() => studioActions.toggleMute(added!.id));
    act(() => studioActions.toggleSolo(added!.id));
    expect(studioStore.getState().lanes.at(-1)?.mute).toBe(true);
    expect(studioStore.getState().lanes.at(-1)?.solo).toBe(true);

    act(() => studioActions.removeLane(added!.id));
    expect(studioStore.getState().lanes.length).toBe(before);
  });

  it('moveClip memindahkan clip antar lane dan menjepit start', () => {
    act(() => studioActions.moveClip('c2', -5_000_000, 0));
    const hit = findClip(studioStore.getState().lanes, 'c2');
    expect(hit).not.toBeNull();
    expect(hit!.lane.id).toBe('l1');
    expect(hit!.clip.start).toBe(0);

    const s = studioStore.getState();
    act(() => studioActions.moveClip('c2', s.duration * 10, 99));
    const after = findClip(studioStore.getState().lanes, 'c2');
    expect(after!.clip.start).toBeLessThanOrEqual(
      studioStore.getState().duration - after!.clip.len,
    );
    expect(Number.isNaN(after!.clip.start)).toBe(false);
  });

  it('split di playhead membelah clip terpilih', () => {
    const s = studioStore.getState();
    const clip = findClip(s.lanes, 'c1')!.clip;
    act(() => studioActions.setPlayhead(clip.start + Math.floor(clip.len / 2)));
    act(() => studioActions.splitClipAtPlayhead('c1'));
    const lane = studioStore.getState().lanes.find((l) => l.id === 'l1')!;
    expect(lane.clips.length).toBe(2);
    expect(lane.clips[0]!.len + lane.clips[1]!.len).toBe(clip.len);
  });

  it('menghapus lane membersihkan seleksi clip', () => {
    act(() => studioActions.selectClip('c1', 'l1'));
    act(() => studioActions.removeLane('l1'));
    expect(studioStore.getState().selectedClipId).toBeNull();
  });

  it('zoom dijepit dan FIT memakai null', () => {
    act(() => studioActions.setZoom(100_000));
    expect(studioStore.getState().pxPerSecond).toBe(400);
    act(() => studioActions.setZoom(Number.NaN));
    expect(studioStore.getState().pxPerSecond).toBeNull();
    act(() => studioActions.setZoom(0.0001));
    expect(studioStore.getState().pxPerSecond).toBe(2);
  });

  it('durasi minimal 2 menit dan tumbuh mengikuti clip terjauh', () => {
    const s = studioStore.getState();
    expect(samplesToSec(s.duration, s.sampleRate)).toBeGreaterThanOrEqual(120);
    act(() =>
      studioActions.addClip('l4', {
        id: 'x1',
        assetId: 0,
        start: s.sampleRate * 200,
        len: s.sampleRate * 10,
        sourceStart: 0,
        sourceLen: s.sampleRate * 10,
        label: 'JAUH.WAV',
        gainDb: 0,
        fadeInMs: 0,
        fadeOutMs: 0,
        fadeCurve: DEFAULT_FADE_CURVE,
        seed: 1,
      }),
    );
    const after = studioStore.getState();
    expect(samplesToSec(after.duration, after.sampleRate)).toBeGreaterThanOrEqual(210);
  });
});


