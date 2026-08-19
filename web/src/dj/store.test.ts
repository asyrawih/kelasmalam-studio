import { beforeEach, describe, expect, it } from 'vitest';

import type { BeatGrid } from '../studio/analysis/beat-grid';
import { EMPTY_TRACK_CUES, effectiveBpm, type TempoRange } from './model';
import { djActions, djAssetIds, djStore, selectTrackCues } from './store';

const SR = 48_000;
const GRID: BeatGrid = { bpm: 120, offsetSec: 0, beatsPerBar: 4, manual: false };
/** 120 BPM @48k → 24 000 sample per ketukan. */
const BEAT = 24_000;

const s = () => djStore.getState();
const load = (id: 'A' | 'B', assetId = 1, frames = SR * 300): void =>
  djActions.loadDeck(id, { assetId, frames, name: `LAGU ${assetId}`, sampleRate: SR });

beforeEach(() => {
  djActions.__resetForTest();
});

describe('memuat & mengeluarkan lagu', () => {
  it('menyalin frames/name/sampleRate dari asset', () => {
    load('A', 7, 1234);
    expect(s().decks.A.assetId).toBe(7);
    expect(s().decks.A.frames).toBe(1234);
    expect(s().decks.A.name).toBe('LAGU 7');
    expect(s().decks.A.sampleRate).toBe(SR);
  });

  it('TIDAK mereset tempo fader — DJ menyiapkan tempo sebelum memuat lagu', () => {
    djActions.setTempoFader('A', 0.4);
    load('A');
    expect(s().decks.A.tempo.fader).toBeCloseTo(0.4, 12);
  });

  it('eject mengosongkan transport dan loop, tapi cue TETAP karena milik asset', () => {
    load('A', 3);
    djActions.setHotCue('A', 'C', 5_000);
    djActions.setBeatLoop('A', 4, GRID);
    djActions.ejectDeck('A');
    expect(s().decks.A.assetId).toBeNull();
    expect(s().decks.A.loop.inAt).toBeNull();
    // Muat lagu yang sama lagi → cue-nya kembali.
    load('A', 3);
    expect(selectTrackCues('A')(s()).hotCues.C?.at).toBe(5_000);
  });

  it('deck kosong tidak bisa play', () => {
    djActions.play('A');
    expect(s().decks.A.playing).toBe(false);
  });
});

describe('semantik tombol CUE', () => {
  it('diam di tempat lain → memasang cue point di sini, tetap diam', () => {
    load('A');
    djActions.seek('A', 10_000);
    djActions.cuePress('A');
    expect(selectTrackCues('A')(s()).cuePoint).toBe(10_000);
    expect(s().decks.A.playing).toBe(false);
  });

  it('diam DI cue point → putar-tahan; lepas → balik ke cue dan berhenti', () => {
    load('A');
    djActions.cuePress('A'); // playhead 0 === cuePoint 0 → putar-tahan
    expect(s().decks.A.playing).toBe(true);
    expect(s().decks.A.cueHeld).toBe(true);
    djActions.tick(500);
    expect(s().decks.A.playhead).toBeGreaterThan(0);
    djActions.cueRelease('A');
    expect(s().decks.A.playing).toBe(false);
    expect(s().decks.A.playhead).toBe(0);
  });

  it('sedang playing → lompat ke cue dan BERHENTI', () => {
    load('A');
    djActions.seek('A', 50_000);
    djActions.setCuePoint('A', 50_000);
    djActions.play('A');
    djActions.tick(200);
    djActions.cuePress('A');
    expect(s().decks.A.playing).toBe(false);
    expect(s().decks.A.playhead).toBe(50_000);
  });
});

describe('seek & clamp', () => {
  it('dijepit ke [0, frames] dan menaikkan seekEpoch', () => {
    load('A', 1, 1000);
    const before = s().decks.A.seekEpoch;
    djActions.seek('A', 999_999);
    expect(s().decks.A.playhead).toBe(1000);
    expect(s().decks.A.seekEpoch).toBe(before + 1);
    djActions.seek('A', -50);
    expect(s().decks.A.playhead).toBe(0);
  });

  it('nudge TIDAK menaikkan seekEpoch — jog halus bukan lompatan', () => {
    load('A');
    const before = s().decks.A.seekEpoch;
    djActions.nudge('A', 500);
    expect(s().decks.A.playhead).toBe(500);
    expect(s().decks.A.seekEpoch).toBe(before);
  });
});

