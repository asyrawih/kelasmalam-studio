/**
 * Di mana clip mendarat saat SATU perbuatan membawa beberapa file.
 *
 * Regresi yang dijaga: menghitung posisi saat import DIMULAI tidak cukup.
 * Tiga import berjalan bersamaan, jadi pada saat mulai lane-nya masih kosong
 * untuk ketiga-tiganya — ketiganya menghitung angka yang sama dan tetap
 * menumpuk di satu titik, dan di layar hanya satu clip yang terlihat. Yang
 * benar adalah menghitungnya tepat sebelum clip dibuat, yaitu setelah decode.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../analysis/tempo-client', () => ({ requestAssetTempo: () => undefined }));

/** Penahan decode: tes yang menentukan kapan tiap file selesai. */
const pending: ((buffer: AudioBuffer) => void)[] = [];

vi.mock('../preview/audio-preview', () => ({
  ensureContext: () => ({
    sampleRate: 48_000,
    decodeAudioData: () => new Promise<AudioBuffer>((resolve) => pending.push(resolve)),
  }),
  registerBuffer: () => undefined,
}));

const { importBytesToLane } = await import('./audio-import');
const { studioActions, studioStore } = await import('../store');

const SR = 48_000;

/**
 * WAV minimal — cukup untuk lolos `sniff`.
 *
 * Isinya BERBEDA tiap panggilan. Sejak import men-dedup berdasarkan SHA-256
 * (docs/16 §2), dua "berkas" dengan byte identik memang satu lagu: yang kedua
 * memakai asset yang sama dan tidak pernah men-decode. Tes ini menguji
 * penempatan clip dari beberapa berkas BERBEDA, jadi byte-nya harus berbeda —
 * kalau tidak, yang diuji berubah jadi dedup tanpa ada yang menyadarinya.
 */
let wavSeed = 0;
function wav(): ArrayBuffer {
  const b = new Uint8Array(64);
  b.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
  b.set([...'WAVE'].map((c) => c.charCodeAt(0)), 8);
  wavSeed += 1;
  b[60] = wavSeed & 0xff;
  return b.buffer;
}

function buffer(frames: number): AudioBuffer {
  const data = new Float32Array(frames);
  return {
    length: frames,
    numberOfChannels: 1,
    sampleRate: SR,
    getChannelData: () => data,
  } as unknown as AudioBuffer;
}

/** Selesaikan decode ke-`i` dengan materi sepanjang `frames`, lalu biarkan mikrotask jalan. */
async function finish(i: number, frames: number): Promise<void> {
  /*
   * Ditunggu dulu sampai decode-nya benar-benar TERCAPAI.
   *
   * Import menghitung SHA-256 sebelum men-decode (dedup, docs/16 §2), dan itu
   * satu langkah asinkron. Tanpa penantian ini, `pending[i]` masih kosong saat
   * tes mencoba menyelesaikannya — gagal sebagai "pending[i] is not a
   * function", yang tidak menyebut penyebabnya sama sekali.
   */
  for (let tries = 0; pending[i] === undefined && tries < 50; tries += 1) {
    await new Promise<void>((r) => setTimeout(r, 0));
  }
  pending[i]!(buffer(frames));
  // Dua putaran: satu untuk `decodeAudioData`, satu untuk jeda makro sebelum
  // `buildEnvelope` (jeda itu hanya dipasang kalau ada pendengar progres).
  await new Promise<void>((r) => setTimeout(r, 0));
  await new Promise<void>((r) => setTimeout(r, 0));
}

function clips(laneId: string): { start: number; len: number }[] {
  const lane = studioStore.getState().lanes.find((l) => l.id === laneId);
  return (lane?.clips ?? []).map((c) => ({ start: c.start, len: c.len }));
}

let laneA = '';

beforeEach(() => {
  pending.length = 0;
  wavSeed = 0;
  studioActions.__resetForTest('empty');
  laneA = studioStore.getState().lanes[0]!.id;
});

describe('penempatan clip hasil import', () => {
  it('tiga file yang berjalan BERSAMAAN tidak saling menumpuk', async () => {
    const opts = { avoidOverlap: true } as const;
    const all = [
      importBytesToLane(wav(), 'a.wav', laneA, 0, SR, opts),
      importBytesToLane(wav(), 'b.wav', laneA, 0, SR, opts),
      importBytesToLane(wav(), 'c.wav', laneA, 0, SR, opts),
    ];
    // Ketiganya sudah masuk tahap decode sebelum satu pun selesai — inilah
    // bukti bahwa jalurnya paralel, bukan antrean.
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(pending).toHaveLength(3);

    await finish(0, 4 * SR);
    await finish(1, 2 * SR);
    await finish(2, 3 * SR);
    for (const r of await Promise.all(all)) expect(r.ok).toBe(true);

    const got = clips(laneA).sort((x, y) => x.start - y.start);
    expect(got).toHaveLength(3);
    for (let i = 1; i < got.length; i += 1) {
      expect(got[i]!.start).toBeGreaterThanOrEqual(got[i - 1]!.start + got[i - 1]!.len);
    }
    // Yang pertama tetap mendarat di titik yang diminta.
    expect(got[0]!.start).toBe(0);
  });

  it('`avoidOverlap` menghormati materi yang SUDAH ada di lane', async () => {
    const first = importBytesToLane(wav(), 'a.wav', laneA, 10 * SR, SR);
    await finish(0, 5 * SR);
    expect((await first).ok).toBe(true);

    // Diminta di detik 2, tapi lane sudah terisi sampai detik 15.
    const second = importBytesToLane(wav(), 'b.wav', laneA, 2 * SR, SR, { avoidOverlap: true });
    await finish(1, SR);
    expect((await second).ok).toBe(true);

    expect(clips(laneA).map((c) => c.start).sort((x, y) => x - y)).toEqual([10 * SR, 15 * SR]);
  });

  it('tanpa opsi itu, posisi yang diminta dihormati apa adanya — termasuk kalau menumpuk', async () => {
    const first = importBytesToLane(wav(), 'a.wav', laneA, 0, SR);
    await finish(0, 5 * SR);
    await first;
    const second = importBytesToLane(wav(), 'b.wav', laneA, SR, SR);
    await finish(1, 5 * SR);
    await second;

    // Drop satu file adalah perintah yang tegas: taruh DI SINI. Perilaku ini
    // sengaja tidak ikut berubah — yang berubah hanya import ber-banyak-file.
    expect(clips(laneA).map((c) => c.start).sort((x, y) => x - y)).toEqual([0, SR]);
  });
});
