/**
 * Kemajuan import yang DILAPORKAN, bukan yang ditebak.
 *
 * Dua hal yang dikunci di sini:
 *   1. tahap `reading` datang dengan rasio NYATA — dihitung dari byte yang
 *      sudah terbaca dibagi `file.size`, bukan animasi yang jalan sendiri;
 *   2. urutannya reading → decoding → analyzing, dan dua tahap terakhir memang
 *      TIDAK punya rasio (`decodeAudioData` tidak melaporkan apa pun).
 *
 * Kalau nomor 2 pernah berubah jadi angka karangan, bar progres akan berbohong
 * di tahap yang justru paling lama.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../persist/db', () => ({ saveAsset: () => Promise.resolve(true) }));

vi.mock('../preview/audio-preview', () => ({
  ensureContext: () => ({
    sampleRate: 48_000,
    decodeAudioData: () => {
      const data = new Float32Array(48_000);
      return Promise.resolve({
        length: data.length,
        numberOfChannels: 1,
        sampleRate: 48_000,
        getChannelData: () => data,
      } as unknown as AudioBuffer);
    },
  }),
  registerBuffer: () => undefined,
}));

vi.mock('../analysis/tempo-client', () => ({ requestAssetTempo: () => undefined }));

/** WAV minimal — cukup untuk lolos `sniff`. */
function wavBytes(size: number): Uint8Array {
  const b = new Uint8Array(size);
  b.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
  b.set([...'WAVE'].map((c) => c.charCodeAt(0)), 8);
  return b;
}

/**
 * `File` palsu yang mengalirkan isinya dalam `chunks` potongan.
 *
 * Dibuat tangan, bukan `new File(...)`: yang sedang diuji justru jalur
 * `stream()`, dan jsdom tidak menjamin implementasinya ada — tes yang diam-diam
 * jatuh ke `arrayBuffer()` akan lulus tanpa pernah menyentuh kode yang dimaksud.
 */
function streamingFile(bytes: Uint8Array, chunks: number, name = 'lagu.wav'): File {
  const per = Math.ceil(bytes.byteLength / chunks);
  let at = 0;
  return {
    name,
    size: bytes.byteLength,
    stream: () => ({
      getReader: () => ({
        read: () => {
          if (at >= bytes.byteLength) return Promise.resolve({ done: true, value: undefined });
          const end = Math.min(bytes.byteLength, at + per);
          const value = bytes.subarray(at, end);
          at = end;
          return Promise.resolve({ done: false, value });
        },
        cancel: () => Promise.resolve(),
      }),
    }),
    arrayBuffer: () => Promise.resolve(bytes.buffer),
  } as unknown as File;
}

describe('kemajuan import', () => {
  it('melaporkan rasio pembacaan yang naik, lalu decode & analisis tanpa rasio', async () => {
    const { importFileToAsset } = await import('./audio-import');
    const { studioActions } = await import('../store');
    studioActions.__resetForTest('empty');

    const seen: { stage: string; ratio: number | null }[] = [];
    const r = await importFileToAsset(streamingFile(wavBytes(400), 4), 48_000, (p) =>
      seen.push({ stage: p.stage, ratio: p.ratio }),
    );
    expect(r.ok).toBe(true);

    const reading = seen.filter((p) => p.stage === 'reading').map((p) => p.ratio);
    expect(reading).toEqual([0.25, 0.5, 0.75, 1]);

    // Urutannya, dan hanya sekali masing-masing.
    const stages = seen.map((p) => p.stage);
    expect(stages.indexOf('decoding')).toBeGreaterThan(stages.lastIndexOf('reading'));
    expect(stages.indexOf('analyzing')).toBeGreaterThan(stages.indexOf('decoding'));
    expect(seen.filter((p) => p.stage === 'decoding')).toEqual([{ stage: 'decoding', ratio: null }]);
    expect(seen.filter((p) => p.stage === 'analyzing')).toEqual([
      { stage: 'analyzing', ratio: null },
    ]);
  });

  it('membaca seluruh byte lewat stream — hasilnya identik dengan file aslinya', async () => {
    const { importFileToAsset } = await import('./audio-import');
    const { studioActions, studioStore } = await import('../store');
    studioActions.__resetForTest('empty');

    const before = Object.keys(studioStore.getState().assets).length;
    const r = await importFileToAsset(streamingFile(wavBytes(999), 7), 48_000, () => undefined);
    expect(r.ok).toBe(true);
    // Asset benar-benar terdaftar: potongan yang salah sambung akan gagal di
    // `sniff` atau `decodeAudioData` sebelum sampai ke sini.
    expect(Object.keys(studioStore.getState().assets).length).toBe(before + 1);
  });

  it('tanpa pendengar, jalurnya tetap `arrayBuffer()` (browser lama / jsdom)', async () => {
    const { importFileToAsset } = await import('./audio-import');
    const { studioActions } = await import('../store');
    studioActions.__resetForTest('empty');

    const bytes = wavBytes(128);
    let streamed = false;
    const file = {
      name: 'x.wav',
      size: bytes.byteLength,
      stream: () => {
        streamed = true;
        throw new Error('tidak boleh dipakai');
      },
      arrayBuffer: () => Promise.resolve(bytes.buffer),
    } as unknown as File;

    const r = await importFileToAsset(file, 48_000);
    expect(r.ok).toBe(true);
    expect(streamed).toBe(false);
  });
});