describe('tick', () => {
  it('maju sesuai laju efektif', () => {
    load('A');
    djActions.play('A');
    djActions.tick(1000);
    expect(s().decks.A.playhead).toBe(SR);
    djActions.setTempoFader('A', 1); // +10% di rentang default
    djActions.tick(1000);
    expect(s().decks.A.playhead).toBeCloseTo(SR + SR * 1.1, -1);
  });

  it('TIDAK menyentuh deck yang tidak playing — objeknya harus identik', () => {
    load('A');
    load('B', 2);
    djActions.play('A');
    const bBefore = s().decks.B;
    djActions.tick(100);
    expect(s().decks.B).toBe(bBefore);
  });

  it('berhenti di ujung materi, tidak melewatinya', () => {
    load('A', 1, 1000);
    djActions.play('A');
    djActions.tick(5000);
    expect(s().decks.A.playhead).toBe(1000);
    expect(s().decks.A.playing).toBe(false);
  });

  it('terkurung di dalam loop yang aktif', () => {
    load('A');
    djActions.setBeatLoop('A', 1, GRID); // 24 000 sample
    djActions.play('A');
    djActions.tick(2000); // 96 000 sample — empat kali panjang loop
    const p = s().decks.A.playhead;
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThan(BEAT);
  });
});

describe('loop', () => {
  it('beat loop memakai panjang ketukan grid', () => {
    load('A');
    djActions.setBeatLoop('A', 4, GRID);
    expect(s().decks.A.loop.inAt).toBe(0);
    expect(s().decks.A.loop.outAt).toBe(4 * BEAT);
    expect(s().decks.A.loop.active).toBe(true);
    expect(s().decks.A.loop.beats).toBe(4);
  });

  it('÷2 dan ×2 MENJANGKAR di inAt, bukan di playhead', () => {
    load('A');
    djActions.seek('A', 3 * BEAT);
    djActions.setBeatLoop('A', 4, GRID);
    const inAt = s().decks.A.loop.inAt;
    djActions.halveLoop('A');
    djActions.halveLoop('A');
    expect(s().decks.A.loop.inAt).toBe(inAt);
    expect(s().decks.A.loop.outAt).toBe((inAt as number) + BEAT);
    expect(s().decks.A.loop.beats).toBe(1);
    djActions.doubleLoop('A');
    expect(s().decks.A.loop.inAt).toBe(inAt);
    expect(s().decks.A.loop.beats).toBe(2);
  });

  it('keluar loop MEMPERTAHANKAN batasnya supaya RELOOP mungkin', () => {
    load('A');
    djActions.setBeatLoop('A', 2, GRID);
    djActions.exitLoop('A');
    expect(s().decks.A.loop.active).toBe(false);
    expect(s().decks.A.loop.inAt).toBe(0);
    djActions.seek('A', 10 * BEAT);
    djActions.reloop('A');
    expect(s().decks.A.loop.active).toBe(true);
    expect(s().decks.A.playhead).toBe(0);
  });

  it('loop OUT sebelum IN diabaikan, bukan membuat loop terbalik', () => {
    load('A');
    djActions.setLoopIn('A', 10 * BEAT, GRID);
    djActions.setLoopOut('A', 2 * BEAT, GRID);
    expect(s().decks.A.loop.outAt).toBeNull();
    expect(s().decks.A.loop.active).toBe(false);
  });
});

