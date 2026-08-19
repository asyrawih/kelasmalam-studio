/**
 * BEAT SYNC bersama kepustakaan sungguhan — leader, tempo, fase, dan pemicunya.
 *
 * Ini yang menggantikan tes SYNC lama di `store.test.ts`. Mereka pindah karena
 * sync sekarang butuh GRID, dan grid milik `studioStore` — store DJ sengaja
 * tidak tahu apa pun tentang asset.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { studioActions, type StudioAsset } from '../studio/store';
import { djActions, djStore } from './store';
import { phaseErrorOf, startSyncFollow, toggleSyncFor } from './sync-ops';

const SR = 48_000;
const s = () => djStore.getState();

/** Asset minimal: yang dibaca `resolveBeatGrid` hanya tempo dan override-nya. */
const asset = (id: number, bpm: number, offsetSec = 0): StudioAsset =>
  ({
    id,
    name: `LAGU ${id}`,
    envelope: { levels: [], frames: 0 },
    frames: SR * 300,
    sampleRate: SR,
    tempo: { bpm, confidence: 0.9, beatOffsetSec: offsetSec },
    tempoPending: false,
    tempoOctave: 0,
    bpmOverride: null,
    beatOffsetOverride: null,
    analysisLock: false,
  }) as unknown as StudioAsset;

function load(deck: 'A' | 'B', assetId: number, bpm: number, offsetSec = 0): void {
  studioActions.registerAsset(asset(assetId, bpm, offsetSec));
  djActions.loadDeck(deck, { assetId, frames: SR * 300, name: `LAGU ${assetId}`, sampleRate: SR });
}

/** Posisi source `beats` ketukan setelah titik nol grid. */
const atBeat = (bpm: number, beats: number, offsetSec = 0): number =>
  Math.round((offsetSec + (beats * 60) / bpm) * SR);

const heardBpm = (deck: 'A' | 'B', gridBpm: number): number => {
  const t = s().decks[deck].tempo;
  return gridBpm * (1 + (t.fader * t.rangePct) / 100);
};

beforeEach(() => {
  djActions.__resetForTest();
  studioActions.__resetForTest?.();
});

describe('memilih leader', () => {
  it('mengangkat deck lain jadi MASTER sendiri kalau belum ada', () => {
    // Dulu ini menolak dengan "belum ada deck MASTER". Di halaman dua deck,
    // satu-satunya jawaban yang mungkin memang deck yang satunya lagi.
    load('A', 1, 128);
    load('B', 2, 130);
    expect(s().masterDeck).toBeNull();

    expect(toggleSyncFor('A').ok).toBe(true);
    expect(s().masterDeck).toBe('B');
    expect(s().decks.A.sync).toBe('follower');
  });

  it('menghormati MASTER yang sudah dipilih user', () => {
    load('A', 1, 128);
    load('B', 2, 130);
    djActions.setMasterDeck('A');
    expect(toggleSyncFor('B').ok).toBe(true);
    expect(s().masterDeck).toBe('A');
  });

  it('menolak dengan kalimat kalau deck lain kosong', () => {
    load('A', 1, 128);
    const r = toggleSyncFor('A');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/tidak ada deck lain/);
  });

  it('menolak dengan kalimat kalau materinya belum punya grid', () => {
    load('A', 1, 128);
    studioActions.registerAsset({ ...asset(2, 128), tempo: null } as StudioAsset);
    djActions.loadDeck('B', { assetId: 2, frames: SR * 300, name: 'B', sampleRate: SR });
    const r = toggleSyncFor('A');
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/grid/);
  });
});

describe('tempo', () => {
  it('menyamakan BPM ke yang benar-benar TERDENGAR di master, bukan base-nya', () => {
    // Cacat lama: pemanggil mengirim BPM base master. Kalau fader master tidak
    // di nol, follower disamakan ke tempo yang tidak sedang terdengar.
    load('A', 1, 128);
    load('B', 2, 130);
    djActions.setMasterDeck('B');
    djActions.setTempoFader('B', 0.5); // +5% → 136.5

    expect(toggleSyncFor('A').ok).toBe(true);
    expect(heardBpm('A', 128)).toBeCloseTo(136.5, 6);
  });

  it('87 mengikuti 174 tanpa menaikkan pitch — rasio 1:1, fader tetap nol', () => {
    load('A', 1, 87);
    load('B', 2, 174);
    djActions.setMasterDeck('B');

    expect(toggleSyncFor('A').ok).toBe(true);
    expect(s().decks.A.tempo.fader).toBeCloseTo(0, 9);
    expect(djStore.getState().notice).toMatch(/÷2/);
  });

  it('melebarkan rentang sendiri saat perlu, dan mengatakannya', () => {
    // 128 → 145 butuh +13.3%: tidak muat di ±10 bawaan.
    load('A', 1, 128);
    load('B', 2, 145);
    djActions.setMasterDeck('B');

    expect(toggleSyncFor('A').ok).toBe(true);
    expect(s().decks.A.tempo.rangePct).toBe(16);
    expect(heardBpm('A', 128)).toBeCloseTo(145, 6);
    expect(djStore.getState().notice).toMatch(/rentang/);
  });

  it('mematikan SYNC meninggalkan tempo fader di tempatnya', () => {
    load('A', 1, 128);
    load('B', 2, 132);
    djActions.setMasterDeck('B');
    toggleSyncFor('A');
    const fader = s().decks.A.tempo.fader;
    expect(fader).not.toBe(0);

    toggleSyncFor('A');
    expect(s().decks.A.sync).toBe('off');
    expect(s().decks.A.tempo.fader).toBeCloseTo(fader, 12);
  });
});

