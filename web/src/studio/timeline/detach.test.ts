import { describe, expect, it, vi } from 'vitest';

/**
 * Regresi: `decodeAudioData` men-detach ArrayBuffer yang diberikan padanya.
 * Kalau buffer yang sama lalu disimpan ke IndexedDB, yang tersimpan berukuran
 * 0 — project "tersimpan" tapi audionya hilang, dan itu baru ketahuan setelah
 * refresh. Tes ini mensimulasikan detach dan memastikan byte yang disimpan
 * masih utuh.
 */
const saved: { id: number; name: string; bytes: ArrayBuffer }[] = [];

vi.mock('../persist/db', () => ({
  saveAsset: (a: { id: number; name: string; bytes: ArrayBuffer }) => {
    saved.push(a);
    return Promise.resolve(true);
  },
}));

vi.mock('../preview/audio-preview', () => ({
  ensureContext: () => ({
    sampleRate: 48_000,
    // Meniru perilaku browser: buffer yang masuk dianggap habis terpakai.
    decodeAudioData: (buf: ArrayBuffer) => {
      // jsdom tidak bisa benar-benar men-detach; tandai dengan menolak
      // pemakaian ulang lewat pencatatan identitas.
      decodedFrom.push(buf);
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

const decodedFrom: ArrayBuffer[] = [];

describe('import tidak boleh menyimpan buffer yang sudah dipakai decode', () => {
  it('byte yang disimpan BUKAN objek yang sama dengan yang di-decode', async () => {
    const { importBytesToLane } = await import('./audio-import');
    const { studioActions, studioStore } = await import('../store');
    studioActions.__resetForTest('empty');

    // WAV minimal: header RIFF/WAVE cukup untuk lolos sniff.
    const bytes = new Uint8Array(64);
    bytes.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
    bytes.set([...'WAVE'].map((c) => c.charCodeAt(0)), 8);

    const laneId = studioStore.getState().lanes[0]!.id;
    const r = await importBytesToLane(bytes.buffer, 'x.wav', laneId, 0, 48_000);
    expect(r.ok).toBe(true);

    expect(saved).toHaveLength(1);
    expect(saved[0]!.bytes.byteLength).toBe(64);
    // Inilah intinya: decode memakai SALINAN, bukan buffer yang disimpan.
    expect(decodedFrom[0]).not.toBe(saved[0]!.bytes);
  });
});
