/**
 * Tahap job pemisahan vokal di bar progres lane (docs/26 §3a): `model`,
 * `separating`, `assembling` harus punya nama di layar. Tanpa entri di
 * `STAGE_LABEL`, tahapnya tampil kosong — bar yang tidak bilang sedang apa
 * adalah persis yang dihindari overlay ini.
 */

import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { ImportJob } from '../store';
import { LaneImportOverlay } from './LaneImportOverlay';

afterEach(cleanup);

const job = (id: string, stage: ImportJob['stage'], ratio: number | null): ImportJob => ({
  id,
  laneId: 'l1',
  name: 'lagu.wav',
  stage,
  ratio,
});

describe('LaneImportOverlay — tahap pemisahan vokal', () => {
  it.each([
    ['model', 'MODEL'],
    ['separating', 'PISAH'],
    ['assembling', 'SUSUN'],
  ] as const)('tahap %s tampil sebagai %s', (stage, label) => {
    render(<LaneImportOverlay jobs={[job('j1', stage, 0.5)]} />);
    const row = document.querySelector('[data-import-job="j1"]');
    expect(row).not.toBeNull();
    expect(row!.textContent).toContain(label);
    expect(row!.textContent).toContain('50%');
    expect(row!.getAttribute('aria-valuetext')).toBe(`${label} 50%`);
  });

  it('inferensi tanpa rasio tidak memajang persen palsu', () => {
    render(<LaneImportOverlay jobs={[job('j1', 'separating', null)]} />);
    const row = document.querySelector('[data-import-job="j1"]')!;
    expect(row.textContent).toContain('PISAH');
    expect(row.textContent).not.toMatch(/\d+%/);
  });
});
