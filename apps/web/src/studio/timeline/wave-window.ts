/**
 * Jendela gambar: bagian mana dari sebuah bentangan horizontal yang benar-benar
 * perlu digambar.
 *
 * ## Kenapa ini ada
 *
 * Clip di timeline diposisikan dalam PERSEN terhadap track, dan track selebar
 * `durationSec × pxPerSecond`. Zoom dibatasi 400 px/detik, jadi lagu 27 menit
 * menghasilkan track selebar 648.000 px — dan canvas waveform di dalam clip
 * dulu mengambil seluruh lebar itu. Dua hal terjadi sekaligus:
 *
 * 1. **Backing store canvas melewati batas browser.** `fitCanvas` mengalikan
 *    lebar CSS dengan dpr (maksimum 2), jadi 648.000 px jadi 1.296.000 px,
 *    sementara batas dimensi canvas di Chrome/Firefox ada di ~65.535 px. Untuk
 *    file 27 menit, batas itu sudah terlewat pada zoom ~20 px/detik — masih
 *    sangat jauh dari zoom maksimum. Di atas titik itu waveform tidak melambat,
 *    ia HILANG.
 * 2. **Biaya gambar tumbuh mengikuti durasi.** `drawAssetWave` membuat satu
 *    kolom per device pixel dan mengeluarkan empat `lineTo` per kolom, dikali
 *    dua sampai tiga lapis. Sejuta kolom per redraw, dan setiap langkah zoom
 *    memicunya lagi lewat `ResizeObserver`.
 *
 * Yang dilihat mata tetap hanya selebar viewport. Jadi canvas dipasang selebar
 * IRISAN YANG TERLIHAT saja, dan rentang source-nya diiris dengan proporsi yang
 * sama — bentuk yang tergambar identik, biayanya jadi tetap berapa pun durasi
 * project.
 *
 * ## Kenapa dikuantisasi
 *
 * Kalau jendelanya mengikuti `scrollLeft` piksel demi piksel, setiap frame
 * scroll mengubah ukuran canvas dan memicu redraw penuh — dan mengubah
 * `canvas.width` juga membuang isinya, jadi hasilnya berkedip. Dengan
 * dikuantisasi ke kelipatan {@link WINDOW_QUANTUM}, jendela hanya berubah tiap
 * beberapa ratus piksel guliran; di antaranya canvas hanya digeser oleh
 * scroller, yang memang gratis.
 *
 * Efek sampingnya menguntungkan: jendela selalu MELEBIHI viewport (satu kuantum
 * di tiap sisi setelah pembulatan), jadi ada margin yang sudah tergambar
 * sebelum masuk layar.
 */

export interface WaveWindow {
  /** Tepi kiri jendela, px, dalam koordinat lokal bentangan. */
  readonly x: number;
  /** Lebar jendela, px. Selalu > 0. */
  readonly w: number;
}

/**
 * Kelipatan pembulatan tepi jendela, px.
 *
 * 256 px dipilih sebagai kompromi: cukup besar sehingga guliran normal (satu
 * putaran roda ≈ 100 px) sering tidak mengubah jendela sama sekali, dan cukup
 * kecil sehingga canvas terlebar yang mungkin dibuat tetap sekitar lebar
 * viewport + 512 px — jauh di bawah batas dimensi canvas mana pun.
 */
export const WINDOW_QUANTUM = 256;

/**
 * Irisan `[spanLeft, spanLeft + spanWidth)` yang terlihat di viewport
 * `[viewLeft, viewLeft + viewWidth)`, dinyatakan dalam koordinat lokal
 * bentangan itu.
 *
 * `null` berarti bentangannya berada DI LUAR layar sepenuhnya — pemanggil
 * sebaiknya tidak memasang canvas-nya sama sekali, bukan memasang canvas
 * selebar nol.
 *
 * Semua satuan px. Pemanggil yang belum bisa mengukur (elemen belum ter-layout,
 * jsdom) harus melewatkan fungsi ini dan menggambar lebar penuh — jendela yang
 * dihitung dari ukuran nol tidak akan pernah benar.
 */
export function visibleWindow(
  spanLeft: number,
  spanWidth: number,
  viewLeft: number,
  viewWidth: number,
  quantum: number = WINDOW_QUANTUM,
): WaveWindow | null {
  if (!(spanWidth > 0) || !(viewWidth > 0)) return null;
  const q = quantum > 0 ? quantum : 1;

  // Viewport dipindah ke koordinat lokal bentangan.
  const relLeft = viewLeft - spanLeft;
  const relRight = relLeft + viewWidth;
  // Sepenuhnya di kiri atau di kanan layar.
  if (relRight <= 0 || relLeft >= spanWidth) return null;

  // Membulat KELUAR di kedua sisi: membulat ke dalam akan menyisakan pita yang
  // belum tergambar tepat di tepi layar setiap kali user berhenti menggulir di
  // tengah kuantum.
  const x = Math.max(0, Math.floor(relLeft / q) * q);
  const right = Math.min(spanWidth, Math.ceil(relRight / q) * q);
  if (!(right > x)) return null;

  return { x, w: right - x };
}
