/**
 * Lagu kepustakaan yang diseret ke lane.
 *
 * Yang dijaga: timeline tetap TIDAK tahu apa-apa soal jaringan (ia cuma
 * mengumumkan hash), dan yang menerima pengumuman itu memakai asset yang sudah
 * ada di sesi alih-alih mengunduh 25 MB untuk kedua kalinya.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LIBRARY_TRACK_MIME,
  hasLibraryDropHandler,
  notifyLibraryDrop,
  registerLibraryDropHandler,
} from '../studio/timeline/library-drop';
import { placeAssetOnLane } from '../studio/timeline/audio-import';
import { studioActions, studioStore } from '../studio/store';

const SR = 48_000;

function seedAsset(id: number, name: string): void {
  studioActions.registerAsset({
    id,
    name,
    contentHash: 'a'.repeat(64),
    envelope: { levels: [], frames: 0 },
    frames: 10 * SR,
    sampleRate: SR,
    tempo: null,
    tempoPending: false,
    tempoOctave: 0,
    bpmOverride: null,
    beatOffsetOverride: null,
    analysisLock: false,
  } as unknown as Parameters<typeof studioActions.registerAsset>[0]);
}

const laneId = (): string => studioStore.getState().lanes[0]?.id ?? '';
const clips = (): { start: number; len: number; assetId: number }[] =>
  (studioStore.getState().lanes[0]?.clips ?? []).map((c) => ({
    start: c.start,
    len: c.len,
    assetId: c.assetId,
  }));

beforeEach(() => {
  studioActions.__resetForTest?.('empty');
  registerLibraryDropHandler(null);
});

describe('perantara drop', () => {
  it('tanpa penangan, pengumuman tidak melakukan apa-apa', () => {
    expect(hasLibraryDropHandler()).toBe(false);
    expect(() =>
      notifyLibraryDrop({ contentHash: 'a'.repeat(64), laneId: 'l1', startSamples: 0 }),
    ).not.toThrow();
  });

  it('meneruskan hash, lane, dan posisi apa adanya', () => {
    const seen = vi.fn();
    const detach = registerLibraryDropHandler(seen);

    notifyLibraryDrop({ contentHash: 'b'.repeat(64), laneId: 'lane-9', startSamples: 4 * SR });
    detach();

    expect(seen).toHaveBeenCalledWith({
      contentHash: 'b'.repeat(64),
      laneId: 'lane-9',
      startSamples: 4 * SR,
    });
  });

  it('penangan yang melempar tidak menggagalkan gestur yang sudah selesai', () => {
    const detach = registerLibraryDropHandler(() => {
      throw new Error('kepustakaan rusak');
    });
    expect(() =>
      notifyLibraryDrop({ contentHash: 'a'.repeat(64), laneId: 'l1', startSamples: 0 }),
    ).not.toThrow();
    detach();
  });

  it('mencabut penangan benar-benar mencabutnya', () => {
    const seen = vi.fn();
    registerLibraryDropHandler(seen)();
    notifyLibraryDrop({ contentHash: 'a'.repeat(64), laneId: 'l1', startSamples: 0 });
    expect(seen).not.toHaveBeenCalled();
  });

  it('MIME-nya khusus, bukan text/plain', () => {
    // Lane sudah memakai `text/plain` untuk URL. Hash yang lewat jalur itu akan
    // dicoba diunduh sebagai URL dan gagal dengan pesan yang tidak masuk akal.
    expect(LIBRARY_TRACK_MIME).toBe('application/x-kelasmalam-track');
    expect(LIBRARY_TRACK_MIME).not.toContain('text/');
  });
});

describe('menaruh asset yang sudah ada', () => {
  it('membuat satu clip di lane, pada posisi yang diminta', () => {
    seedAsset(7, 'Kelas Malam');
    placeAssetOnLane(7, 'Kelas Malam', 10 * SR, laneId(), 3 * SR);

    expect(clips()).toEqual([{ start: 3 * SR, len: 10 * SR, assetId: 7 }]);
  });

  it('posisi negatif dijepit ke nol', () => {
    seedAsset(7, 'x');
    placeAssetOnLane(7, 'x', SR, laneId(), -5 * SR);
    expect(clips()[0]?.start).toBe(0);
  });

  it('`avoidOverlap` menaruhnya di belakang materi yang sudah ada', () => {
    seedAsset(7, 'x');
    placeAssetOnLane(7, 'x', 5 * SR, laneId(), 0);
    placeAssetOnLane(7, 'x', 5 * SR, laneId(), 0, { avoidOverlap: true });

    expect(clips().map((c) => c.start).sort((a, b) => a - b)).toEqual([0, 5 * SR]);
  });

  it('tanpa opsi itu, posisi yang diminta dihormati apa adanya', () => {
    seedAsset(7, 'x');
    placeAssetOnLane(7, 'x', 5 * SR, laneId(), 0);
    placeAssetOnLane(7, 'x', 5 * SR, laneId(), SR);

    // Menumpuk memang boleh — yang tidak boleh adalah menggesernya diam-diam.
    expect(clips().map((c) => c.start).sort((a, b) => a - b)).toEqual([0, SR]);
  });

  it('dua clip dari asset yang sama menunjuk asset yang sama', () => {
    seedAsset(7, 'x');
    placeAssetOnLane(7, 'x', SR, laneId(), 0);
    placeAssetOnLane(7, 'x', SR, laneId(), 2 * SR);

    expect(clips().map((c) => c.assetId)).toEqual([7, 7]);
  });
});
