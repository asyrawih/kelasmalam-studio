/**
 * Dedup import (L0 docs/16) dan kabar yang dikirimnya ke kepustakaan.
 *
 * Kriteria "done" fase L0 ditulis begini: *import file yang sama dua kali →
 * SATU baris di Collection, decode kedua tidak pernah jalan.* Kedua bagiannya
 * diuji di sini, dan yang kedua yang menentukan — dedup yang tetap men-decode
 * ulang menghemat satu baris daftar sambil membayar detik CPU dan puluhan MB
 * PCM kedua yang isinya identik dengan yang sudah ada di memori.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const SR = 48_000;

/** Berapa kali `decodeAudioData` benar-benar dipanggil. */
let decodeCount = 0;

vi.mock('../preview/audio-preview', () => ({
  ensureContext: () => ({
    sampleRate: SR,
    decodeAudioData: async (bytes: ArrayBuffer): Promise<AudioBuffer> => {
      decodeCount += 1;
      const frames = Math.max(1, bytes.byteLength - 44);
      return {
        length: frames,
        duration: frames / SR,
        sampleRate: SR,
        numberOfChannels: 1,
        getChannelData: () => new Float32Array(frames),
      } as unknown as AudioBuffer;
    },
  }),
  registerBuffer: () => {},
}));

// Analisis tempo memakai worker; ia tidak ada hubungannya dengan dedup.
vi.mock('../analysis/tempo-client', () => ({ requestAssetTempo: () => {} }));

import { importBytesToAsset } from './audio-import';
import { sha256Hex } from './content-hash';
import { notifyImported, registerImportSink, type ImportedForLibrary } from './import-sink';
import { studioActions, studioStore } from '../store';

/** WAV mono 8-bit — cukup untuk lolos `sniff()`. Isi berubah menurut `seed`. */
function wavBytes(seed = 1): ArrayBuffer {
  const samples = 512;
  const buf = new ArrayBuffer(44 + samples);
  const view = new DataView(buf);
  const ascii = (at: number, s: string): void => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SR, true);
  view.setUint32(28, SR, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  ascii(36, 'data');
  view.setUint32(40, samples, true);
  for (let i = 0; i < samples; i += 1) view.setUint8(44 + i, (i * seed) % 256);
  return buf;
}

const assets = () => Object.values(studioStore.getState().assets);

beforeEach(() => {
  decodeCount = 0;
  studioActions.__resetForTest?.();
  registerImportSink(null);
});

describe('contentHash', () => {
  it('berkas yang sama menghasilkan hash yang sama; yang berbeda tidak', async () => {
    const a = await sha256Hex(wavBytes(1));
    const b = await sha256Hex(wavBytes(1));
    const c = await sha256Hex(wavBytes(2));

    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('tersimpan di asset, jadi identitasnya bertahan melewati sesi', async () => {
    await importBytesToAsset(wavBytes(1), 'a.wav', SR);
    expect(assets()[0]?.contentHash).toBe(await sha256Hex(wavBytes(1)));
  });
});

describe('dedup', () => {
  it('import berkas yang SAMA dua kali → satu asset, dan decode kedua tidak jalan', async () => {
    const first = await importBytesToAsset(wavBytes(1), 'a.wav', SR);
    const second = await importBytesToAsset(wavBytes(1), 'salinan.wav', SR);

    expect(first.ok && second.ok).toBe(true);
    expect(assets()).toHaveLength(1);
    expect(decodeCount).toBe(1);
    // Pemanggil kedua tetap mendapat assetId yang bisa dipakai — yang lama.
    expect(second.ok && second.assetId).toBe(first.ok && first.assetId);
  });

  it('berkas BERBEDA tetap jadi dua asset', async () => {
    await importBytesToAsset(wavBytes(1), 'a.wav', SR);
    await importBytesToAsset(wavBytes(2), 'b.wav', SR);

    expect(assets()).toHaveLength(2);
    expect(decodeCount).toBe(2);
  });

  it('import kedua tidak mengumumkan apa-apa ke kepustakaan', async () => {
    const seen: ImportedForLibrary[] = [];
    const detach = registerImportSink((i) => seen.push(i));

    await importBytesToAsset(wavBytes(1), 'a.wav', SR);
    await importBytesToAsset(wavBytes(1), 'a.wav', SR);
    detach();

    // Kalau yang kedua ikut diumumkan, kepustakaan akan mengunggah byte yang
    // sama dua kali — dedup di server menahannya, tapi byte-nya sudah terlanjur
    // naik, dan itu justru biaya yang ingin dihindari.
    expect(seen).toHaveLength(1);
  });
});

describe('kabar ke kepustakaan', () => {
  it('membawa hash, byte, format, dan sampleRate', async () => {
    const seen: ImportedForLibrary[] = [];
    const detach = registerImportSink((i) => seen.push(i));

    const bytes = wavBytes(3);
    await importBytesToAsset(bytes, 'lagu.wav', SR);
    detach();

    expect(seen[0]).toMatchObject({ format: 'WAV', name: 'lagu.wav', sampleRate: SR });
    expect(seen[0]?.contentHash).toBe(await sha256Hex(wavBytes(3)));
    expect(seen[0]?.bytes.byteLength).toBe(bytes.byteLength);
  });

  it('byte yang diumumkan MASIH UTUH — `decodeAudioData` men-detach salinannya', async () => {
    const seen: ImportedForLibrary[] = [];
    const detach = registerImportSink((i) => seen.push(i));

    await importBytesToAsset(wavBytes(4), 'a.wav', SR);
    detach();

    // Kalau `.slice(0)` di jalur decode hilang, angka ini jadi 0 dan yang
    // terunggah adalah berkas kosong — tanpa satu pun tanda bahwa ada yang salah.
    expect(seen[0]?.bytes.byteLength).toBeGreaterThan(0);
  });

  it('sink yang melempar tidak menggagalkan import', () => {
    const detach = registerImportSink(() => {
      throw new Error('kepustakaan rusak');
    });
    expect(() =>
      notifyImported({
        contentHash: 'a'.repeat(64),
        assetId: 1,
        name: 'a',
        bytes: new ArrayBuffer(4),
        format: 'WAV',
        frames: 1,
        sampleRate: SR,
      }),
    ).not.toThrow();
    detach();
  });

  it('tanpa pendengar, import berjalan persis seperti sebelum kepustakaan ada', async () => {
    const out = await importBytesToAsset(wavBytes(5), 'a.wav', SR);
    expect(out.ok).toBe(true);
    expect(assets()).toHaveLength(1);
  });
});
