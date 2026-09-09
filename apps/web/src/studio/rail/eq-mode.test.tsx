import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { studioActions, studioStore } from '../store';
import { StudioRail } from './index';

function selectFirstLane(): string {
  const id = studioStore.getState().lanes[0]!.id;
  studioActions.selectLane(id);
  return id;
}

describe('mode EQ', () => {
  beforeEach(() => {
    studioActions.__resetForTest();
    studioActions.setTab('eq');
  });

  it('default-nya kurva, dan bisa ditukar ke slider', () => {
    selectFirstLane();
    render(<StudioRail />);
    expect(studioStore.getState().eqMode).toBe('curve');
    expect(screen.getByLabelText('Kurva EQ parametrik')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'SLIDER' }));

    expect(studioStore.getState().eqMode).toBe('sliders');
    expect(screen.queryByLabelText('Kurva EQ parametrik')).toBeNull();
    expect(screen.getByRole('slider', { name: 'LOW gain' })).toBeTruthy();
  });

  it('BERGANTI MODE TIDAK MENGUBAH SUARA — EqSettings identik', () => {
    const laneId = selectFirstLane();
    studioActions.setLaneEqBand(laneId, 'mid', { gainDb: 5.5, freq: 900 });
    const before = JSON.stringify(studioStore.getState().lanes.find((l) => l.id === laneId)!.eq);

    render(<StudioRail />);
    fireEvent.click(screen.getByRole('button', { name: 'SLIDER' }));
    fireEvent.click(screen.getByRole('button', { name: 'CURVE' }));

    const after = JSON.stringify(studioStore.getState().lanes.find((l) => l.id === laneId)!.eq);
    expect(after).toBe(before);
  });

  it('slider mengedit band yang sama dengan kurva', () => {
    const laneId = selectFirstLane();
    studioActions.setEqMode('sliders');
    render(<StudioRail />);

    const low = screen.getByRole('slider', { name: 'LOW gain' });
    fireEvent.keyDown(low, { key: 'ArrowRight' });

    const band = studioStore
      .getState()
      .lanes.find((l) => l.id === laneId)!
      .eq.bands.find((b) => b.id === 'low')!;
    expect(band.gainDb).toBe(0.5);
    // Frekuensi TIDAK ikut berubah di mode slider — itu bedanya dengan kurva.
    expect(band.freq).toBe(90);
  });
});
