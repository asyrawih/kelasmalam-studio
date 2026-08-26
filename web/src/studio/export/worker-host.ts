/**
 * Sisi main thread dari `audio/export-worker.ts`.
 *
 * Pembagian tugasnya: worker merender dan meng-encode, main thread MEMILIKI
 * tujuan berkasnya (`ExportSink`) dan PCM-nya. Worker tidak pernah memegang
 * satu pun dari keduanya lebih lama dari satu potong.
 *
 * # Kenapa ini ada sama sekali
 *
 * Bukan demi UI yang tidak membeku — itu bonus. Alasannya: **linear memory wasm
 * tidak pernah menyusut.** Render menaruh seluruh PCM project di sana, dan
 * membebaskannya sesudah selesai hanya mengembalikannya ke alokator DI DALAM
 * wasm; halaman yang sudah tumbuh tetap dipegang instance itu sampai
 * instance-nya hilang. Selama export berjalan di instance main thread, satu
 * export besar berarti tab menahan ratusan MiB sampai di-reload — persis
 * gejala "sesudah export selesai, memori tidak dibersihkan".
 *
 * Worker memberi jalan keluar yang tidak dimiliki main thread: `terminate()`.
 * Instance-nya hilang, memory-nya hilang, dan yang kembali ke sistem operasi
 * bukan cuma PCM-nya melainkan seluruh runtime export. Itu sebabnya
 * `terminate()` di sini ada di `finally` — bukan hanya di jalur sukses.
 *
 * Syaratnya worker memakai varian `st` (memory sendiri); lihat catatan panjang
 * di `audio/export-worker.ts`.
 */

import type { ExportAssetInfo, ExportAssetSource, ExportPayload } from './payload';
import { ExportCancelled, type ExportResult } from './run-export';
import type { ExportSink } from './sinks';
import type { LoudnessAnalysis } from './loudness-analyzer';

/**
 * Worker tidak bisa dipakai — dan **belum satu byte pun ditulis** ke sink.
 *
 * Dibedakan supaya pemanggil boleh mengulang di main thread. Batas "belum satu
 * byte pun" itu yang membuatnya aman: mengulang sesudah sebagian file ditulis
 * akan menghasilkan berkas yang isinya dua export yang disambung.
 */
export class ExportWorkerUnavailable extends Error {
  readonly workerUnavailable = true;
  constructor(cause: string) {
    super(`Worker export tidak bisa dipakai: ${cause}`);
    this.name = 'ExportWorkerUnavailable';
  }
}

export interface WorkerExportOptions {
  readonly payload: ExportPayload;
  /** Sumber PCM di main thread; potongannya disalin lalu di-transfer. */
  readonly pcm: ExportAssetSource;
  readonly sampleRate: number;
  readonly format: 'wav' | 'flac' | 'mp3' | 'ogg';
  readonly bitDepth: 16 | 24 | 32;
  readonly quality?: number;
  readonly analyze?: boolean;
  readonly analysisOnly?: boolean;
  readonly gainDb?: number;
  /** Tujuan byte-nya. Main thread yang memilikinya, bukan worker. */
  readonly sink: ExportSink;
  readonly onProgress?: (fraction01: number) => void;
  readonly onWarnings?: (warnings: readonly string[]) => void;
  /** Dibaca tiap progress (≤1 batch telat), lalu diteruskan sebagai pesan. */
  readonly isCancelled?: () => boolean;
  /** Disuntik oleh tes; produksi memakai worker sungguhan. */
  readonly createWorker?: () => Worker;
}

/** Apakah lingkungan ini punya `Worker` sama sekali (jsdom: tidak). */
export function canRunExportInWorker(): boolean {
  return typeof Worker !== 'undefined';
}

function defaultWorker(): Worker {
  return new Worker(new URL('../../audio/export-worker.ts', import.meta.url), {
    type: 'module',
    name: 'daw-export',
  });
}

type FromWorker =
  | { type: 'pcm-request'; id: number; assetId: number; channel: number; offset: number; maxFrames: number }
  | { type: 'header'; buffer: ArrayBuffer }
  | { type: 'chunk'; buffer: ArrayBuffer }
  | { type: 'patch-header'; buffer: ArrayBuffer }
  | { type: 'progress'; fraction01: number }
  | { type: 'warnings'; warnings: string[] }
  | { type: 'done'; mime: string; frames: number; warnings: string[]; analysis?: LoudnessAnalysis | null }
  | { type: 'cancelled' }
  | { type: 'error'; message: string };

