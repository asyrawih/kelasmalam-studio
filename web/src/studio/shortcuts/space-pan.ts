/**
 * SPASI: ditahan = alat tangan (pan), diketuk = play.
 *
 * Kenapa modul terpisah dan bukan sekadar `if (e.key === ' ')`: dua fitur
 * memperebutkan tombol yang sama, dan keduanya benar. Spasi sudah lama berarti
 * play/pause — mengambilnya untuk pan akan merusak binding transport yang
 * paling sering dipakai. Sebaliknya, sejak drag di area kosong berarti KOTAK
 * SELEKSI, pan butuh modifier, dan spasi adalah modifier yang sudah dihafal
 * tangan (Figma, Photoshop, Premiere).
 *
 * Pemisahannya berdasarkan APA YANG TERJADI selama tombol ditahan:
 *
 *   tekan spasi → tahan → drag  = PAN, dan play TIDAK di-toggle saat dilepas
 *   tekan spasi → lepas         = PLAY (di keyup, bukan keydown)
 *
 * Harga yang dibayar: play sekarang menyala saat spasi DILEPAS. Untuk ketukan
 * biasa selisihnya beberapa puluh milidetik dan tidak terasa; sebagai gantinya
 * kedua fitur hidup berdampingan tanpa mode dan tanpa tombol tambahan.
 */

let held = false;
let usedForPan = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of [...listeners]) fn();
}

export function isSpaceHeld(): boolean {
  return held;
}

/** Untuk `useSyncExternalStore` di komponen yang perlu mengubah kursornya. */
export function subscribeSpace(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Dipanggil saat pan benar-benar dimulai dengan spasi ditahan. */
export function markSpacePan(): void {
  usedForPan = true;
}

export function pressSpace(): void {
  if (held) return; // auto-repeat: sekali tahan tetap sekali
  held = true;
  usedForPan = false;
  emit();
}

/**
 * Lepas spasi. `true` berarti tombolnya MURNI ketukan — pemanggil boleh
 * memakainya untuk play.
 */
export function releaseSpace(): boolean {
  if (!held) return false;
  held = false;
  const tapped = !usedForPan;
  usedForPan = false;
  emit();
  return tapped;
}

/**
 * Kehilangan fokus jendela membatalkan keadaan tahan.
 *
 * Tanpa ini, berpindah tab saat spasi ditahan (Alt-Tab, Cmd-Tab) membuat keyup
 * tidak pernah sampai: kembali ke aplikasi, timeline masih menganggap spasi
 * ditahan dan drag pertama jadi pan, bukan seleksi.
 */
export function resetSpace(): void {
  if (!held) return;
  held = false;
  usedForPan = false;
  emit();
}
