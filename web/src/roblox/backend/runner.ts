/**
 * Penggerak antrean: mengambil baris yang siap, mengirimnya satu per satu, dan
 * menuliskan hasilnya ke store lewat `robloxActions`.
 *
 * Ini "pemasang backend" yang dijanjikan `RobloxPage`: seluruh permukaan yang
 * dipakainya adalah `fileOf` + enam aksi lapor-balik. Tidak ada satu pun
 * komponen yang berubah untuk membuat ini bekerja.
 *
 * ## Satu per satu, bukan paralel
 *
 * Roblox membatasi unggahan audio per akun (10/bulan tanpa verifikasi ID,
 * 100/bulan dengan). Mengirim sepuluh berkas serempak tidak membuatnya lebih
 * cepat — yang dibatasi bukan bandwidth kami — tapi membuat 429 datang untuk
 * SEMUANYA sekaligus alih-alih untuk satu berkas yang bisa diulang. Berurutan
 * juga membuat progres berarti: satu bar yang bergerak, bukan sepuluh bar yang
 * masing-masing sepersepuluh kecepatan.
 *
 * ## Moderasi ditunggu dengan jeda yang MELEBAR
 *
 * Roblox menerima byte lalu memoderasinya asinkron. Menanyakannya tiap 500 ms
 * selama tiga menit adalah 360 permintaan yang hampir semuanya menjawab "belum";
 * jeda yang melebar (1s → 8s) menanyakan belasan kali untuk hasil yang sama.
 */

import { fileOf, robloxActions, robloxStore } from '../store';
import type { QueueItem } from '../model';
import { UploadError, type Transport } from './transport';

export interface RunnerOptions {
  /** Jeda pertama antar-tanya. Melebar dua kali lipat sampai `maxPollMs`. */
  readonly firstPollMs?: number;
  readonly maxPollMs?: number;
  /** Batas menunggu moderasi satu berkas. */
  readonly moderationTimeoutMs?: number;
  /** Disuntik di tes supaya tidak ada yang benar-benar menunggu. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Percobaan maksimum untuk kegagalan yang dipastikan terjadi sebelum seluruh byte terkirim. */
  readonly uploadAttempts?: number;
  /** Jeda awal retry upload; percobaan berikutnya memakai backoff 2x. */
  readonly uploadRetryMs?: number;
  /** Dipanggil setelah moderasi approved; kegagalan katalog tidak menggagalkan upload. */
  readonly onApproved?: (item: QueueItem, assetId: string, target: ReturnType<typeof robloxStore.getState>['target']) => Promise<void> | void;
}

export interface Runner {
  /** Kirim baris-baris ini. Aman dipanggil dua kali: yang kedua diabaikan
   *  selama yang pertama belum selesai. */
  run(items: readonly QueueItem[]): void;
  /** Lanjutkan polling item yang byte-nya sudah diterima Roblox. */
  resume?(items: readonly QueueItem[]): void;
  /** Untuk tes: janji yang selesai saat antrean berhenti berjalan. */
  readonly idle: () => Promise<void>;
}

