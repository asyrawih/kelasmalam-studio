/**
 * Identitas asset yang BERTAHAN melewati sesi: SHA-256 dari byte berkasnya.
 *
 * `assetId` numerik adalah penghitung sesi — nomor 3 hari ini dan nomor 3 besok
 * adalah lagu yang berbeda. Itu cukup untuk kunci store, deck, dan cache PCM,
 * tapi tidak cukup untuk apa pun yang tersimpan: project yang menyimpan
 * `assetId: 3` menunjuk lagu yang SALAH setelah refresh, tanpa satu pun tanda.
 *
 * Pembagiannya (docs/16 §2):
 *
 *   assetId: number   → kunci runtime          → satu sesi
 *   contentHash: hex  → kunci R2, D1, project  → selamanya
 *
 * Peta di antara keduanya dibangun ulang tiap sesi, dan itu disengaja: yang
 * butuh stabilitas hanyalah yang tersimpan. Menukar kunci runtime jadi string
 * hash berarti menyentuh deck, cue, grid, payload export, dan cache buffer
 * sekaligus — pekerjaan besar tanpa satu pun manfaat.
 *
 * **SHA-256, bukan BLAKE3.** `crypto.subtle` sudah ada di setiap browser yang
 * menjalankan aplikasi ini; BLAKE3 berarti menambah permukaan build WASM untuk
 * menghitung satu angka. Rust memakai BLAKE3-dipotong-u64, dan selama aplikasi
 * web memakai format serialisasinya sendiri keduanya tidak pernah bertemu —
 * utang yang dicatat di docs/16 §2, bukan yang disembunyikan.
 */

/** SHA-256 heksadesimal huruf kecil, 64 karakter. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * MIME yang dikirim ke kepustakaan untuk tiap format hasil `sniff()`.
 *
 * Yang TIDAK ada di sini (MP4/M4A, WebM, AIFF) tetap bisa diimpor dan dipakai
 * di sesi ini — yang tidak bisa hanyalah diunggah. Server menolak jenis yang
 * tidak dikenalnya, dan menebak MIME di sini hanya memindahkan penolakan itu
 * ke tempat yang lebih membingungkan.
 */
export const MIME_OF_FORMAT: Readonly<Record<string, string>> = {
  MP3: 'audio/mpeg',
  Ogg: 'audio/ogg',
  WAV: 'audio/wav',
  FLAC: 'audio/flac',
};
