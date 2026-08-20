/**
 * Cue DJ + koreksi grid yang bertahan melewati sesi (L5 docs/16).
 *
 * Kriteria "done"-nya: *set hot cue → refresh → cue-nya ada. Grid hasil
 * suntingan juga.* Yang diuji di sini adalah kedua ujungnya — apa yang
 * dikumpulkan untuk dikirim, dan apa yang dipasang saat kembali — plus satu
 * aturan yang mudah dilanggar tanpa sadar: **yang tersimpan tidak boleh
 * menimpa yang baru saja dikerjakan user.**
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { applyMarks, collectMarks, createMarksSync } from './marks';
import { fakeLibraryApi } from './fake-api';
import { djActions, djStore } from '../dj/store';
import { studioActions, studioStore } from '../studio/store';
import { EMPTY_TRACK_CUES } from '../dj/model';

const SR = 48_000;
const HASH = 'a'.repeat(64);

function seedAsset(id = 5): void {
  studioActions.registerAsset({
    id,
    name: 'Kelas Malam',
    contentHash: HASH,
    envelope: { levels: [], frames: 0 },
    frames: 60 * SR,
    sampleRate: SR,
    tempo: null,
    tempoPending: false,
    tempoOctave: 0,
    bpmOverride: null,
    beatOffsetOverride: null,
    analysisLock: false,
  } as unknown as Parameters<typeof studioActions.registerAsset>[0]);
}

beforeEach(() => {
  djActions.__resetForTest();
  studioActions.__resetForTest?.('empty');
});

describe('collectMarks', () => {
  it('lagu tanpa cue dan tanpa koreksi TIDAK menghasilkan apa-apa', () => {
    seedAsset();
    // Bukan objek kosong: tidak ada yang perlu dikirim, jadi tidak ada
    // permintaan jaringan sama sekali.
    expect(collectMarks(5)).toBeNull();
  });

  it('mengumpulkan koreksi BPM yang diketik user', () => {
    seedAsset();
    studioActions.setAssetBeatGrid(5, { bpm: 128, offsetSec: 0.25 });

    expect(collectMarks(5)).toMatchObject({ grid: { bpm: 128, offsetSec: 0.25, lock: false } });
  });

  it('kunci analisis ikut, walau tanpa koreksi apa pun', () => {
    seedAsset();
    studioActions.setAnalysisLock(5, true);
    // "Hasil deteksinya sudah benar, jangan disentuh lagi" adalah keputusan
    // user juga — dan ia hilang tiap sesi kalau tidak ikut tersimpan.
    expect(collectMarks(5)).toMatchObject({ grid: { lock: true } });
  });

  it('mengumpulkan cue dari store DJ', () => {
    seedAsset();
    djActions.restoreCues(5, { ...EMPTY_TRACK_CUES, cuePoint: 4 * SR });

    expect(collectMarks(5)).toMatchObject({ cues: { cuePoint: 4 * SR } });
  });
});

describe('applyMarks', () => {
  it('memasang cue dan grid dari server', () => {
    seedAsset();
    applyMarks(5, {
      cues: { ...EMPTY_TRACK_CUES, cuePoint: 2 * SR },
      grid: { bpm: 174, offsetSec: 0.1, lock: true },
    });

    expect(djStore.getState().cues[5]?.cuePoint).toBe(2 * SR);
    expect(studioStore.getState().assets[5]).toMatchObject({
      bpmOverride: 174,
      analysisLock: true,
    });
  });

  it('TIDAK menimpa cue yang sudah dipasang user di sesi ini', () => {
    seedAsset();
    djActions.restoreCues(5, { ...EMPTY_TRACK_CUES, cuePoint: 9 * SR });

    applyMarks(5, { cues: { ...EMPTY_TRACK_CUES, cuePoint: 1 * SR } });

    // Yang tersimpan di server adalah keadaan sesi SEBELUMNYA; menimpanya
    // berarti membuang pekerjaan yang lebih baru dengan yang lebih lama.
    expect(djStore.getState().cues[5]?.cuePoint).toBe(9 * SR);
  });

  it('marks yang rusak diabaikan, bukan dilempar', () => {
    seedAsset();
    expect(() => applyMarks(5, 'bukan objek')).not.toThrow();
    expect(() => applyMarks(5, null)).not.toThrow();
    expect(() => applyMarks(5, { cues: 42 })).not.toThrow();
  });
});

describe('pengiriman yang ditunda', () => {
  it('puluhan perubahan jadi SATU permintaan', async () => {
    seedAsset();
    studioActions.setAssetBeatGrid(5, { bpm: 128, offsetSec: null });

    const putMarks = vi.fn(async (_hash: string, _marks: unknown) => {});
    const sync = createMarksSync(fakeLibraryApi({ putMarks }), { delayMs: 0 });

    for (let i = 0; i < 20; i += 1) sync.touch(5, HASH);
    await sync.flush();

    expect(putMarks).toHaveBeenCalledTimes(1);
    expect(putMarks.mock.calls[0]?.[0]).toBe(HASH);
  });

  it('yang dikirim adalah keadaan TERAKHIR, bukan yang saat disentuh', async () => {
    seedAsset();
    const putMarks = vi.fn(async (_hash: string, _marks: unknown) => {});
    const sync = createMarksSync(fakeLibraryApi({ putMarks }), { delayMs: 0 });

    studioActions.setAssetBeatGrid(5, { bpm: 100, offsetSec: null });
    sync.touch(5, HASH);
    studioActions.setAssetBeatGrid(5, { bpm: 174, offsetSec: null });

    await sync.flush();
    expect(putMarks.mock.calls[0]?.[1]).toMatchObject({ grid: { bpm: 174 } });
  });

  it('lagu tanpa hash tidak pernah dikirim', async () => {
    const putMarks = vi.fn(async () => {});
    const sync = createMarksSync(fakeLibraryApi({ putMarks }), { delayMs: 0 });

    sync.touch(5, '');
    await sync.flush();
    expect(putMarks).not.toHaveBeenCalled();
  });

  it('kegagalan kirim TIDAK meledak — perubahan berikutnya mengirim ulang semuanya', async () => {
    seedAsset();
    studioActions.setAssetBeatGrid(5, { bpm: 128, offsetSec: null });
    const sync = createMarksSync(
      fakeLibraryApi({
        putMarks: async () => {
          throw new Error('jaringan putus');
        },
      }),
      { delayMs: 0 },
    );

    sync.touch(5, HASH);
    await expect(sync.flush()).resolves.toBeUndefined();
  });

  it('stop membatalkan yang tertunda', async () => {
    seedAsset();
    studioActions.setAssetBeatGrid(5, { bpm: 128, offsetSec: null });
    const putMarks = vi.fn(async () => {});
    const sync = createMarksSync(fakeLibraryApi({ putMarks }), { delayMs: 50 });

    sync.touch(5, HASH);
    sync.stop();
    await sync.flush();

    expect(putMarks).not.toHaveBeenCalled();
  });
});