const DEFAULTS = {
  firstPollMs: 1_000,
  maxPollMs: 8_000,
  moderationTimeoutMs: 5 * 60_000,
  uploadAttempts: 3,
  uploadRetryMs: 750,
};

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createRunner(transport: Transport, opts: RunnerOptions = {}): Runner {
  const firstPollMs = opts.firstPollMs ?? DEFAULTS.firstPollMs;
  const maxPollMs = opts.maxPollMs ?? DEFAULTS.maxPollMs;
  const moderationTimeoutMs = opts.moderationTimeoutMs ?? DEFAULTS.moderationTimeoutMs;
  const uploadAttempts = Math.max(1, opts.uploadAttempts ?? DEFAULTS.uploadAttempts);
  const uploadRetryMs = Math.max(0, opts.uploadRetryMs ?? DEFAULTS.uploadRetryMs);
  const sleep = opts.sleep ?? wait;
  const now = opts.now ?? (() => Date.now());

  let running: Promise<void> | null = null;

  async function approved(item: QueueItem, assetId: string, target: ReturnType<typeof robloxStore.getState>['target']): Promise<void> {
    robloxActions.markDone(item.id, assetId);
    try {
      await opts.onApproved?.(item, assetId, target);
    } catch {
      // Upload tetap sukses. Katalog bisa dimuat ulang/diimpor tanpa membakar kuota upload.
    }
  }

  async function drive(items: readonly QueueItem[]): Promise<void> {
    robloxActions.markQueued(items.map((it) => it.id));

    for (const item of items) {
      // Target dibaca ULANG per berkas dari store, bukan ditangkap sekali di
      // awal: antrean panjang berjalan menit-menitan, dan kunci yang diganti
      // di tengah jalan harus berlaku untuk sisanya.
      const target = robloxStore.getState().target;
      const file = fileOf(item.id);

      if (file === undefined) {
        // Barisnya dihapus user setelah tombol ditekan. Bukan galat: hanya
        // tidak ada lagi yang perlu dikirim.
        continue;
      }

      robloxActions.markUploading(item.id);

      try {
        const started = await uploadWithSafeRetry(item, file, target);

        if (started.moderationState === 'rejected') {
          throw new UploadError('MODERASI_DITOLAK', 'Roblox menolak audio ini saat moderasi');
        }
        if (
          started.done &&
          started.assetId !== null &&
          started.moderationState === 'approved'
        ) {
          await approved(item, started.assetId, target);
          continue;
        }

        robloxActions.markProcessing(item.id, started.operationId);
        const assetId = await awaitModeration(started.operationId, target.apiKey);
        await approved(item, assetId, target);
      } catch (err: unknown) {
        robloxActions.markFailed(item.id, messageOf(err));
      }
    }
  }

  async function uploadWithSafeRetry(
    item: QueueItem,
    file: File,
    target: ReturnType<typeof robloxStore.getState>['target'],
  ) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await transport.upload(item, file, target, (pct) => {
          robloxActions.markProgress(item.id, pct);
        });
      } catch (err: unknown) {
        const canRetry = err instanceof UploadError && err.retryable && attempt < uploadAttempts;
        if (!canRetry) throw err;
        await sleep(uploadRetryMs * 2 ** (attempt - 1));
        robloxActions.markUploading(item.id);
      }
    }
  }

  async function resumeModeration(items: readonly QueueItem[]): Promise<void> {
    for (const item of items) {
      if (item.status !== 'processing' || typeof item.operationId !== 'string') continue;
      try {
        const target = robloxStore.getState().target;
        const assetId = await awaitModeration(item.operationId, target.apiKey);
        await approved(item, assetId, target);
      } catch (err: unknown) {
        robloxActions.markFailed(item.id, messageOf(err));
      }
    }
  }

  async function awaitModeration(operationId: string, apiKey: string): Promise<string> {
    const deadline = now() + moderationTimeoutMs;
    let delay = firstPollMs;

    for (;;) {
      await sleep(delay);
      const state = await transport.operation(operationId, apiKey);
      if (state.moderationState === 'rejected') {
        throw new UploadError('MODERASI_DITOLAK', 'Roblox menolak audio ini saat moderasi');
      }
      if (state.moderationState === 'approved') {
        if (state.assetId === null) {
          throw new UploadError(
            'TANPA_ASSET_ID',
            'Roblox menyatakan selesai tapi tidak menyebut asset id-nya',
          );
        }
        return state.assetId;
      }
      if (state.done && state.moderationState == null) {
        throw new UploadError(
          'STATUS_MODERASI_TIDAK_ADA',
          'Roblox selesai membuat asset tetapi tidak memberikan status moderasi — periksa Creator Hub',
        );
      }
      if (now() >= deadline) {
        /*
         * Menyerah MENUNGGU, bukan menyatakan gagal mengunggah — dan bedanya
         * penting: byte-nya sudah di Roblox, dan asset-nya mungkin muncul lima
         * menit lagi. Pesan yang bilang "gagal" akan membuat user mengunggah
         * ulang berkas yang sama dan memakan kuota bulanannya dua kali.
         */
        throw new UploadError(
          'MODERASI_LAMA',
          `Roblox belum selesai memoderasi setelah ${Math.round(moderationTimeoutMs / 60_000)} menit — ` +
            `berkasnya sudah terkirim, periksa di Creator Hub sebelum mengulang (operasi ${operationId})`,
        );
      }
      delay = Math.min(delay * 2, maxPollMs);
    }
  }

  return {
    run(items) {
      if (running !== null || items.length === 0) return;
      running = drive(items).finally(() => {
        running = null;
      });
    },
    resume(items) {
      if (running !== null || items.length === 0) return;
      running = resumeModeration(items).finally(() => { running = null; });
    },
    idle: async () => {
      await running;
    },
  };
}

/** Pesan yang layak dibaca user, dari apa pun yang dilempar. */
function messageOf(err: unknown): string {
  if (err instanceof UploadError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
