/**
 * CAKUPAN suntingan grid — kontrol #7 rekordbox (`[Normal]` vs `[Dynamic]`).
 *
 * Yang dijaga di sini adalah satu janji yang tidak bisa dilihat dari kode, dan
 * yang seluruh fitur ini ada untuk memenuhinya:
 *
 *   memperbaiki grid di reff TIDAK BOLEH merusak intro.
 *
 * Plus tiga akibat yang menentukan apakah janji itu bisa dipakai orang:
 * menyunting berulang kali di satu tempat tidak menumpuk ruas, ruas bisa
 * DIBUANG lagi, dan undo mengembalikan lagunya utuh — termasuk ruasnya.
 */

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DjPage } from '../DjPage';
import { djActions, djStore } from '../store';
import { studioActions, studioStore, type StudioAsset } from '../../studio/store';
import { buildEnvelope } from '../../studio/timeline/envelope';
import { resolveBeatGridAt } from '../../studio/analysis/beat-grid';
import { __resetGridHistoryForTest } from './grid-history';
import {
  autoGrid,
  octaveGrid,
  removeSegmentHere,
  setGridBpm,
  toggleGridEditFor,
  undoGridEdit,
} from './grid-ops';

const SR = 48_000;
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

const FRAMES = SR * 8;
const pcm = {
  numberOfChannels: 1,
  length: FRAMES,
  getChannelData: () => {
    const out = new Float32Array(FRAMES);
    for (let i = 0; i < FRAMES; i += 1) out[i] = Math.sin(i / 40) * 0.5;
    return out;
  },
};

const TRACK_FRAMES = SR * 300;

const fakeAsset = (): StudioAsset =>
  ({
    id: 1,
    name: 'LAGU 1',
    envelope: buildEnvelope(pcm),
    frames: TRACK_FRAMES,
    sampleRate: SR,
    tempo: { bpm: 120, confidence: 0.9, beatOffsetSec: 0 },
    tempoPending: false,
    tempoOctave: 0,
    bpmOverride: null,
    beatOffsetOverride: null,
    analysisLock: false,
  }) as unknown as StudioAsset;

beforeEach(() => {
  Element.prototype.getBoundingClientRect = () => RECT as DOMRect;
  djActions.__resetForTest();
  studioActions.__resetForTest?.();
  __resetGridHistoryForTest();
  studioActions.registerAsset(fakeAsset());
  djActions.loadDeck('A', { assetId: 1, frames: TRACK_FRAMES, name: 'LAGU 1', sampleRate: SR });
});

afterEach(cleanup);

const run = (fn: () => void): void => {
  act(() => {
    fn();
  });
};

const asset = (): StudioAsset => studioStore.getState().assets[1] as StudioAsset;
const bpmAt = (sec: number): number => resolveBeatGridAt(asset(), sec)!.bpm;
const anchors = (): readonly { atSec: number; bpm: number }[] => asset().beatAnchors ?? [];

/** Buka panel di deck A, taruh playhead di `sec`, pilih cakupan "dari sini". */
function editFrom(sec: number): void {
  render(<DjPage />);
  run(() => toggleGridEditFor('A'));
  run(() => djActions.seek('A', Math.round(sec * SR)));
  run(() => djActions.setGridScope('here'));
}

describe('cakupan DARI SINI', () => {
  it('memperbaiki BPM di menit kedua TIDAK menyentuh menit pertama', () => {
    editFrom(120);
    run(() => setGridBpm(96, 'A'));

    expect(bpmAt(10)).toBe(120);
    expect(bpmAt(200)).toBe(96);
  });

  it('ruas baru mulai di GARIS BAR, bukan di playhead persis', () => {
    // Kesinambungan fase: ruas yang berangkat dari tengah ketukan meninggalkan
    // setengah ketukan menganga di batasnya, dan itu terdengar.
    editFrom(100.37);
    run(() => setGridBpm(96, 'A'));

    const at = anchors()[0]!.atSec;
    const barSec = (60 / 120) * 4; // grid dasar 120 BPM, 4/4
    expect(Math.abs(at / barSec - Math.round(at / barSec))).toBeLessThan(1e-9);
  });

  it('menyunting berulang di ruas yang sama TIDAK menumpuk ruas', () => {
    editFrom(120);
    run(() => setGridBpm(96, 'A'));
    run(() => octaveGrid(1, 'A'));
    run(() => octaveGrid(-1, 'A'));

    expect(anchors()).toHaveLength(1);
    expect(bpmAt(200)).toBe(96);
  });

  it('cakupan SELURUH LAGU tetap menulis grid dasar, bukan ruas', () => {
    editFrom(120);
    run(() => djActions.setGridScope('track'));
    run(() => setGridBpm(96, 'A'));

    expect(anchors()).toHaveLength(0);
    expect(bpmAt(10)).toBe(96);
    expect(bpmAt(200)).toBe(96);
  });

  it('HAPUS RUAS mengembalikan bagian itu ke grid dasar', () => {
    editFrom(120);
    run(() => setGridBpm(96, 'A'));
    expect(bpmAt(200)).toBe(96);

    run(() => removeSegmentHere('A'));
    expect(anchors()).toHaveLength(0);
    expect(bpmAt(200)).toBe(120);
  });

  it('HAPUS RUAS di tempat yang tidak punya ruas menolak dengan kalimat', () => {
    editFrom(120);
    const ok = removeSegmentHere('A');
    expect(ok).toBe(false);
    expect(djStore.getState().notice).toMatch(/tidak ada ruas/);
  });

  it('UNDO mengembalikan ruasnya, bukan hanya angkanya', () => {
    editFrom(120);
    run(() => setGridBpm(96, 'A'));
    expect(anchors()).toHaveLength(1);

    run(() => undoGridEdit('A'));
    expect(anchors()).toHaveLength(0);
    expect(bpmAt(200)).toBe(120);
  });

  it('AUTO membuang ruas juga — kalau tidak, tombolnya berbohong', () => {
    editFrom(120);
    run(() => setGridBpm(96, 'A'));
    run(() => autoGrid('A'));

    expect(anchors()).toHaveLength(0);
    expect(bpmAt(200)).toBe(120);
  });

  it('deck membaca grid DI POSISI PLAYHEAD, bukan di awal lagu', () => {
    // Ini yang membuat quantize, loop, SYNC, dan metronom ikut pindah ruas
    // tanpa satu pun dari mereka tahu tentang ruas.
    editFrom(120);
    run(() => setGridBpm(96, 'A'));

    run(() => djActions.seek('A', Math.round(10 * SR)));
    expect(djStore.getState().decks.A.playhead).toBe(Math.round(10 * SR));
    expect(bpmAt(djStore.getState().decks.A.playhead / SR)).toBe(120);

    run(() => djActions.seek('A', Math.round(200 * SR)));
    expect(bpmAt(djStore.getState().decks.A.playhead / SR)).toBe(96);
  });
});
