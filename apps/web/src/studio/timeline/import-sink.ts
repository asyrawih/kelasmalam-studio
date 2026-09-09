/**
 * Kabar "satu lagu baru saja masuk", untuk siapa pun yang berkepentingan.
 *
 * ## Kenapa perantara, bukan panggilan langsung
 *
 * Jalur import dipakai `/studio` DAN `/dj`, dan ia sengaja tidak tahu apa-apa
 * tentang jaringan — itu yang membuatnya bisa dites tanpa server dan dipakai
 * ulang tanpa syarat. Kalau `audio-import.ts` meng-import modul kepustakaan,
 * setiap tes import mendadak butuh backend palsu, dan halaman yang tidak punya
 * kepustakaan tetap menyeret kodenya.
 *
 * Sebaliknya: import MENGUMUMKAN, kepustakaan MENDENGARKAN. Yang tidak
 * mendaftar tidak membayar apa-apa.
 *
 * ## Kenapa satu sink, bukan daftar pendengar
 *
 * Yang berkepentingan cuma satu — dok kepustakaan — dan daftar pendengar
 * membawa pertanyaan yang tidak perlu dijawab siapa pun di sini: urutan
 * pemanggilan, siapa yang menang kalau dua-duanya mengunggah, apa yang terjadi
 * kalau salah satu melempar. Satu slot yang jelas pemiliknya lebih mudah
 * ditalar daripada mekanisme umum tanpa pemakai kedua.
 */

export interface ImportedForLibrary {
  /** SHA-256 berkasnya. `''` kalau tidak punya berkas asal (hasil bake). */
  readonly contentHash: string;
  readonly assetId: number;
  readonly name: string;
  /** Byte ASLI, sesudah gunzip kalau ada. Ini yang diunggah apa adanya. */
  readonly bytes: ArrayBuffer;
  /** Hasil `sniff()`: `MP3`, `Ogg`, `WAV`, `FLAC`, … */
  readonly format: string;
  readonly frames: number;
  readonly sampleRate: number;
}

export type ImportSink = (imported: ImportedForLibrary) => void;

let sink: ImportSink | null = null;

/** Pasang pendengar. Mengembalikan pencabutnya. */
export function registerImportSink(fn: ImportSink | null): () => void {
  sink = fn;
  return () => {
    if (sink === fn) sink = null;
  };
}

/**
 * Umumkan satu import yang berhasil.
 *
 * Lemparan dari sink DITELAN dengan sengaja: kepustakaan yang bermasalah tidak
 * boleh menggagalkan import yang sudah selesai. Lagunya sudah ada di timeline;
 * yang gagal cuma salinannya ke server, dan itu urusan yang melapor sendiri.
 */
export function notifyImported(imported: ImportedForLibrary): void {
  if (sink === null) return;
  try {
    sink(imported);
  } catch {
    // Sengaja bisu di sini — lihat catatan di atas.
  }
}
