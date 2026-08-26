import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { studioActions, studioStore } from '../store';
import { LaneHeaders } from './LaneHeaders';

beforeEach(() => studioActions.__resetForTest());
afterEach(cleanup);

describe('popup speed lane', () => {
  it('button membuka popup dengan input manual dan slider', () => {
    render(<LaneHeaders />);
    const lane = studioStore.getState().lanes[0]!;
    fireEvent.click(screen.getByRole('button', { name: `kecepatan lane ${lane.name}` }));

    expect(screen.getByRole('dialog', { name: `atur kecepatan ${lane.name}` })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: `speed manual ${lane.name}` })).toBeTruthy();
    expect(screen.getByRole('slider', { name: `slider speed ${lane.name}` })).toBeTruthy();
  });

  it('Enter pada input menerapkan speed manual', () => {
    render(<LaneHeaders />);
    const lane = studioStore.getState().lanes[0]!;
    fireEvent.click(screen.getByRole('button', { name: `kecepatan lane ${lane.name}` }));
    const input = screen.getByRole('textbox', { name: `speed manual ${lane.name}` });
    fireEvent.change(input, { target: { value: '1.37' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(studioStore.getState().lanes[0]!.speedRatio).toBe(1.37);
    expect(screen.getByRole('button', { name: `kecepatan lane ${lane.name}` }).textContent).toBe('1.37x');
  });

  it('slider menerapkan speed secara langsung', () => {
    render(<LaneHeaders />);
    const lane = studioStore.getState().lanes[0]!;
    fireEvent.click(screen.getByRole('button', { name: `kecepatan lane ${lane.name}` }));
    fireEvent.change(screen.getByRole('slider', { name: `slider speed ${lane.name}` }), {
      target: { value: '1.5' },
    });
    expect(studioStore.getState().lanes[0]!.speedRatio).toBe(1.5);
  });
});
