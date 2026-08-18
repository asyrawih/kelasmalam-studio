/**
 * Panel FX — yang diuji bukan tampilannya, tapi klaim intinya: panel ini
 * dirakit SEPENUHNYA dari katalog, tanpa satu pun nama efek atau parameter
 * yang ditulis di kodenya.
 *
 * Karena itu katalognya di-mock dengan efek yang TIDAK ADA di engine
 * ("testfx", parameter "cutoff"/"mode"). Kalau panel diam-diam mengandung
 * pengetahuan tentang efek nyata, efek karangan ini tidak akan ter-render —
 * dan itulah yang membuat tes ini bermakna.
 */

import { act } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { EffectDesc } from '../../audio/fx-catalog';

const TESTFX: EffectDesc = {
  kind: 0,
  id: 'testfx',
  name: 'TESTFX',
  category: 'filter',
  params: [
    {
      id: 'cutoff',
      name: 'CUTOFF',
      unit: 'hz',
      min: 20,
      max: 20_000,
      default: 1_000,
      taper: { kind: 'log' },
      smoothing: { kind: 'block' },
      flags: 0,
      choices: [],
    },
    {
      id: 'mode',
      name: 'MODE',
      unit: 'choice',
      min: 0,
      max: 1,
      default: 0,
      taper: { kind: 'stepped', k: 2 },
      smoothing: { kind: 'stepped' },
      flags: 0,
      choices: ['LP', 'HP'],
    },
  ],
  summary: [0],
  maxTailMs: 0,
  latencyFrames: 0,
};

vi.mock('../preview/fx-node', () => ({
  ensureFxRuntime: () => Promise.resolve(true),
  fxCatalog: () => new Map([['testfx', TESTFX]]),
  fxPreviewStatus: () => ({ ready: true, error: null }),
  registerFxWorklet: () => Promise.resolve(true),
  createFxNode: () => null,
  pushFxParams: () => undefined,
  chainShape: () => '',
}));

const { studioActions, studioStore } = await import('../store');
const { FxCard } = await import('./FxCard');

function laneChain(): ReturnType<typeof studioStore.getState>['lanes'][number]['chain'] {
  const id = studioStore.getState().selectedLaneId;
  const lanes = studioStore.getState().lanes;
  return (lanes.find((l) => l.id === id) ?? lanes[0]!).chain;
}

describe('panel FX', () => {
  beforeEach(() => {
    studioActions.__resetForTest();
    studioActions.selectLane(studioStore.getState().lanes[0]!.id);
  });

  it('menawarkan efek dari katalog, bukan dari daftar yang ditulis di UI', () => {
    render(<FxCard />);
    const picker = screen.getByLabelText('Tambah efek');
    expect(screen.getByRole('option', { name: 'TESTFX' })).toBeTruthy();

    fireEvent.change(picker, { target: { value: 'testfx' } });
    expect(laneChain()).toHaveLength(1);
    expect(laneChain()[0]!.kind).toBe('testfx');
  });

  it('merender satu kontrol per parameter, lengkap dengan rentang deskriptornya', () => {
    render(<FxCard />);
    fireEvent.change(screen.getByLabelText('Tambah efek'), { target: { value: 'testfx' } });

    const cutoff = screen.getByRole('slider', { name: 'CUTOFF' });
    expect(cutoff.getAttribute('aria-valuemin')).toBe('20');
    expect(cutoff.getAttribute('aria-valuemax')).toBe('20000');
    expect(cutoff.getAttribute('aria-valuenow')).toBe('1000');
    // Satuan diformat dari deskriptor, bukan ditebak.
    expect(cutoff.getAttribute('aria-valuetext')).toBe('1.00 kHz');
    expect(screen.getByRole('slider', { name: 'MODE' })).toBeTruthy();
  });

  /// Taper hidup di deskriptor: satu langkah keyboard di 1 kHz harus bergerak
  /// secara PROPORSIONAL, bukan menambah beberapa hertz.
  it('menggerakkan parameter mengikuti taper-nya', () => {
    render(<FxCard />);
    fireEvent.change(screen.getByLabelText('Tambah efek'), { target: { value: 'testfx' } });
    fireEvent.keyDown(screen.getByRole('slider', { name: 'CUTOFF' }), { key: 'ArrowRight' });

    const v = laneChain()[0]!.params['cutoff']!;
    expect(v).toBeGreaterThan(1_000);
    expect(v).toBeGreaterThan(1_200);
  });

  it('bypass dan hapus bekerja pada slot yang benar', () => {
    render(<FxCard />);
    const picker = screen.getByLabelText('Tambah efek');
    fireEvent.change(picker, { target: { value: 'testfx' } });
    fireEvent.change(picker, { target: { value: 'testfx' } });
    expect(laneChain()).toHaveLength(2);

    fireEvent.click(screen.getAllByRole('button', { name: 'Bypass efek' })[1]!);
    expect(laneChain()[0]!.enabled).toBe(true);
    expect(laneChain()[1]!.enabled).toBe(false);

    fireEvent.click(screen.getAllByRole('button', { name: 'Hapus' })[0]!);
    expect(laneChain()).toHaveLength(1);
    expect(laneChain()[0]!.enabled).toBe(false);
  });

  it('urutan efek bisa diubah — dan urutan mengubah suara', () => {
    render(<FxCard />);
    const picker = screen.getByLabelText('Tambah efek');
    fireEvent.change(picker, { target: { value: 'testfx' } });
    fireEvent.change(picker, { target: { value: 'testfx' } });
    // Lewat `act`: memanggil aksi store langsung memicu render ulang di luar
    // fireEvent, dan React melaporkannya lewat console.error — yang justru
    // digagalkan smoke test studio.
    act(() => {
      studioActions.setFxParam(studioStore.getState().lanes[0]!.id, 1, 'cutoff', 4_000);
    });

    fireEvent.click(screen.getAllByRole('button', { name: 'Naikkan' })[1]!);
    expect(laneChain()[0]!.params['cutoff']).toBe(4_000);
  });

  it('MASTER punya chain sendiri, terpisah dari lane', () => {
    render(<FxCard />);
    fireEvent.click(screen.getByRole('button', { name: 'MASTER' }));
    fireEvent.change(screen.getByLabelText('Tambah efek'), { target: { value: 'testfx' } });

    expect(studioStore.getState().masterChain).toHaveLength(1);
    expect(laneChain()).toHaveLength(0);
  });
});
