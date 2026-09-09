/**
 * Tes sisi main thread dari worker export — dengan `Worker` palsu.
 *
 * Worker sungguhannya tidak bisa dijalankan di jsdom (ia meng-instantiate modul
 * WASM), dan itu bukan kehilangan: yang bisa salah di lapisan ini bukan DSP-nya
 * — itu `runExport`, yang dites dengan engine palsu DAN dengan engine sungguhan
 * di `wasm-integration.test.ts`. Yang bisa salah di sini adalah plumbing-nya:
 *
 *   - urutan byte yang sampai ke sink,
 *   - potongan PCM yang DISALIN sebelum di-transfer (kalau tidak, buffer antara
 *     milik sumber jadi detached dan sisa export senyap tanpa satu pun error),
 *   - `terminate()` di SEMUA jalur — itu satu-satunya langkah yang benar-benar
 *     mengembalikan memori export ke sistem operasi,
 *   - kegagalan sebelum byte pertama boleh diulang di main thread, sesudahnya
 *     tidak.
 *
 * `postMessage` palsu di sini memakai `structuredClone(msg, { transfer })` —
 * jadi transfer benar-benar men-DETACH buffer-nya, sama seperti di browser.
 * Tanpa itu, bug "buffer antara ikut ditransfer" akan lolos diam-diam.
 */
import { describe, expect, it, vi } from 'vitest';

import { audioBufferPcmSource, type ExportPayload } from './payload';
import { ExportCancelled } from './run-export';
import { BlobSink } from './sinks';
import { ExportWorkerUnavailable, runExportInWorker } from './worker-host';

type Msg = Record<string, unknown> & { type: string };

class FakeWorker {
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  onerror: ((ev: ErrorEvent) => unknown) | null = null;
  /** Pesan yang diterima worker, SESUDAH structured clone + transfer. */
  readonly received: Msg[] = [];
  terminated = 0;

  postMessage(msg: Msg, transfer?: Transferable[]): void {
    // Transfer sungguhan: buffer di sisi pengirim jadi detached.
    this.received.push(structuredClone(msg, { transfer: transfer ?? [] }) as Msg);
  }

  terminate(): void {
    this.terminated++;
  }

  /** Kirim satu pesan dari worker ke main thread. */
  emit(msg: Msg, transfer: Transferable[] = []): Promise<void> {
    this.onmessage?.({ data: structuredClone(msg, { transfer }) } as MessageEvent);
    // Handler-nya async; beri kesempatan rantai tulisannya selesai.
    return Promise.resolve();
  }

  as(): Worker {
    return this as unknown as Worker;
  }
}

const PAYLOAD: ExportPayload = {
  json: '{}',
  assets: [{ assetId: 0, channels: 2, frames: 8, sampleRate: 48_000 }],
  endSample: 8,
};

const bytes = (...v: number[]): ArrayBuffer => Uint8Array.from(v).buffer;

/** Tunggu sampai antrean microtask kosong (rantai tulisan ke sink selesai). */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

function start(o: {
  worker: FakeWorker;
  sink?: BlobSink;
  pcm?: Parameters<typeof runExportInWorker>[0]['pcm'];
  isCancelled?: () => boolean;
  onProgress?: (f: number) => void;
}): { done: Promise<unknown>; sink: BlobSink } {
  const sink = o.sink ?? new BlobSink();
  const done = runExportInWorker({
    payload: PAYLOAD,
    pcm: o.pcm ?? (() => new Float32Array(4)),
    sink,
    sampleRate: 48_000,
    format: 'wav',
    bitDepth: 16,
    isCancelled: o.isCancelled,
    onProgress: o.onProgress,
    createWorker: () => o.worker.as(),
  });
  // Jangan biarkan penolakan jadi unhandled sebelum tes sempat menunggunya.
  done.catch(() => undefined);
  return { done, sink };
}