describe('fase', () => {
  it('menggeser playhead follower sampai ketukannya sejajar', () => {
    load('A', 1, 128);
    load('B', 2, 128);
    djActions.setMasterDeck('B');
    djActions.seek('B', atBeat(128, 16));
    djActions.seek('A', atBeat(128, 16.3)); // meleset 0.3 ketukan

    expect(phaseErrorOf('A')!).toBeCloseTo(-0.3, 2);
    expect(toggleSyncFor('A').ok).toBe(true);
    expect(phaseErrorOf('A')!).toBeCloseTo(0, 3);
  });

  it('menaikkan seekEpoch supaya lapisan audio menjadwalkan ulang', () => {
    // Playhead yang pindah tanpa menaikkannya berarti angka di layar berubah
    // tapi yang terdengar tidak — cacat yang hanya bisa didengar.
    load('A', 1, 128);
    load('B', 2, 128);
    djActions.setMasterDeck('B');
    djActions.seek('B', atBeat(128, 16));
    djActions.seek('A', atBeat(128, 16.3));

    const before = s().decks.A.seekEpoch;
    toggleSyncFor('A');
    expect(s().decks.A.seekEpoch).toBeGreaterThan(before);
  });

  it('grid dengan downbeat berbeda tetap disejajarkan', () => {
    load('A', 1, 128, 0.9);
    load('B', 2, 128, 0.15);
    djActions.setMasterDeck('B');
    djActions.seek('B', atBeat(128, 12, 0.15));
    djActions.seek('A', atBeat(128, 12.4, 0.9));

    toggleSyncFor('A');
    expect(phaseErrorOf('A')!).toBeCloseTo(0, 3);
  });

  it('oktaf berbeda tetap sejajar — kasus yang bikin Mixxx kejeblos', () => {
    load('A', 1, 87);
    load('B', 2, 174);
    djActions.setMasterDeck('B');
    djActions.seek('B', atBeat(174, 8));
    djActions.seek('A', atBeat(87, 4.4));

    toggleSyncFor('A');
    expect(phaseErrorOf('A')!).toBeCloseTo(0, 3);
  });
});

describe('fase ulang saat LEADER melompat', () => {
  it('follower ikut difase ulang', () => {
    load('A', 1, 128);
    load('B', 2, 128);
    djActions.setMasterDeck('B');
    toggleSyncFor('A');

    const stop = startSyncFollow();
    try {
      // Leader melompat ke tempat yang tidak sejajar dengan follower.
      djActions.seek('B', atBeat(128, 20) + 3000);
      expect(phaseErrorOf('A')!).toBeCloseTo(0, 3);
    } finally {
      stop();
    }
  });

  it('umpan jam TIDAK memicunya — kalau iya, itu jadi loop koreksi', () => {
    load('A', 1, 128);
    load('B', 2, 128);
    djActions.setMasterDeck('B');
    toggleSyncFor('A');

    const stop = startSyncFollow();
    try {
      const before = s().decks.A.seekEpoch;
      // `syncFromClock` sengaja tidak menaikkan seekEpoch.
      djActions.syncFromClock('B', atBeat(128, 20) + 1234);
      expect(s().decks.A.seekEpoch).toBe(before);
    } finally {
      stop();
    }
  });

  it('lompatan FOLLOWER sendiri tidak ditarik balik', () => {
    // Kalau user melompat di deck yang sedang mengikuti, ia sedang mengambil
    // keputusan sendiri — bukan kesalahan yang perlu dibetulkan.
    load('A', 1, 128);
    load('B', 2, 128);
    djActions.setMasterDeck('B');
    toggleSyncFor('A');

    const stop = startSyncFollow();
    try {
      const target = atBeat(128, 30) + 5000;
      djActions.seek('A', target);
      expect(s().decks.A.playhead).toBe(target);
    } finally {
      stop();
    }
  });

  it('deck yang TIDAK ber-SYNC tidak disentuh', () => {
    load('A', 1, 128);
    load('B', 2, 128);
    djActions.setMasterDeck('B');

    const stop = startSyncFollow();
    try {
      const before = s().decks.A.playhead;
      djActions.seek('B', atBeat(128, 20) + 3000);
      expect(s().decks.A.playhead).toBe(before);
    } finally {
      stop();
    }
  });
});