describe('hot cue milik ASSET', () => {
  it('lagu yang sama di deck lain membawa cue-nya', () => {
    load('A', 9);
    djActions.setHotCue('A', 'B', 4242);
    load('B', 9);
    expect(selectTrackCues('B')(s()).hotCues.B?.at).toBe(4242);
  });

  it('lagu BERBEDA tidak mewarisi cue lagu lain', () => {
    load('A', 1);
    djActions.setHotCue('A', 'A', 111);
    load('B', 2);
    expect(selectTrackCues('B')(s())).toBe(EMPTY_TRACK_CUES);
  });

  it('pad kosong memasang cue di posisi kini; pad terisi melompat', () => {
    load('A');
    djActions.seek('A', 5 * BEAT + 500);
    djActions.triggerHotCue('A', 'D', GRID); // quantize aktif → menempel ke ketukan
    expect(selectTrackCues('A')(s()).hotCues.D?.at).toBe(5 * BEAT);
    djActions.seek('A', 0);
    djActions.triggerHotCue('A', 'D', GRID);
    expect(s().decks.A.playhead).toBe(5 * BEAT);
  });

  it('deck kosong tidak bisa memasang cue di mana pun', () => {
    djActions.triggerHotCue('A', 'A', GRID);
    expect(s().cues).toEqual({});
  });
});

describe('sync', () => {
  it('menolak dengan ALASAN, bukan diam, kalau belum ada master', () => {
    load('A');
    const r = djActions.applySync('A', 128, 130);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/MASTER/i);
  });

  it('menolak dengan alasan kalau selisihnya di luar rentang', () => {
    load('A');
    load('B', 2);
    djActions.setMasterDeck('B');
    const r = djActions.applySync('A', 128, 160); // butuh +25%, rentang ±10%
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/rentang/);
    expect(s().decks.A.tempo.fader).toBe(0);
  });

  it('menyamakan BPM efektif saat masih di dalam rentang', () => {
    load('A');
    load('B', 2);
    djActions.setMasterDeck('B');
    expect(djActions.applySync('A', 128, 132).ok).toBe(true);
    expect(effectiveBpm(128, s().decks.A.tempo) as number).toBeCloseTo(132, 9);
    expect(s().decks.A.sync).toBe('follower');
  });

  it('hanya satu deck yang boleh jadi MASTER', () => {
    load('A');
    load('B', 2);
    djActions.setMasterDeck('A');
    expect(s().decks.A.sync).toBe('master');
    djActions.setMasterDeck('B');
    expect(s().decks.A.sync).not.toBe('master');
    expect(s().decks.B.sync).toBe('master');
  });

  it('master yang decknya dikosongkan otomatis dilepas', () => {
    load('A');
    djActions.setMasterDeck('A');
    djActions.ejectDeck('A');
    expect(s().masterDeck).toBeNull();
    expect(s().decks.A.sync).toBe('off');
  });
});

describe('EQ kill', () => {
  it('menekan label mematikan band, menekan lagi mengembalikannya ke 0', () => {
    djActions.toggleEqKill('A', 'low');
    expect(s().mixer.channels.A.eq.low).toBe(-26);
    djActions.toggleEqKill('A', 'low');
    expect(s().mixer.channels.A.eq.low).toBe(0);
  });

  it('nilai di luar rentang dijepit ke −26…+6', () => {
    djActions.setEqBand('A', 'hi', 99);
    expect(s().mixer.channels.A.eq.hi).toBe(6);
    djActions.setEqBand('A', 'hi', -99);
    expect(s().mixer.channels.A.eq.hi).toBe(-26);
  });
});

describe('akar retensi asset', () => {
  it('melaporkan asset yang dipegang deck DAN yang punya cue tersimpan', () => {
    load('A', 11);
    djActions.setHotCue('A', 'A', 1);
    load('B', 22);
    expect([...djAssetIds()].sort((x, y) => x - y)).toEqual([11, 22]);
    // Dikeluarkan dari deck, tapi cue-nya masih ada → tetap harus dipertahankan.
    djActions.ejectDeck('A');
    expect(djAssetIds()).toContain(11);
  });
});

describe('rentang tempo', () => {
  it('mengganti rentang tidak menggerakkan fader', () => {
    djActions.setTempoFader('A', 0.5);
    djActions.setTempoRange('A', 16 as TempoRange);
    expect(s().decks.A.tempo.fader).toBeCloseTo(0.5, 12);
  });

  it('nudge bergerak satu langkah terkecil rentangnya', () => {
    djActions.setTempoRange('A', 6 as TempoRange);
    djActions.nudgeTempoFader('A', 1);
    // 0.02% dari rentang 6% = 1/300 travel.
    expect(s().decks.A.tempo.fader).toBeCloseTo(0.02 / 6, 12);
  });
});
