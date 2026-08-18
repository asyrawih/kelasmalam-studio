/**
 * Stack privat per thread untuk artefak `mt`.
 *
 * MASALAH YANG DIPECAHKAN. Varian `mt` di-link dengan `--import-memory
 * --shared-memory`, dan modul yang SAMA di-instantiate di banyak thread di atas
 * linear memory yang SAMA: main thread (surface bindgen), AudioWorklet (surface
 * raw), import worker, export worker. Global WebAssembly bersifat per-instance,
 * jadi setiap thread memang punya `__stack_pointer` sendiri — tapi semuanya
 * DIINISIALISASI KE NILAI YANG SAMA (`-zstack-size=1048576` → 1 MiB). Artinya
 * semua thread menumbuhkan stack-nya di rentang alamat yang persis sama dan
 * saling menimpa bingkai satu sama lain.
 *
 * KENAPA INI SULIT DIKENALI. Kerusakannya tidak pernah muncul di tempat
 * kejadian. Yang meledak adalah kode lain yang kebetulan memakai memori yang
 * sudah ditimpa, beberapa milidetik kemudian — `free()` sebuah objek yang tidak
 * bersalah ("attempted to take ownership of Rust value while it was borrowed"),
 * bounds check di dalam encoder WAV, atau "memory access out of bounds". Setiap
 * kali di tempat yang berbeda. Itu sebabnya gejalanya terlihat seperti bug di
 * export, padahal export hanya korban yang paling sering kena karena ia satu-
 * satunya yang memakai stack dalam-dalam sementara worklet berjalan terus.
 *
 * DIUKUR, bukan dikira: dua instance di atas satu memory, satu memanggil
 * `engine_process` tanpa henti — export di instance lain rusak dalam kurang
 * dari 3 putaran. Dengan stack terpisah: 40 putaran bersih. Kalau worker hanya
 * meng-instantiate tanpa memanggil apa pun, atau hanya memanggil fungsi tanpa
 * bingkai stack, tidak ada kerusakan sama sekali — konsisten dengan stack, bukan
 * heap, sebagai sumbernya.
 *
 * KONTRAKNYA. Stack dialokasi di MAIN THREAD (`allocThreadStack`) selagi belum
 * ada thread lain yang menjalankan wasm, lalu pointer-nya dikirim ke thread yang
 * bersangkutan, yang memanggil [`adoptThreadStack`] SEBELUM panggilan wasm
 * pertamanya. Urutan itu penting: mengalokasi dari dalam thread baru berarti
 * `malloc` sendiri berjalan di atas stack yang masih bertabrakan.
 *
 * Hanya berlaku untuk `mt`. Varian `st` punya memory sendiri per instance, jadi
 * stack-nya memang tidak pernah bertemu.
 */

/** 1 MiB — sama dengan `-zstack-size` di scripts/build-wasm.sh. */
export const THREAD_STACK_BYTES = 1 << 20;

/** Bagian dari export mentah yang dibutuhkan untuk mengurus stack. */
export interface StackCapableExports {
  /** Global `__stack_pointer`, diekspor lewat `--export=__stack_pointer`. */
  readonly __stack_pointer?: WebAssembly.Global;
  readonly scratch_alloc?: (len: number) => number;
}

export interface ThreadStack {
  /** Awal blok (alamat rendah). Disimpan supaya tidak ikut ter-GC/-free. */
  readonly ptr: number;
  /** Alamat TERTINGGI, sudah rata 16 byte. Stack wasm tumbuh ke bawah. */
  readonly top: number;
}

/**
 * Alokasikan satu stack. **Panggil dari main thread saja.**
 *
 * `null` berarti artefaknya belum mengekspor `__stack_pointer` (build lama).
 * Itu dikembalikan sebagai nilai, bukan dilempar: jalur `st` tidak
 * membutuhkannya sama sekali, dan pemanggil yang membutuhkannya berhak memilih
 * sendiri antara gagal keras atau berjalan tanpa isolasi stack.
 */
export function allocThreadStack(raw: StackCapableExports): ThreadStack | null {
  if (typeof raw.scratch_alloc !== 'function' || raw.__stack_pointer === undefined) return null;
  // +16 memberi ruang untuk pembulatan ke bawah saat meratakan `top`.
  const ptr = raw.scratch_alloc(THREAD_STACK_BYTES + 16);
  if (ptr === 0) return null;
  // Rata 16 byte: ABI wasm mengharuskan stack pointer selaras 16.
  const top = (ptr + THREAD_STACK_BYTES) & ~15;
  return { ptr, top };
}

/**
 * Pindahkan stack thread ini ke blok yang sudah disediakan.
 *
 * HARUS jadi hal pertama yang dilakukan sesudah instantiate, sebelum memanggil
 * fungsi wasm apa pun yang punya bingkai stack. Mengembalikan `false` kalau
 * artefaknya tidak mendukung — pemanggil yang memutuskan apakah itu fatal.
 */
export function adoptThreadStack(raw: StackCapableExports, stack: ThreadStack | null): boolean {
  const sp = raw.__stack_pointer;
  if (stack === null || sp === undefined) return false;
  sp.value = stack.top;
  return true;
}
