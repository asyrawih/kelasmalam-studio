import { describe, expect, it, vi } from 'vitest';

/**
 * Regresi: `decodeAudioData` men-*detach* ArrayBuffer yang diberikan padanya.
 *
 * Dulu gejalanya adalah byte berukuran 0 yang tersimpan ke IndexedDB — project
 * "tersimpan" dengan audio KOSONG, dan baru ketahuan setelah refresh.
 * Penyimpanan itu sudah dibuang, tapi invariannya TIDAK ikut hilang: buffer
 * yang diserahkan ke `importBytesToLane` adalah MILIK PEMANGGIL, dan pemanggil
 * berikutnya — jalur simpan/upload kepustakaan — akan membutuhkannya utuh.
 * Kalau `.slice(0)` di `importBytesToAsset` hilang lagi, yang diterima jalur
 * itu adalah berkas kosong tanpa satu pun tanda bahwa ada yang salah.
 */
vi.mock('../preview/audio-preview', () => ({
  ensureContext: () => ({
    sampleRate: 48_000,
    // Meniru perilaku browser: buffer yang masuk dianggap habis terpakai.
    decodeAudioData: (buf: ArrayBuffer) => {
      // jsdom tidak bisa benar-benar men-detach; tandai dengan mencatat
      // identitas buffer yang dipakai decode.
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

describe('import tidak boleh men-decode langsung dari buffer pemanggil', () => {
  it('yang di-decode adalah SALINAN, bukan ArrayBuffer yang diserahkan', async () => {
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

    expect(decodedFrom).toHaveLength(1);
    // Inilah intinya: decode memakai salinan, jadi milik pemanggil masih utuh.
    expect(decodedFrom[0]).not.toBe(bytes.buffer);
    expect(bytes.buffer.byteLength).toBe(64);
  });
});
