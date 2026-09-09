/**
 * Lagu kepustakaan yang diseret ke lane.
 *
 * Alasan perantara ini sama persis dengan `import-sink.ts`, dari arah
 * sebaliknya: timeline sengaja tidak tahu apa-apa soal jaringan — itu yang
 * membuatnya bisa dites tanpa server dan dipakai halaman `/dj` juga. Kalau
 * `ClipArea` meng-import modul kepustakaan, setiap tes timeline mendadak butuh
 * backend palsu.
 *
 * Pembagian kerjanya:
 *
 *  - TIMELINE mendaftarkan `LaneLocator`: "titik layar ini lane mana, sample
 *    ke berapa" — rumusnya milik timeline dan hanya hidup di satu tempat —
 *    plus cara menyorot lane yang sedang dilayang-layangi.
 *  - KEPUSTAKAAN menjalankan gesturnya (pointer event di baris lagu), bertanya
 *    ke locator saat pointer bergerak dan saat dilepas, lalu MENGUMUMKAN
 *    "hash ini jatuh di lane itu, di sample sekian".
 *  - DOK KEPUSTAKAAN menerima pengumuman itu dan memutuskan artinya —
 *    mengunduh kalau perlu, memakai asset yang sudah ada kalau sudah ada,
 *    lalu menaruh clip-nya.
 *
 * ## Kenapa pointer event, bukan HTML5 drag-and-drop
 *
 * Dulu baris lagu `draggable` dan lane menerima `drop` dengan MIME khusus.
 * Itu tidak pernah bekerja di aplikasi desktop: Tauri memasang penangan
 * drag-drop native pada WebView (untuk drop berkas dari Finder/Explorer —
 * `useNativeFileDrop`), dan penangan itu MENELAN setiap sesi drag OS, termasuk
 * drag HTML5 yang dimulai dari dalam halaman sendiri. `dragstart` masih
 * terpanggil, tapi `dragover`/`drop` tidak pernah sampai ke DOM; di WebView2
 * (Windows) perilakunya sama. Mematikan penangan itu berarti kehilangan path
 * berkas yang dijatuhkan (kepustakaan menyalin dari path di Rust, bukan
 * mengirim 25 MB lewat IPC), jadi yang diganti adalah gestur INI: pointer
 * event tidak lewat OS sama sekali, dan ClipArea sudah memakai cara yang sama
 * untuk menggeser clip.
 */

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

/** Lane di bawah satu titik layar, dan posisi jatuh di dalamnya. */
export interface LaneTarget {
  readonly laneId: string;
  /** Dalam SAMPLE, dihitung timeline dengan rumus yang sama seperti drop berkas. */
  readonly startSamples: number;
}

export interface LaneLocator {
  /** `null` kalau titik itu (piksel CSS, `clientX/clientY`) bukan di atas lane. */
  readonly locate: (x: number, y: number) => LaneTarget | null;
  /** Sorot lane yang sedang dilayang-layangi; `null` menghapus sorotan. */
  readonly highlight: (laneId: string | null) => void;
}

let locator: LaneLocator | null = null;

/** Dipasang timeline yang punya lane. Mengembalikan pencabutnya. */
export function registerLaneLocator(l: LaneLocator | null): () => void {
  locator = l;
  return () => {
    if (locator === l) locator = null;
  };
}

/** Lane di bawah titik itu; `null` juga kalau tidak ada timeline yang terpasang. */
export function locateLane(x: number, y: number): LaneTarget | null {
  if (locator === null) return null;
  try {
    return locator.locate(x, y);
  } catch {
    return null;
  }
}

/** Sorot (atau hapus sorotan) lane. Tanpa timeline: tidak ada apa-apa. */
export function highlightLane(laneId: string | null): void {
  if (locator === null) return;
  try {
    locator.highlight(laneId);
  } catch {
    // Sorotan hanya umpan balik; gagal menyorot tidak boleh mematikan gesturnya.
  }
}
