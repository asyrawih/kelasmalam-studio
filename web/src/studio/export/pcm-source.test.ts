/**
 * Tes sumber PCM export.
 *
 * Yang dijaga di sini bukan "datanya benar" saja — itu bagian yang mudah — tapi
 * BAGAIMANA datanya diambil. Dua sifat yang seluruh perbaikan memori bergantung
 * padanya, dan keduanya tidak terlihat di hasil export:
 *
 *   1. `getChannelData` TIDAK dipakai kalau `copyFromChannel` ada. Di Gecko,
 *      panggilan pertama `getChannelData` membangkitkan salinan JS penuh per
 *      channel yang menempel pada `AudioBuffer` selama ia hidup — untuk export
 *      itu berarti satu salinan permanen dari seluruh audio project.
 *   2. Buffer antaranya DIPAKAI ULANG, bukan dialokasi per potong.
 *
 * Keduanya lolos tanpa terasa kalau hanya isinya yang dicek.
 */
import { describe, expect, it } from 'vitest';

import {
  PCM_CHUNK_FRAMES,
  audioBufferPcmSource,
  pcmFromChannels,
  type ExportAssetInfo,
} from './payload';

const ASSET: ExportAssetInfo = { assetId: 0, channels: 2, frames: 10, sampleRate: 48_000 };

interface FakeBufferOpts {
  /** Sediakan `copyFromChannel`? Default ya. */
  copyFromChannel?: boolean;
}

function fakeAudioBuffer(
  channels: Float32Array[],
  o: FakeBufferOpts = {},
): { buffer: AudioBuffer; getChannelDataCalls: number[] } {
  const getChannelDataCalls: number[] = [];
  const buffer = {
    numberOfChannels: channels.length,
    length: channels[0]?.length ?? 0,
    sampleRate: 48_000,
    getChannelData(c: number): Float32Array {
      getChannelDataCalls.push(c);
      return channels[c] as Float32Array;
    },
    copyFromChannel:
      o.copyFromChannel === false
        ? undefined
        : (dest: Float32Array, c: number, offset = 0): void => {
            dest.set((channels[c] as Float32Array).subarray(offset, offset + dest.length));
          },
  } as unknown as AudioBuffer;
  return { buffer, getChannelDataCalls };
}

/** Sumber untuk satu asset dengan id padat 0 yang dipetakan ke id UI 77. */
function sourceFor(buffer: AudioBuffer) {
  return audioBufferPcmSource(
    (uiId) => (uiId === 77 ? buffer : undefined),
    (dense) => (dense === 0 ? 77 : undefined),
  );
}

const ramp = (n: number, base = 0): Float32Array =>
  Float32Array.from({ length: n }, (_, i) => base + i);

