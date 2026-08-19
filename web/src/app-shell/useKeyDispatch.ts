/**
 * SATU listener keyboard untuk seluruh aplikasi.
 *
 * ## Kenapa satu, dan kenapa di shell
 *
 * Listener yang tersebar di tiap halaman berarti tidak ada satu pun tempat yang
 * tahu tombol apa saja yang sudah terpakai — dan bentrokan baru ketahuan saat
 * dua fitur kebetulan dipakai bersamaan. Dengan satu dispatcher di atas semua
 * halaman, "tombol ini milik siapa" adalah pertanyaan yang selalu punya satu
 * jawaban: `activeKeymap()`.
 *
 * ## Fase capture
 *
 * Dipasang dengan `capture: true` supaya menang lebih dulu dari handler
 * komponen. Tanpa itu, menekan Space setelah mengklik sebuah tombol akan
 * meng-'klik' tombol yang masih fokus SEKALIGUS menjalankan command — satu
 * ketukan, dua perbuatan.
 *
 * ## Tombol yang SUDAH punya arti tidak dirampas
 *
 * Tiga lapis pengecualian, dan ketiganya menjawab hal berbeda:
 * saat MENGETIK (huruf harus sampai ke kotaknya), saat tombol DITAHAN
 * (perintah pertunjukan tidak boleh berulang 30×/detik), dan saat Space/Enter
 * sedang MENGAKTIFKAN kontrol yang fokus (itu cara keyboard menekan tombol).
 *
 * ## `preventDefault` hanya kalau command-nya BENAR-BENAR jalan
 *
 * Kalau chord-nya tidak terikat, atau command-nya sedang tidak bisa dijalankan,
 * event diteruskan apa adanya. Menelan tombol yang tidak melakukan apa-apa
 * berarti mematikan perilaku bawaan browser tanpa memberi gantinya — dan itu
 * bentuk kerusakan yang paling sulit dilaporkan, karena yang hilang adalah
 * sesuatu yang user tidak sadar pernah ada.
 */

import { useEffect } from 'react';

import { runCommand } from './command';
import { activeKeymap } from './keymap';
import { activatesFocusedControl, chordOf, isTextEntry } from './keys';

export interface KeyDispatchOptions {
  /**
   * Saat true, seluruh dispatch dimatikan — dipakai saat dialog penangkap
   * tombol sedang terbuka (remap), yang justru butuh chord mentahnya.
   */
  readonly suspended?: boolean;
}

export function useKeyDispatch({ suspended = false }: KeyDispatchOptions = {}): void {
  useEffect(() => {
    if (suspended) return undefined;

    const onKeyDown = (e: KeyboardEvent): void => {
      // Mengetik menang atas shortcut. Tanpa ini, mengetik "q" di kotak
      // pencarian akan memutar deck A — dan hurufnya tidak pernah sampai ke
      // kotaknya.
      if (isTextEntry(e.target)) return;
      // Tombol yang ditahan mengulang; command pertunjukan tidak boleh ikut
      // berulang puluhan kali (PLAY yang di-toggle 30×/detik).
      if (e.repeat) return;
      // Space/Enter saat fokus ada di tombol adalah cara keyboard MENEKAN
      // tombol itu. Merampasnya membuat halaman berhenti bisa dipakai tanpa
      // tetikus, dan itu tidak terlihat sama sekali oleh yang memakai tetikus.
      if (activatesFocusedControl(e)) return;

      const id = activeKeymap().get(chordOf(e));
      if (id === undefined) return;
      if (!runCommand(id)) return;
      e.preventDefault();
      e.stopPropagation();
    };

    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [suspended]);
}