describe('runExportInWorker', () => {
  it('mengirim start, menyalurkan byte ke sink berurutan, lalu terminate', async () => {
    const w = new FakeWorker();
    const { done, sink } = start({ worker: w });
    await settle();

    expect(w.received[0]).toMatchObject({ type: 'start', sampleRate: 48_000, format: 'wav' });

    await w.emit({ type: 'header', buffer: bytes(1, 1, 1, 1) });
    await w.emit({ type: 'chunk', buffer: bytes(2, 2) });
    await w.emit({ type: 'chunk', buffer: bytes(3, 3) });
    await w.emit({ type: 'patch-header', buffer: bytes(9, 9, 9, 9) });
    await w.emit({ type: 'done', mime: 'audio/wav', frames: 8, warnings: [] });
    const result = await done;
    await settle();

    expect(result).toEqual({ warnings: [], frames: 8, analysis: null });
    expect([...sink.bytes()]).toEqual([9, 9, 9, 9, 2, 2, 3, 3]);
    expect(w.terminated).toBe(1);
  });

  it('MENYALIN potongan PCM sebelum mentransfernya — buffer antara sumber tetap hidup', async () => {
    // Sumber sungguhan: satu buffer antara dipakai ulang untuk semua potongan.
    // Kalau host mentransfer buffer itu apa adanya, potongan kedua akan kosong.
    const data = [Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8])];
    const buffer = {
      numberOfChannels: 1,
      length: 8,
      sampleRate: 48_000,
      getChannelData: (c: number) => data[c] as Float32Array,
      copyFromChannel: (dest: Float32Array, c: number, offset = 0): void => {
        dest.set((data[c] as Float32Array).subarray(offset, offset + dest.length));
      },
    } as unknown as AudioBuffer;

    const w = new FakeWorker();
    const { done } = start({
      worker: w,
      pcm: audioBufferPcmSource(
        () => buffer,
        (d) => d,
      ),
    });
    await settle();

    await w.emit({ type: 'pcm-request', id: 1, assetId: 0, channel: 0, offset: 0, maxFrames: 4 });
    await settle();
    await w.emit({ type: 'pcm-request', id: 2, assetId: 0, channel: 0, offset: 4, maxFrames: 4 });
    await settle();

    const chunks = w.received.filter((m) => m.type === 'pcm-chunk');
    expect(chunks).toHaveLength(2);
    expect([...new Float32Array(chunks[0]!['buffer'] as ArrayBuffer)]).toEqual([1, 2, 3, 4]);
    // Inilah yang gagal kalau `slice()` di host dihapus: potongan kedua kosong.
    expect([...new Float32Array(chunks[1]!['buffer'] as ArrayBuffer)]).toEqual([5, 6, 7, 8]);

    await w.emit({ type: 'done', mime: 'audio/wav', frames: 8, warnings: [] });
    await done;
  });

  it('meneruskan kegagalan sumber PCM ke worker, bukan menggantungnya', async () => {
    const w = new FakeWorker();
    const { done } = start({
      worker: w,
      pcm: () => {
        throw new Error('cache preview dibuang');
      },
    });
    await settle();

    await w.emit({ type: 'pcm-request', id: 7, assetId: 0, channel: 0, offset: 0, maxFrames: 4 });
    await settle();

    expect(w.received.at(-1)).toMatchObject({
      type: 'pcm-error',
      id: 7,
      message: 'cache preview dibuang',
    });

    await w.emit({ type: 'error', message: 'cache preview dibuang' });
    await expect(done).rejects.toThrow(/cache preview dibuang/);
  });

  it('asset yang tidak ada di payload dijawab pcm-error, bukan chunk kosong', async () => {
    const w = new FakeWorker();
    const { done } = start({ worker: w });
    await settle();

    await w.emit({ type: 'pcm-request', id: 3, assetId: 42, channel: 0, offset: 0, maxFrames: 4 });
    await settle();

    expect(w.received.at(-1)).toMatchObject({ type: 'pcm-error', id: 3 });
    await w.emit({ type: 'error', message: 'berhenti' });
    await expect(done).rejects.toThrow();
  });

  it('gagal SEBELUM byte pertama = boleh diulang di main thread', async () => {
    const w = new FakeWorker();
    const { done, sink } = start({ worker: w });
    await settle();

    await w.emit({ type: 'error', message: 'lamejs tidak bisa dimuat di worker' });

    await expect(done).rejects.toBeInstanceOf(ExportWorkerUnavailable);
    expect(w.terminated).toBe(1);
    // Sink TIDAK di-abort: pemanggil akan memakainya lagi untuk render ulang di
    // main thread. Meng-abort di sini membuat jalur cadangan menulis ke berkas
    // yang sudah dibuang — dan gejalanya baru muncul di ujung, sebagai export
    // yang gagal padahal rendernya berhasil.
    sink.chunk(Uint8Array.from([7, 7]));
    expect([...sink.bytes()]).toEqual([7, 7]);
    expect(() => sink.blob('audio/wav')).not.toThrow();
  });

  it('gagal SESUDAH byte pertama = TIDAK boleh diulang', async () => {
    const w = new FakeWorker();
    const { done, sink } = start({ worker: w });
    await settle();

    await w.emit({ type: 'chunk', buffer: bytes(1, 2, 3) });
    await settle();
    await w.emit({ type: 'error', message: 'disk penuh' });

    const err = await done.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ExportWorkerUnavailable);
    // Sink dibatalkan: berkas separuh jadi tidak boleh bisa diambil.
    expect(() => sink.blob('audio/wav')).toThrow();
    expect(w.terminated).toBe(1);
  });

  it('worker yang gagal dimuat sama sekali juga boleh diulang', async () => {
    const w = new FakeWorker();
    const { done } = start({ worker: w });
    await settle();

    w.onerror?.({ message: 'Failed to fetch module' } as ErrorEvent);

    await expect(done).rejects.toBeInstanceOf(ExportWorkerUnavailable);
    expect(w.terminated).toBe(1);
  });

  it('pembatalan: membuang isi sink, melempar ExportCancelled, tetap terminate', async () => {
    const w = new FakeWorker();
    const { done, sink } = start({ worker: w });
    await settle();

    await w.emit({ type: 'chunk', buffer: bytes(1, 2) });
    await settle();
    await w.emit({ type: 'cancelled' });

    await expect(done).rejects.toBeInstanceOf(ExportCancelled);
    expect(() => sink.blob('audio/wav')).toThrow();
    expect(w.terminated).toBe(1);
  });

  it('meneruskan permintaan batal ke worker saat progress dibaca', async () => {
    const w = new FakeWorker();
    const onProgress = vi.fn();
    let cancel = false;
    const { done } = start({ worker: w, isCancelled: () => cancel, onProgress });
    await settle();

    await w.emit({ type: 'progress', fraction01: 0.25 });
    expect(onProgress).toHaveBeenCalledWith(0.25);
    expect(w.received.some((m) => m.type === 'cancel')).toBe(false);

    cancel = true;
    await w.emit({ type: 'progress', fraction01: 0.5 });
    expect(w.received.at(-1)).toMatchObject({ type: 'cancel' });

    await w.emit({ type: 'cancelled' });
    await expect(done).rejects.toBeInstanceOf(ExportCancelled);
  });
});
