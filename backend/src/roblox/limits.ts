/**
 * Batas Roblox — salinan yang SENGAJA berdiri sendiri.
 *
 * Angka-angka ini juga ada di `web/src/roblox/model.ts`, dan itu bukan
 * kelalaian. Dua pilihan yang tersedia, dan keduanya punya harga:
 *
 *  - **Import lintas paket** (`../../web/src/roblox/model`). Satu sumber, tapi
 *    bundle Worker jadi bergantung pada berkas di dalam paket UI. Backend yang
 *    tidak bisa di-build tanpa frontend adalah kopling yang akan menagih
 *    bunganya persis saat salah satunya perlu dipindah.
 *  - **Salin, lalu jaga dengan tes.** Bundle tetap mandiri, dan penyimpangannya
 *    tidak bisa lolos diam-diam.
 *
 * Yang dipilih yang kedua: `limits.test.ts` meng-import model UI dan menuntut
 * angkanya sama persis. Kalau ada yang mengubah salah satu sisi, tesnya merah —
 * yang merah bukan "gaya penulisan", melainkan fakta bahwa UI dan server akan
 * menerima berkas yang berbeda.
 *
 * ## Kenapa server memvalidasi ulang sama sekali
 *
 * Validasi di UI adalah bantuan untuk user, bukan penjaga. Permintaan bisa
 * datang dari mana saja — curl, skrip, tab yang tertinggal dengan kode lama.
 * Yang divalidasi ulang di sini adalah yang bisa dijawab dari byte dan metadata
 * saja; durasi TIDAK, karena mengukurnya berarti mendekode audio di Worker.
 * Itu satu-satunya batas yang penegakannya diserahkan ke Roblox.
 */

/** 20 MB per unggahan — batas Open Cloud, bukan batas kami. */
export const MAX_BYTES = 20 * 1024 * 1024;

/** 7 menit. Ditegakkan Roblox, bukan di sini: lihat kepala berkas. */
export const MAX_SECONDS = 7 * 60;

export const MAX_NAME_LEN = 50;
export const MAX_DESC_LEN = 1000;

/**
 * Ekstensi yang diterima.
 *
 * Open Cloud sebetulnya juga menerima `.wav` dan `.flac` untuk asset audio.
 * Daftar ini sengaja dibuat SAMA dengan yang diterima UI (`AUDIO_EXTS`) supaya
 * tidak ada berkas yang lolos di satu sisi lalu ditolak di sisi lain. Kalau
 * dukungan wav/flac diinginkan, ubah KEDUANYA — dan `limits.test.ts` akan
 * mengingatkan kalau hanya satu yang diubah.
 */
export const AUDIO_EXTS: readonly string[] = ['.mp3', '.ogg'];

/** MIME yang dikirim ke Roblox untuk tiap ekstensi. */
export const MIME_OF: Readonly<Record<string, string>> = {
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
};

/** Ekstensi berkas dalam huruf kecil, termasuk titik. `''` kalau tidak ada. */
export function extOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot <= 0 ? '' : fileName.slice(dot).toLowerCase();
}