describe('audioBufferPcmSource', () => {
  it('memakai copyFromChannel dan TIDAK pernah menyentuh getChannelData', async () => {
    const { buffer, getChannelDataCalls } = fakeAudioBuffer([ramp(10), ramp(10, 100)]);
    const src = sourceFor(buffer);

    // Dibaca SEGERA, satu per satu: buffer antaranya dipakai ulang, jadi
    // memegang dua potongan sekaligus memang tidak sah — lihat tes di bawah.
    expect([...(await src({ asset: ASSET, channel: 0, offset: 0, maxFrames: 10 }))]).toEqual([
      ...ramp(10),
    ]);
    expect([...(await src({ asset: ASSET, channel: 1, offset: 0, maxFrames: 10 }))]).toEqual([
      ...ramp(10, 100),
    ]);
    expect(getChannelDataCalls).toEqual([]);
  });

  it('potongan HANYA sah sampai permintaan berikutnya — itu harga buffer yang dipakai ulang', async () => {
    const { buffer } = fakeAudioBuffer([ramp(10), ramp(10, 100)]);
    const src = sourceFor(buffer);

    const first = await src({ asset: ASSET, channel: 0, offset: 0, maxFrames: 10 });
    await src({ asset: ASSET, channel: 1, offset: 0, maxFrames: 10 });

    // Bukan bug: `first` menunjuk buffer antara yang sama, dan sekarang isinya
    // channel 1. Kontraknya "salin dulu, baru minta lagi" — `fillAsset` dan
    // `worker-host` keduanya begitu, dan tes ini yang membuatnya tetap begitu.
    expect([...first]).toEqual([...ramp(10, 100)]);
  });

  it('menyerahkan potongan sesuai offset, bukan selalu dari awal', async () => {
    const { buffer } = fakeAudioBuffer([ramp(10)]);
    const src = sourceFor(buffer);

    const a = await src({ asset: ASSET, channel: 0, offset: 4, maxFrames: 3 });
    expect([...a]).toEqual([4, 5, 6]);
  });

  it('memakai ULANG satu buffer antara — potongan berikutnya tidak mengalokasi lagi', async () => {
    const { buffer } = fakeAudioBuffer([ramp(10)]);
    const src = sourceFor(buffer);

    const a = await src({ asset: ASSET, channel: 0, offset: 0, maxFrames: 5 });
    const b = await src({ asset: ASSET, channel: 0, offset: 5, maxFrames: 5 });

    expect(a.buffer).toBe(b.buffer);
    // Dan besarnya satu potongan penuh, bukan sebesar asset: buffer antaranya
    // tidak boleh ikut tumbuh mengikuti panjang lagu.
    expect(a.buffer.byteLength).toBe(PCM_CHUNK_FRAMES * 4);
  });

  it('berhenti di ujung asset alih-alih meminta di luar batas', async () => {
    const { buffer } = fakeAudioBuffer([ramp(10)]);
    const src = sourceFor(buffer);

    const tail = await src({ asset: ASSET, channel: 0, offset: 8, maxFrames: 100 });
    expect([...tail]).toEqual([8, 9]);
    const past = await src({ asset: ASSET, channel: 0, offset: 10, maxFrames: 100 });
    expect(past.length).toBe(0);
  });

  it('jatuh ke getChannelData kalau copyFromChannel tidak ada', async () => {
    const { buffer, getChannelDataCalls } = fakeAudioBuffer([ramp(10)], {
      copyFromChannel: false,
    });
    const src = sourceFor(buffer);

    const a = await src({ asset: ASSET, channel: 0, offset: 2, maxFrames: 3 });
    expect([...a]).toEqual([2, 3, 4]);
    expect(getChannelDataCalls).toEqual([0]);
  });

  it('menyebut nama masalahnya kalau PCM hilang dari cache di tengah export', () => {
    const src = audioBufferPcmSource(
      () => undefined,
      (dense) => dense,
    );
    expect(() => src({ asset: ASSET, channel: 0, offset: 0, maxFrames: 4 })).toThrow(
      /hilang dari cache preview/,
    );
  });

  it('menolak asset yang channel-nya lebih sedikit dari yang dijanjikan payload', () => {
    const { buffer } = fakeAudioBuffer([ramp(10)]); // mono, padahal ASSET stereo
    const src = sourceFor(buffer);
    expect(() => src({ asset: ASSET, channel: 1, offset: 0, maxFrames: 4 })).toThrow(/butuh 2/);
  });
});

describe('pcmFromChannels', () => {
  it('memanggil sumbernya SEKALI per asset walau potongannya banyak', async () => {
    const asked: number[] = [];
    const src = pcmFromChannels((info) => {
      asked.push(info.assetId);
      return [ramp(10), ramp(10, 100)];
    });

    await src({ asset: ASSET, channel: 0, offset: 0, maxFrames: 4 });
    await src({ asset: ASSET, channel: 0, offset: 4, maxFrames: 4 });
    await src({ asset: ASSET, channel: 1, offset: 0, maxFrames: 4 });

    expect(asked).toEqual([0]);
  });

  it('mengembalikan view, bukan salinan', async () => {
    const l = ramp(10);
    const src = pcmFromChannels(() => [l, l]);
    const chunk = await src({ asset: ASSET, channel: 0, offset: 2, maxFrames: 4 });
    expect(chunk.buffer).toBe(l.buffer);
    expect([...chunk]).toEqual([2, 3, 4, 5]);
  });
});
