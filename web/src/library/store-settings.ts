/**
 * Logika murni panel PENYIMPANAN (docs/21 K3) — dipisah dari komponennya
 * supaya kalimat konfirmasi, kalimat galat, dan hitungan progres bisa diuji
 * tanpa React maupun mock Tauri.
 *
 * Yang sengaja TIDAK ada di sini: hitungan sisa ruang disk. Rust yang tahu
 * disk (`statvfs`/`GetDiskFreeSpaceEx`), dan `LocalError.DISK_FULL` sudah
 * membawa ukuran berkas dan sisa ruang di `message`-nya. Menghitung ulang di
 * TS berarti dua sumber kebenaran yang bisa berbeda — cukup meneruskan
 * pesannya.
 */

import type { LocalError, StoreInfo } from '../platform/local-commands';
import { formatBytes } from './model';

/** Kalimat bantuan yang jujur (docs/21 §1b, §5) — satu sumber untuk UI dan tes. */
export const STORE_HELP = 'Backup = salin folder ini. Kepustakaan ini hanya di mesin ini.';

/** Kalimat yang WAJIB menyertai setiap kegagalan pindah — kontrak `store_relocate`: salin → verifikasi → tukar → hapus lama. */
export const OLD_DIR_INTACT = 'Folder lama tetap utuh.';

/**
 * `formatBytes` kepustakaan berhenti di MB karena satu lagu tidak pernah
 * segigabyte. Seluruh folder bisa — "4608.0 MB" terbaca, tapi "4.5 GB" yang
 * dimengerti orang saat memutuskan pindah ke disk mana.
 */
export function formatStoreBytes(bytes: number): string {
  const GB = 1024 ** 3;
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  return formatBytes(bytes);
}

/**
 * Persentase 0..100 dari event `daw://store-relocate` `{ done, total }`.
 *
 * `total` 0 (kepustakaan kosong, atau event pertama sebelum Rust selesai
 * menghitung) → 0, bukan NaN: `ProgressBar` menerima angka, dan NaN membuat
 * lebar fill-nya "NaN%" yang diabaikan browser secara diam-diam.
 */
export function relocatePercent(p: { readonly done: number; readonly total: number }): number {
  if (!(p.total > 0)) return 0;
  return Math.max(0, Math.min(100, (p.done / p.total) * 100));
}

/**
 * Kalimat konfirmasi sebelum `store_relocate`. Harus menyebut UKURAN yang
 * akan disalin: user memilih folder tanpa tahu apakah disk tujuannya cukup,
 * dan angka ini adalah satu-satunya kesempatan membatalkan sebelum salinan
 * dimulai.
 */
export function confirmRelocateMessage(info: StoreInfo, newDir: string): string {
  const isi = `${info.tracks} lagu, ${info.projects} project`;
  return `Salin ${formatStoreBytes(info.bytes)} (${isi}) ke ${newDir}? Folder lama dihapus sesudah salinan diverifikasi.`;
}

/**
 * Pesan gagal pindah: kode + pesan Rust APA ADANYA, lalu jaminan folder lama.
 *
 * Pesan Rust tidak diganti kalimat umum — untuk `DISK_FULL` ia memuat ukuran
 * berkas dan sisa ruang, dan itulah yang perlu dibaca user untuk memilih
 * disk lain. Label kodenya ditambahkan supaya "disk penuh" terbaca bahkan
 * bila pesannya panjang.
 */
export function relocateFailureMessage(err: LocalError): string {
  const label = err.code === 'DISK_FULL' ? 'Disk tujuan penuh: ' : '';
  return `${label}${err.message} ${OLD_DIR_INTACT}`;
}

/**
 * Label tombol buka folder mengikuti nama pengelola berkas OS-nya —
 * "Finder" di Mac, "Explorer" di Windows. Di Linux tidak ada satu nama.
 */
export function revealLabel(userAgent: string): string {
  if (/Mac OS X|Macintosh/.test(userAgent)) return 'BUKA DI FINDER';
  if (/Windows/.test(userAgent)) return 'BUKA DI EXPLORER';
  return 'BUKA FOLDER';
}
