/**
 * Barrel halaman ROBLOX.
 *
 * Selain komponen halamannya, yang keluar dari sini adalah PERSIS permukaan
 * yang dibutuhkan lapisan unggah (dikerjakan agent lain): store untuk melapor
 * kemajuan, `fileOf` untuk mengambil byte, dan model untuk memakai aturan
 * validasi yang sama dengan yang dilihat user — bukan salinannya.
 */

export { RobloxPage, type RobloxPageProps } from './RobloxPage';
export { RobloxRoute, type RobloxRouteProps } from './RobloxRoute';
export { createRunner, type Runner } from './backend/runner';
export { createHttpTransport, UploadError, type Transport } from './backend/transport';
export { robloxActions, robloxStore, useRoblox, fileOf } from './store';
export {
  MAX_BYTES,
  MAX_DESC_LEN,
  MAX_NAME_LEN,
  MAX_SECONDS,
  isUploadable,
  readyItems,
  targetProblems,
  violationsOf,
  type CreatorKind,
  type QueueItem,
  type RobloxState,
  type RobloxTarget,
  type UploadStatus,
} from './model';
