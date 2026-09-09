/**
 * Tes sisi main-thread analisis tempo.
 *
 * Yang dijaga di sini semuanya soal MEMORI, dan tidak satu pun terlihat dari
 * hasilnya (BPM tetap benar dengan atau tanpa ini):
 *
 *   1. PCM disalin lewat `copyFromChannel`, bukan `getChannelData` — yang di
 *      Gecko memindahkan seluruh audio asset ke heap JS dan menahannya di sana
 *      (`AudioBuffer::mJSChannels`) selama buffer-nya hidup.
 *   2. Satu asset dikirim pada satu waktu. Empat stem yang di-drop bersamaan
 *      pernah berarti empat salinan PCM penuh mengantre sekaligus di worker.
 *
 * Snapshot memori dari produksi yang memicu tes ini: 6 × 304,9 MiB
 * ArrayBuffer, semuanya berakar di `mJSChannels[i]` — tiga stem stereo
 * 27,75 menit.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetTempoClientForTest, requestAssetTempo } from './tempo-client';

interface Sent {
  msg: { type: string; id: number; left: ArrayBuffer; right: ArrayBuffer | null; sampleRate: number };
  transfer: Transferable[];
}

const sent: Sent[] = [];
let workers = 0;
let lastWorker: FakeWorker | null = null;

class FakeWorker {
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  onerror: ((ev: ErrorEvent) => unknown) | null = null;

  constructor() {
    workers++;
    lastWorker = this;
  }

  postMessage(msg: Sent['msg'], transfer: Transferable[] = []): void {
    sent.push({ msg, transfer });
  }

  terminate(): void {}

  /** Balas hasil untuk `id`, seperti worker sungguhan. */
  reply(id: number): void {
    this.onmessage?.({
      data: { type: 'tempo-result', id, tempo: { bpm: 128, confidence: 0.9, beatOffsetSec: 0 } },
    } as MessageEvent);
  }

  fail(id: number): void {
    this.onmessage?.({ data: { type: 'tempo-error', id, message: 'gagal' } } as MessageEvent);
  }
}

/** `AudioBuffer` palsu yang mencatat cara channel-nya dibaca. */
function fakeBuffer(frames: number, channels = 2) {
  const getChannelDataCalls: number[] = [];
  const copyFromChannelCalls: number[] = [];
  const data = Array.from({ length: channels }, (_, c) =>
    Float32Array.from({ length: frames }, (_, i) => c * 1000 + i),
  );
  const buffer = {
    numberOfChannels: channels,
    length: frames,
    sampleRate: 48_000,
    getChannelData(c: number): Float32Array {
      getChannelDataCalls.push(c);
      return data[c] as Float32Array;
    },
    copyFromChannel(dest: Float32Array, c: number, offset = 0): void {
      copyFromChannelCalls.push(c);
      dest.set((data[c] as Float32Array).subarray(offset, offset + dest.length));
    },
  } as unknown as AudioBuffer;
  return { buffer, getChannelDataCalls, copyFromChannelCalls, data };
}

beforeEach(() => {
  sent.length = 0;
  workers = 0;
  lastWorker = null;
  __resetTempoClientForTest();
  vi.stubGlobal('Worker', FakeWorker);
});

describe('requestAssetTempo', () => {
  it('menyalin lewat copyFromChannel, tidak pernah lewat getChannelData', () => {
    const f = fakeBuffer(8);
    requestAssetTempo(1, f.buffer);

    expect(f.copyFromChannelCalls).toEqual([0, 1]);
    expect(f.getChannelDataCalls).toEqual([]);
    expect([...new Float32Array(sent[0]!.msg.left)]).toEqual([...f.data[0]!]);
    expect([...new Float32Array(sent[0]!.msg.right!)]).toEqual([...f.data[1]!]);
  });

  it('mentransfer salinannya, bukan penyimpanan milik AudioBuffer', () => {
    const f = fakeBuffer(8);
    requestAssetTempo(1, f.buffer);

    const transferred = sent[0]!.transfer;
    expect(transferred).toHaveLength(2);
    // Yang ditransfer TIDAK boleh buffer milik cache preview: buffer yang
    // ditransfer jadi detached, dan audio yang baru di-import berhenti berbunyi.
    expect(transferred).not.toContain(f.data[0]!.buffer);
    expect(transferred).not.toContain(f.data[1]!.buffer);
  });

  it('mengirim SATU asset pada satu waktu, sisanya menunggu giliran', () => {
    requestAssetTempo(1, fakeBuffer(8).buffer);
    requestAssetTempo(2, fakeBuffer(8).buffer);
    requestAssetTempo(3, fakeBuffer(8).buffer);

    // Inilah intinya: tiga file di-drop bersamaan, tapi hanya satu salinan PCM
    // yang berwujud.
    expect(sent.map((s) => s.msg.id)).toEqual([1]);

    lastWorker!.reply(1);
    expect(sent.map((s) => s.msg.id)).toEqual([1, 2]);

    lastWorker!.reply(2);
    expect(sent.map((s) => s.msg.id)).toEqual([1, 2, 3]);

    lastWorker!.reply(3);
    expect(sent.map((s) => s.msg.id)).toEqual([1, 2, 3]);
  });

  it('kegagalan satu asset tidak menghentikan antrean', () => {
    requestAssetTempo(1, fakeBuffer(8).buffer);
    requestAssetTempo(2, fakeBuffer(8).buffer);

    lastWorker!.fail(1);
    expect(sent.map((s) => s.msg.id)).toEqual([1, 2]);
  });

  it('worker yang mati juga tidak menggantung antrean', () => {
    requestAssetTempo(1, fakeBuffer(8).buffer);
    requestAssetTempo(2, fakeBuffer(8).buffer);

    lastWorker!.onerror?.({ message: 'worker mati' } as ErrorEvent);
    expect(sent.map((s) => s.msg.id)).toEqual([1, 2]);
  });

  it('asset yang sama tidak dianalisis dua kali', () => {
    const f = fakeBuffer(8);
    requestAssetTempo(1, f.buffer);
    requestAssetTempo(1, f.buffer);

    expect(sent.map((s) => s.msg.id)).toEqual([1]);
    expect(workers).toBe(1);
  });

  it('mono: tidak mengarang channel kanan', () => {
    const f = fakeBuffer(8, 1);
    requestAssetTempo(1, f.buffer);

    expect(sent[0]!.msg.right).toBeNull();
    expect(sent[0]!.transfer).toHaveLength(1);
    expect(f.copyFromChannelCalls).toEqual([0]);
  });

  it('jatuh ke getChannelData kalau copyFromChannel tidak ada', () => {
    const f = fakeBuffer(8, 1);
    const noCopy = { ...(f.buffer as unknown as object) } as Record<string, unknown>;
    noCopy['copyFromChannel'] = undefined;
    noCopy['getChannelData'] = f.buffer.getChannelData.bind(f.buffer);

    requestAssetTempo(9, noCopy as unknown as AudioBuffer);

    expect(f.getChannelDataCalls).toEqual([0]);
    expect([...new Float32Array(sent[0]!.msg.left)]).toEqual([...f.data[0]!]);
  });
});
