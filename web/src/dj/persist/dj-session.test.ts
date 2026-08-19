/**
 * Sesi DJ: apa yang bertahan setelah refresh, dan apa yang SENGAJA tidak.
 *
 * Yang paling penting dijaga di sini bukan bahwa datanya tersimpan, melainkan
 * bahwa `playing` **tidak** ikut. Memulihkan "sedang berbunyi" membuat audio
 * menyala setelah refresh tanpa user menekan apa pun — di alat DJ itu bukan
 * kejutan kecil, itu suara keras yang tidak diminta.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../studio/persist/db', () => {
  let stored: string | null = null;
  return {
    saveDjSession: (json: string) => {
      stored = json;
      return Promise.resolve(true);
    },
    loadDjSession: () => Promise.resolve(stored),
    __set: (v: string | null) => {
      stored = v;
    },
  };
});

import { loadDjSession, saveDjSession } from '../../studio/persist/db';
import { djActions, djStore } from '../store';
import {
  __resetDjSessionForTest,
  flushDjSession,
  persistedDeckAssetIds,
  restoreDjSession,
  startDjAutosave,
} from './dj-session';

const SR = 48_000;

beforeEach(async () => {
  djActions.__resetForTest();
  __resetDjSessionForTest();
  await saveDjSession('');
});

const persistNow = (): Promise<void> => flushDjSession();

describe('bolak-balik', () => {
  it('cue, tempo, dan posisi mixer bertahan', async () => {
    djActions.loadDeck('A', { assetId: 7, frames: SR * 60, name: 'X', sampleRate: SR });
    djActions.setHotCue('A', 'C', 12_345);
    djActions.setTempoFader('A', 0.4);
    djActions.setCrossfader(0.8);
    djActions.setEqBand('B', 'low', -26);
    await persistNow();

    djActions.__resetForTest();
    expect(djStore.getState().cues).toEqual({});

    const r = await restoreDjSession(() => true);
    expect(r.restored).toBe(true);
    expect(djStore.getState().cues[7]?.hotCues.C?.at).toBe(12_345);
    expect(djStore.getState().decks.A.tempo.fader).toBeCloseTo(0.4, 9);
    expect(djStore.getState().mixer.crossfader).toBeCloseTo(0.8, 9);
    expect(djStore.getState().mixer.channels.B.eq.low).toBe(-26);
  });

  it('TIDAK memulihkan keadaan sedang berbunyi', async () => {
    djActions.loadDeck('A', { assetId: 1, frames: SR * 60, name: 'X', sampleRate: SR });
    djActions.play('A');
    expect(djStore.getState().decks.A.playing).toBe(true);
    await persistNow();

    djActions.__resetForTest();
    await restoreDjSession(() => true);
    expect(djStore.getState().decks.A.playing).toBe(false);
    expect(djStore.getState().decks.A.playhead).toBe(0);
  });

  it('melaporkan lagu yang asetnya sudah tidak ada, bukan diam', async () => {
    djActions.loadDeck('A', { assetId: 99, frames: SR, name: 'HILANG', sampleRate: SR });
    await persistNow();
    djActions.__resetForTest();
    const r = await restoreDjSession(() => false);
    expect(r.missing).toBe(1);
  });

  it('sesi kosong bukan kegagalan', async () => {
    const r = await restoreDjSession(() => true);
    expect(r.restored).toBe(false);
  });

  it('JSON rusak dibuang diam-diam, tidak melempar', async () => {
    await saveDjSession('{bukan json');
    await expect(restoreDjSession(() => true)).resolves.toEqual({ restored: false, missing: 0 });
  });
});

describe('bank hot cue yang cacat', () => {
  it('selalu dinormalkan jadi delapan slot', async () => {
    // Data yang kekurangan slot: `hotCues.F` akan `undefined` kalau tidak
    // dinormalkan, lolos tipe karena dibaca lewat index, lalu meledak saat
    // digambar.
    await saveDjSession(
      JSON.stringify({
        version: 1,
        decks: { A: { assetId: null }, B: { assetId: null } },
        cues: { 3: { hotCues: { A: { at: 10, label: '', color: '#fff' } }, cuePoint: 0, memoryCues: [] } },
      }),
    );
    await restoreDjSession(() => true);
    const bank = djStore.getState().cues[3]?.hotCues;
    expect(bank).toBeDefined();
    expect(Object.keys(bank ?? {})).toHaveLength(8);
    expect(bank?.F).toBeNull();
    expect(bank?.A?.at).toBe(10);
  });
});

describe('akar retensi', () => {
  it('melaporkan lagu di deck sesi TERSIMPAN, bukan hanya sesi berjalan', async () => {
    djActions.loadDeck('A', { assetId: 42, frames: SR, name: 'X', sampleRate: SR });
    await persistNow();
    expect(persistedDeckAssetIds()).toContain(42);
  });
});

describe('penyimpanan', () => {
  it('tidak menulis dua kali untuk state yang sama', async () => {
    djActions.setCrossfader(0.3);
    await persistNow();
    const first = await loadDjSession();
    await persistNow();
    expect(await loadDjSession()).toBe(first);
  });

  it('autosave menulis setelah perubahan, tanpa dipaksa', async () => {
    const stop = startDjAutosave(0);
    djActions.setCrossfader(0.9);
    await new Promise((r) => setTimeout(r, 10));
    stop();
    const json = await loadDjSession();
    expect(json).not.toBeNull();
    expect(JSON.parse(json as string).mixer.crossfader).toBeCloseTo(0.9, 9);
  });
});
