/**
 * Lagu kepustakaan yang dijatuhkan ke lane.
 *
 * Alasan perantara ini sama persis dengan `import-sink.ts`, dari arah
 * sebaliknya: timeline sengaja tidak tahu apa-apa soal jaringan — itu yang
 * membuatnya bisa dites tanpa server dan dipakai halaman `/dj` juga. Kalau
 * `ClipArea` meng-import modul kepustakaan, setiap tes timeline mendadak butuh
 * backend palsu.
 *
 * Jadi: timeline MENGUMUMKAN "hash ini dijatuhkan di lane itu, di sample
 * sekian", dan kepustakaan yang memutuskan artinya — mengunduh kalau perlu,
 * memakai asset yang sudah ada kalau sudah ada, lalu menaruh clip-nya.
 *
 * ## MIME khusus, bukan `text/plain`
 *
 * Lane sudah menerima `text/plain` sebagai URL untuk diimpor. Kalau hash
 * dikirim lewat jalur itu, ia akan dicoba diunduh sebagai URL dan gagal dengan
 * pesan yang tidak masuk akal. Tipe sendiri membuat keduanya tidak pernah
 * tertukar — dan aplikasi lain yang kebetulan menerima drop kita tidak melihat
 * apa-apa selain teks yang mereka abaikan.
 */

/** Tipe data drag untuk satu lagu kepustakaan. Isinya `contentHash`. */
export const LIBRARY_TRACK_MIME = 'application/x-kelasmalam-track';

export interface LibraryDrop {
  readonly contentHash: string;
  readonly laneId: string;
  /** Posisi jatuh, dalam SAMPLE (satuan yang dipakai timeline). */
  readonly startSamples: number;
}

export type LibraryDropHandler = (drop: LibraryDrop) => void;

let handler: LibraryDropHandler | null = null;

/** Pasang penangan. Mengembalikan pencabutnya. */
export function registerLibraryDropHandler(fn: LibraryDropHandler | null): () => void {
  handler = fn;
  return () => {
    if (handler === fn) handler = null;
  };
}

/** `true` kalau ada yang siap menanganinya — dipakai untuk memutuskan kursor. */
export function hasLibraryDropHandler(): boolean {
  return handler !== null;
}

/**
 * Umumkan satu drop.
 *
 * Lemparan dari penangan DITELAN: kepustakaan yang bermasalah tidak boleh
 * menggagalkan gestur drag yang sudah selesai, dan yang gagal melapor sendiri
 * lewat kabar di dok.
 */
export function notifyLibraryDrop(drop: LibraryDrop): void {
  if (handler === null) return;
  try {
    handler(drop);
  } catch {
    // Sengaja bisu — lihat catatan di atas.
  }
}
