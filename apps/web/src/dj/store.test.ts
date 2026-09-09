import { beforeEach, describe, expect, it } from 'vitest';

import type { BeatGrid } from '../studio/analysis/beat-grid';
import {
  EMPTY_TRACK_CUES,
  bandDb,
  effectiveRate,
  tempoRatio,
  type TempoRange,
} from './model';
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

  it('mulai putar dari tengah lagu → CUE balik ke SITU, bukan ke detik nol', () => {
    load('A');
    djActions.seek('A', 90 * BEAT);
    djActions.togglePlay('A'); // tanpa memasang cue secara sadar lebih dulu
    expect(selectTrackCues('A')(s()).cuePoint).toBe(90 * BEAT);
    djActions.tick(1_000);
    djActions.cuePress('A');
    expect(s().decks.A.playing).toBe(false);
    expect(s().decks.A.playhead).toBe(90 * BEAT);
  });

  it('cue yang dipasang sengaja tidak bergeser saat diputar DARI titik itu', () => {
    load('A');
    djActions.seek('A', 20 * BEAT);
    djActions.cuePress('A'); // pasang cue di sini
    djActions.play('A');
    expect(selectTrackCues('A')(s()).cuePoint).toBe(20 * BEAT);
  });

  it('putar → jeda → putar lagi memindahkan cue ke titik jeda itu', () => {
    load('A');
    djActions.play('A');
    djActions.tick(1_000);
    djActions.pause('A');
    const at = s().decks.A.playhead;
    expect(at).toBeGreaterThan(0);
    djActions.play('A');
    expect(selectTrackCues('A')(s()).cuePoint).toBe(at);
    djActions.cuePress('A');
    expect(s().decks.A.playhead).toBe(at);
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

  it('umpan jam TIDAK menaikkan seekEpoch — kalau iya, tiap kiriman posisi akan menjadwalkan ulang audio', () => {
    load('A');
    const before = s().decks.A.seekEpoch;
    djActions.syncFromClock('A', 500);
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

  it('pad kosong memasang cue di posisi kini; pad terisi MELOMPAT', () => {
    load('A');
    djActions.seek('A', 5 * BEAT + 500);
    djActions.triggerHotCue('A', 'D', GRID); // quantize aktif → menempel ke ketukan
    expect(selectTrackCues('A')(s()).hotCues.D?.at).toBe(5 * BEAT);

    djActions.seek('A', 0);
    djActions.triggerHotCue('A', 'D', GRID);
    expect(s().decks.A.playhead).toBe(5 * BEAT);
  });

  it('pad TIDAK toggle — sekali klik, satu perbuatan yang bisa diulang', () => {
    load('A');
    djActions.setHotCue('A', 'D', 5 * BEAT);
    djActions.play('A');
    djActions.triggerHotCue('A', 'D', GRID);
    djActions.triggerHotCue('A', 'D', GRID);
    // Tetap di cue, tetap main. Pad adalah sasaran tetikus: yang dicari saat
    // mengkliknya adalah "bawa aku ke sana".
    expect(s().decks.A.playhead).toBe(5 * BEAT);
    expect(s().decks.A.playing).toBe(true);
  });
});

describe('hot cue dari KEYBOARD', () => {
  it('adalah tombol ON/OFF, bukan lompatan berulang', () => {
    load('A');
    djActions.setHotCue('A', 'D', 5 * BEAT);
    djActions.seek('A', 0);

    // ON: lompat ke cue dan mulai main.
    djActions.toggleHotCue('A', 'D', GRID);
    expect(s().decks.A.playhead).toBe(5 * BEAT);
    expect(s().decks.A.playing).toBe(true);
    expect(s().decks.A.activeHotCue).toBe('D');

    djActions.tick(500);
    expect(s().decks.A.playhead).toBeGreaterThan(5 * BEAT);

    // OFF: berhenti, dan KEMBALI ke titik cue.
    djActions.toggleHotCue('A', 'D', GRID);
    expect(s().decks.A.playing).toBe(false);
    expect(s().decks.A.playhead).toBe(5 * BEAT);
    expect(s().decks.A.activeHotCue).toBeNull();
  });

  it('tekanan kedua TIDAK menghapus cue-nya', () => {
    // Hot cue dipencet berulang-ulang selama satu set; menghapusnya lewat
    // tombol yang sama berarti satu tekan berlebih membuang titik yang
    // dipasang dengan tangan.
    load('A');
    djActions.setHotCue('A', 'D', 5 * BEAT);
    djActions.toggleHotCue('A', 'D', GRID);
    djActions.toggleHotCue('A', 'D', GRID);
    expect(selectTrackCues('A')(s()).hotCues.D?.at).toBe(5 * BEAT);
  });

  it('menekan slot LAIN berpindah ke sana, tetap menyala', () => {
    load('A');
    djActions.setHotCue('A', 'A', BEAT);
    djActions.setHotCue('A', 'B', 9 * BEAT);
    djActions.toggleHotCue('A', 'A', GRID);
    djActions.toggleHotCue('A', 'B', GRID);
    expect(s().decks.A.playhead).toBe(9 * BEAT);
    expect(s().decks.A.playing).toBe(true);
    expect(s().decks.A.activeHotCue).toBe('B');
  });

  it('setelah dijeda lewat tombol lain, tekanan berikutnya MENYALAKAN lagi', () => {
    load('A');
    djActions.setHotCue('A', 'D', 5 * BEAT);
    djActions.toggleHotCue('A', 'D', GRID);
    djActions.pause('A');
    djActions.toggleHotCue('A', 'D', GRID);
    expect(s().decks.A.playing).toBe(true);
  });

  it('melompat ke tempat lain mematikan lampu hot cue', () => {
    load('A');
    djActions.setHotCue('A', 'D', 5 * BEAT);
    djActions.toggleHotCue('A', 'D', GRID);
    expect(s().decks.A.activeHotCue).toBe('D');
    // Pad yang tetap menyala setelah user melompat ke tempat lain akan
    // berbohong tentang apa yang terjadi kalau ia ditekan.
    djActions.seek('A', 20 * BEAT);
    expect(s().decks.A.activeHotCue).toBeNull();
  });

  it('deck kosong tidak bisa memasang cue di mana pun', () => {
    djActions.triggerHotCue('A', 'A', GRID);
    expect(s().cues).toEqual({});
  });
});

describe('sync', () => {
  // Perilaku SYNC yang sebenarnya — tempo, oktaf, fase, leader — dites di
  // `sync.test.ts` (murni) dan `sync-ops.test.ts` (bersama kepustakaan). Yang
  // tinggal di sini hanya invarian milik STORE, yang tidak butuh grid apa pun.

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
  it('menekan label mematikan band, menekan lagi menyalakannya', () => {
    djActions.toggleEqKill('A', 'low');
    expect(s().mixer.channels.A.eqKill.low).toBe(true);
    djActions.toggleEqKill('A', 'low');
    expect(s().mixer.channels.A.eqKill.low).toBe(false);
  });

  it('KILL TIDAK membuang nilai knob — menyalakan lagi mengembalikan setelannya', () => {
    // Ini kelas bug yang mahal: menimpa nilai knob berarti mematikan lalu
    // menyalakan band membuang setelan yang dibuat tangan, di tengah mix, dan
    // penyebabnya tidak kelihatan karena knob-nya memang bergerak sendiri.
    djActions.setEqBand('A', 'mid', 4);
    djActions.toggleEqKill('A', 'mid');
    expect(s().mixer.channels.A.eq.mid).toBe(4);
    expect(bandDb(s().mixer.channels.A.eq, s().mixer.channels.A.eqKill, 'mid')).toBe(-26);
    djActions.toggleEqKill('A', 'mid');
    expect(bandDb(s().mixer.channels.A.eq, s().mixer.channels.A.eqKill, 'mid')).toBe(4);
  });

  it('band lain tidak ikut mati', () => {
    djActions.toggleEqKill('A', 'low');
    expect(s().mixer.channels.A.eqKill.hi).toBe(false);
    expect(s().mixer.channels.B.eqKill.low).toBe(false);
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

  it('pitch bend TERPISAH dari tempo fader — nudge tidak boleh mengubah BPM lagu', () => {
    load('A');
    djActions.setTempoFader('A', 0.2);
    const fader = s().decks.A.tempo.fader;

    djActions.setBend('A', 1.04);
    // Laju efektif naik…
    expect(effectiveRate(s().decks.A)).toBeGreaterThan(tempoRatio(s().decks.A.tempo));
    // …tapi tempo fader TIDAK bergerak. Kalau bend menulis ke fader, satu
    // dorongan untuk menutup selisih milidetik akan mengubah tempo lagu itu
    // secara permanen.
    expect(s().decks.A.tempo.fader).toBe(fader);

    djActions.setBend('A', 1);
    expect(effectiveRate(s().decks.A)).toBeCloseTo(tempoRatio(s().decks.A.tempo), 12);
  });
});
