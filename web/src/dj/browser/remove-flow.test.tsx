import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../studio/persist/db', () => ({
  deleteAsset: () => Promise.resolve(true),
  loadAllAssets: () => Promise.resolve([]),
  loadDjSession: () => Promise.resolve(null),
  saveDjSession: () => Promise.resolve(true),
  saveProjectJson: () => Promise.resolve(true),
  loadProjectJson: () => Promise.resolve(null),
  saveAsset: () => Promise.resolve(true),
  pruneAssets: () => Promise.resolve(),
  isPersistenceAvailable: () => false,
}));

import { CollectionBrowser } from './CollectionBrowser';
import { djActions, djStore } from '../store';
import { studioActions, studioStore, type StudioAsset } from '../../studio/store';
import { buildEnvelope } from '../../studio/timeline/envelope';

const SR = 48_000;
const FRAMES = SR * 4;
const asset = (id: number): StudioAsset =>
  ({
    id, name: `LAGU ${id}`,
    envelope: buildEnvelope({ numberOfChannels: 1, length: FRAMES, getChannelData: () => new Float32Array(FRAMES) }),
    frames: FRAMES, sampleRate: SR, tempo: null, tempoPending: false,
    tempoOctave: 0, bpmOverride: null, beatOffsetOverride: null,
  }) as unknown as StudioAsset;

beforeEach(() => {
  cleanup();
  djActions.__resetForTest();
  studioActions.__resetForTest?.();
  act(() => studioActions.registerAsset(asset(5)));
});

describe('alur hapus dari UI', () => {
  it('dua klik benar-benar menghapus asetnya', async () => {
    render(<CollectionBrowser />);
    const btn = () => screen.getByTitle(/hapus "LAGU 5"/);

    fireEvent.click(btn());
    expect(btn().textContent).toBe('HAPUS?');

    await act(async () => {
      fireEvent.click(btn());
      await Promise.resolve();
    });

    // eslint-disable-next-line no-console
    console.log('assets=', Object.keys(studioStore.getState().assets), 'notice=', djStore.getState().notice);
    expect(studioStore.getState().assets[5]).toBeUndefined();
  });
});
