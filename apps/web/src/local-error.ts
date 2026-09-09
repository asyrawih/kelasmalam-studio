/**
 * `LocalError` — SATU bentuk kegagalan untuk semua yang "lokal" (docs/21 §2a).
 *
 * Bentuk ini lahir sebagai penolakan `invoke` dari Rust di desktop, tapi ia
 * TIDAK milik desktop: `roblox/persistence.ts` (IndexedDB, web) melempar
 * bentuk yang sama supaya UI Roblox punya satu jalur pesan galat untuk dua
 * penyimpanan, dan `library/api.ts` menerjemahkannya ke `LibraryError`.
 * Karena itu ia tinggal di sini — netral, tanpa Tauri — dan
 * `apps/desktop/src/platform/local-commands.ts` (kontrak command Tauri)
 * mengimpornya dari sini, bukan sebaliknya (docs/25 P2).
 *
 * `message` ditulis untuk dibaca user, sama seperti Worker. Kode dan field
 * tambahannya:
 */
export interface LocalError {
  readonly code:
    | 'NOT_FOUND'
    | 'IN_USE' // hapus ditolak; `message` menyebut pemakainya, `count` jumlahnya
    | 'VERSION_CONFLICT' // simpan project dengan versi basi; `currentVersion` terisi
    | 'DISK_FULL'
    | 'INVALID'
    | 'SECRET_UNAVAILABLE' // berkas rahasia Roblox tidak bisa dibaca/ditulis
    | 'HTTP' // Open Cloud menjawab galat; `status` terisi
    | 'YOUTUBE' // yt-dlp menolak; `message` = kalimat yt-dlp sendiri (docs/23)
    | 'IO';
  readonly message: string;
  readonly count?: number;
  readonly currentVersion?: number;
  readonly status?: number;
}