export async function runExportInWorker(o: WorkerExportOptions): Promise<ExportResult> {
  const worker = (o.createWorker ?? defaultWorker)();
  const assets = new Map<number, ExportAssetInfo>();
  for (const a of o.payload.assets) assets.set(a.assetId, a);

  /** Sudah ada byte yang sampai ke sink? Menentukan boleh-tidaknya diulang. */
  let wrote = false;
  let settled = false;

  /**
   * Tulisan ke sink DIURUTKAN lewat satu rantai promise.
   *
   * `onmessage` di bawah `async`, jadi pesan berikutnya bisa mulai diproses
   * saat yang sebelumnya masih menunggu `write()`. Untuk aliran byte, dua
   * penulisan yang saling menyalip bukan sekadar keanehan — ia menukar isi
   * file, dan hasilnya berkas yang panjangnya benar tapi datanya teracak.
   */
  let writes: Promise<unknown> = Promise.resolve();
  const enqueue = (fn: () => Promise<void> | void): Promise<void> => {
    writes = writes.then(fn);
    return writes as Promise<void>;
  };

  try {
    return await new Promise<ExportResult>((resolve, reject) => {
      const fail = (e: unknown): void => {
        if (settled) return;
        settled = true;
        reject(e);
      };

      worker.onerror = (e: ErrorEvent): void => {
        // Gagal memuat/menjalankan modul worker sama sekali. Selama belum ada
        // byte yang ditulis, ini masih bisa diselamatkan di main thread.
        const msg = e.message || 'worker gagal dimuat';
        fail(wrote ? new Error(msg) : new ExportWorkerUnavailable(msg));
      };

      worker.onmessage = async (ev: MessageEvent): Promise<void> => {
        const m = ev.data as FromWorker;
        try {
          switch (m.type) {
            case 'pcm-request': {
              // Batal juga dibaca di sini, bukan cuma saat progress: pendaftaran
              // asset project besar bisa berjalan beberapa detik SEBELUM batch
              // pertama, dan selama itu tidak ada satu pun pesan progress.
              // Flag-nya baru terbaca worker di batch pertama, tapi setidaknya
              // ia sudah sampai.
              if (o.isCancelled?.()) worker.postMessage({ type: 'cancel' });
              const asset = assets.get(m.assetId);
              if (asset === undefined) {
                worker.postMessage({
                  type: 'pcm-error',
                  id: m.id,
                  message: `asset ${m.assetId} tidak ada di payload`,
                });
                return;
              }
              let chunk: Float32Array;
              try {
                chunk = await o.pcm({
                  asset,
                  channel: m.channel,
                  offset: m.offset,
                  maxFrames: m.maxFrames,
                });
              } catch (e: unknown) {
                worker.postMessage({
                  type: 'pcm-error',
                  id: m.id,
                  message: e instanceof Error ? e.message : String(e),
                });
                return;
              }
              // `slice()` WAJIB, dan bukan demi kerapian: buffer yang
              // di-transfer menjadi DETACHED di sisi pengirim. Sumber PCM
              // memakai satu buffer antara berulang-ulang (lihat
              // `audioBufferPcmSource`), jadi mentransfer buffer aslinya akan
              // membuat potongan KEDUA dan seterusnya berukuran nol — export
              // yang senyap mulai dari detik kedua, tanpa satu pun error.
              const copy = chunk.slice();
              worker.postMessage({ type: 'pcm-chunk', id: m.id, buffer: copy.buffer }, [
                copy.buffer,
              ]);
              return;
            }
            case 'header':
              wrote = true;
              await enqueue(() => o.sink.header(new Uint8Array(m.buffer)));
              return;
            case 'chunk':
              wrote = true;
              await enqueue(() => o.sink.chunk(new Uint8Array(m.buffer)));
              return;
            case 'patch-header':
              await enqueue(() => o.sink.patchHeader(new Uint8Array(m.buffer)));
              return;
            case 'progress':
              o.onProgress?.(m.fraction01);
              // Batal dibaca DI SINI, bukan lewat polling terpisah: progress
              // datang sekali per batch, dan itu resolusi yang sama dengan
              // yang dijanjikan jalur main thread.
              if (o.isCancelled?.()) worker.postMessage({ type: 'cancel' });
              return;
            case 'warnings':
              o.onWarnings?.(m.warnings);
              return;
            case 'done':
              await enqueue(() => o.sink.close());
              if (!settled) {
                settled = true;
                resolve({ warnings: m.warnings, frames: m.frames, analysis: m.analysis ?? null });
              }
              return;
            case 'cancelled':
              // Buang yang sudah ditulis. Berkas separuh jadi di disk yang
              // tidak pernah diberi header final adalah hasil paling
              // membingungkan dari sebuah pembatalan.
              await enqueue(() => o.sink.abort('cancelled'));
              fail(new ExportCancelled());
              return;
            case 'error':
              // HANYA kalau sudah ada byte yang ditulis. Kalau belum, sink-nya
              // masih perawan dan pemanggil boleh memakainya lagi untuk jalur
              // cadangan di main thread — meng-abort di sini akan menutup
              // writable-nya, dan render ulang berikutnya menulis ke berkas
              // yang sudah dibuang.
              if (wrote) await enqueue(() => o.sink.abort(m.message));
              fail(wrote ? new Error(m.message) : new ExportWorkerUnavailable(m.message));
              return;
          }
        } catch (e: unknown) {
          // Kegagalan menulis ke sink (disk penuh, izin dicabut). Aslinya yang
          // menang; worker dihentikan oleh `finally` di bawah.
          fail(e);
        }
      };

      worker.postMessage({
        type: 'start',
        payload: o.payload,
        sampleRate: o.sampleRate,
        format: o.format,
        bitDepth: o.bitDepth,
        quality: o.quality,
        analyze: o.analyze,
        analysisOnly: o.analysisOnly,
        gainDb: o.gainDb,
      });
    });
  } finally {
    // SELALU — sukses, gagal, maupun batal. Ini satu-satunya langkah yang
    // benar-benar mengembalikan linear memory export ke sistem operasi;
    // melewatkannya di salah satu jalur berarti kebocoran yang hanya muncul
    // di jalur itu.
    worker.terminate();
  }
}
