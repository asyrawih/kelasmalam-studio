import { describe, expect, it } from 'vitest';

import type { StudioClip, StudioLane } from '../model';
import { snapClipMove, SNAP_THRESHOLD_PX } from './clip-snap';

const clip = (id: string, start: number, len: number): StudioClip => ({ id, start, len } as StudioClip);
const lane = { id: 'lane-1', clips: [clip('moving', 0, 100), clip('fixed', 200, 100)] } as StudioLane;

describe('magnetic clip snap', () => {
  it('edge kanan clip menempel ke edge kiri clip berikutnya', () => {
    const out = snapClipMove([lane], [{ id: 'moving', start: 0, laneIndex: 0 }], 93, 0, 1);
    expect(SNAP_THRESHOLD_PX).toBe(10);
    expect(out.deltaSamples).toBe(100);
    expect(out.guideSample).toBe(200);
  });

  it('menahan clip di batas supaya tidak overlap', () => {
    const out = snapClipMove([lane], [{ id: 'moving', start: 0, laneIndex: 0 }], 150, 0, 1);
    expect(out.deltaSamples).toBe(100);
    expect(out.guideSample).toBe(200);
  });

  it('di luar threshold tidak ditarik magnet', () => {
    const out = snapClipMove([lane], [{ id: 'moving', start: 0, laneIndex: 0 }], 70, 0, 1);
    expect(out.deltaSamples).toBe(70);
    expect(out.guideSample).toBeNull();
  });
});
