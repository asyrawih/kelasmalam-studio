/**
 * Judul dokumen/jendela dan alasan penjaga tutup — aturan MURNI yang dipakai
 * kedua app (docs/25 P2).
 *
 * Web memakainya untuk `document.title` dan `beforeunload`; desktop untuk
 * judul jendela Tauri dan `onCloseRequested` (`apps/desktop/src/window/`).
 * Satu aturan, dua pintu: kalau tanda kotor di judul atau urutan prioritas
 * "export dulu, baru kotor" berubah, keduanya berubah bersama. Tidak ada
 * platform di sini — hanya string dan angka.
 */

/** Nama aplikasi di judul — sama dengan `<title>` di `index.html` kedua app. */
export const APP_TITLE = 'KELAS MALAM STUDIO';

/**
 * Judul: `<project> — KELAS MALAM STUDIO`, dengan `•` di depan saat ada
 * perubahan belum disimpan.
 *
 * Titik di DEPAN mengikuti konvensi macOS (titik di tombol tutup / judul
 * dokumen), dan diletakkan di depan bukan belakang supaya tetap terlihat saat
 * judul panjang terpotong di tengah oleh OS. Aturan yang sama dipakai
 * `document.title` di web — tab browser yang bertanda sama bergunanya.
 */
export function windowTitle(projectName: string, dirty: boolean): string {
  const name = projectName.trim() === '' ? 'Tanpa nama' : projectName.trim();
  return `${dirty ? '• ' : ''}${name} — ${APP_TITLE}`;
}

export type CloseGuardReason = 'export' | 'dirty';

/**
 * Kenapa penutupan harus ditanya dulu — atau `null` kalau boleh langsung.
 *
 * Export didahulukan: berkas yang terpotong di tengah lebih mahal daripada
 * edit yang hilang, dan pesannya harus menyebut itu, bukan "belum disimpan".
 */
export function closeGuardReason(s: {
  readonly exportProgress: number | null;
  readonly dirty: boolean;
}): CloseGuardReason | null {
  if (s.exportProgress !== null) return 'export';
  if (s.dirty) return 'dirty';
  return null;
}
