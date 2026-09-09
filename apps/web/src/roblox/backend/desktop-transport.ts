/**
 * `Transport` untuk DESKTOP: unggah dan poll dilakukan Rust
 * (`crates/desktop-host/src/roblox.rs`, docs/21 §1e), dan berkas ini hanya
 * memetakan tiga method `Transport` ke command Tauri dari kontrak. Tidak ada
 * aturan bisnis di sini — semuanya tetap di `runner.ts`, yang TIDAK ditulis
 * ulang: satu berkas pada satu waktu, moderasi lama ≠ gagal, resume setelah
 * restart, semuanya berlaku persis sama di atas transport ini.
 *
 * ## Yang berbeda dari transport HTTP, dan kenapa
 *
 * - `upload()` menerima `File` dan `target`, tapi TIDAK memakainya: byte-nya
 *   dibaca Rust dari `tracks/<hash>` dan API key dari berkas rahasia — tidak pernah
 *   lewat IPC (docs/21 §1f). Yang dikirim hanya `id` baris.
 * - `operation()` menerima `operationId` (kontrak runner), sedangkan
 *   `roblox_operation_poll` menerima `id` BARIS. Pemetaannya lewat `rowIdOf`
 *   yang disuntik route dari store — supaya `resume()` setelah restart, yang
 *   hanya punya `operationId` dari tabel, tetap bisa poll.
 * - `health()` = "API key ada di berkas rahasia DAN creator id terisi". Tidak ada
 *   Worker yang bisa mati; yang bisa kurang hanya dua hal itu.
 *
 * Progres unggah datang dari event `daw://roblox-progress` `{ id, sent, total }`
 * per chunk (§1e). Kalau Rust hanya mengirim kasar (0 → 100), bar-nya tetap
 * jujur: ia bergerak hanya saat Rust bilang begitu.
 */

import type { LocalError } from '../../platform/local-commands';
import { LOCAL_EVENTS } from '../../platform/local-commands';
import { isLocalError } from '../persistence';
import { localInvoke, localListen } from '../local/invoke';
import type { QueueItem } from '../model';
import { UploadError, type OperationState, type StartedUpload, type Transport } from './transport';

export interface DesktopTransportOptions {
  /** Creator id saat ini — dibaca ULANG tiap `health()`, bukan ditangkap sekali. */
  readonly creatorId: () => string;
  /** `localId` baris yang sedang memoderasi `operationId` ini; `null` kalau tidak ada. */
  readonly rowIdOf: (operationId: string) => string | null;
}

interface ProgressPayload {
  readonly id: string;
  readonly sent: number;
  readonly total: number;
}

/** `LocalError` Rust → `UploadError` yang dimengerti runner dan dibaca user. */
function uploadErrorOf(e: unknown): UploadError {
  if (e instanceof UploadError) return e;
  if (isLocalError(e)) {
    const local: LocalError = e;
    // Tidak ada yang ditandai `retryable`: Rust yang tahu apakah byte sudah
    // sampai, dan ia sudah mencoba sendiri kalau aman. Mengulang dari sini
    // berisiko asset duplikat — kesalahan yang memakan kuota bulanan.
    return new UploadError(local.code, local.message);
  }
  return new UploadError('DESKTOP', e instanceof Error ? e.message : String(e));
}

/** Rust tidak diharapkan mengirim nilai lain, tapi kalau itu terjadi, `null` lebih jujur daripada "approved". */
function moderationOf(value: unknown): OperationState['moderationState'] {
  return value === 'reviewing' || value === 'approved' || value === 'rejected' ? value : null;
}

/** Apakah API key Roblox ada di berkas rahasia lokal. Dipakai badge header dan `health()`. */
export async function hasStoredApiKey(): Promise<boolean> {
  return (await localInvoke('secret_get', { key: 'roblox.api_key' })) !== null;
}

export function createDesktopTransport(opts: DesktopTransportOptions): Transport {
  return {
    async health(): Promise<boolean> {
      try {
        return (await hasStoredApiKey()) && opts.creatorId().trim() !== '';
      } catch {
        // Berkas rahasia tidak bisa dibaca (`SECRET_UNAVAILABLE`) sama artinya
        // dengan "tidak ada kunci" bagi halaman: belum bisa mengirim.
        return false;
      }
    },

    async upload(item: QueueItem, _file, _target, onProgress): Promise<StartedUpload> {
      if (item.hash === null) {
        throw new UploadError(
          'BELUM_DI_KEPUSTAKAAN',
          'berkas belum selesai masuk kepustakaan — tunggu sebentar lalu ULANGI',
        );
      }
      const unlisten = await localListen<ProgressPayload>(LOCAL_EVENTS.robloxProgress, (p) => {
        if (p.id !== item.localId || p.total <= 0) return;
        onProgress(Math.round((Math.min(p.sent, p.total) / p.total) * 100));
      }).catch(() => () => {});
      try {
        const started = await localInvoke('roblox_upload_start', { id: item.localId });
        return {
          operationId: started.operationId,
          done: started.done,
          assetId: started.assetId,
          moderationState: moderationOf(started.moderationState),
        };
      } catch (e: unknown) {
        throw uploadErrorOf(e);
      } finally {
        unlisten();
      }
    },

    async operation(operationId, _apiKey): Promise<OperationState> {
      const id = opts.rowIdOf(operationId);
      if (id === null) {
        throw new UploadError(
          'BARIS_TIDAK_DIKENALI',
          `tidak ada baris antrean untuk operasi ${operationId} — periksa Creator Hub`,
        );
      }
      try {
        const state = await localInvoke('roblox_operation_poll', { id });
        return { done: state.done, assetId: state.assetId, moderationState: moderationOf(state.moderationState) };
      } catch (e: unknown) {
        throw uploadErrorOf(e);
      }
    },
  };
}
