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
 *
 * ## Fase tahan (`Command.hold`)
 *
 * Command ber-`hold` tidak dijalankan di keydown. Keydown memanggil
 * `hold.press()`, dan tombolnya DIINGAT berdasarkan `e.code` — bukan chord —
 * supaya keyup tetap cocok walau modifier-nya dilepas lebih dulu. Keyup lalu
 * memanggil `hold.release()`, dan `run()` hanya menyala kalau pelepasan itu
 * ketukan murni. `blur` jendela membatalkan semua yang masih ditahan: Alt-Tab
 * saat Spasi ditahan berarti keyup tidak pernah datang, dan tanpa pembatalan
 * timeline akan terus mengira Spasi ditahan sampai ketukan berikutnya.
 */

import { useEffect } from 'react';

import { getCommand, isCommandEnabled, runCommand, type CommandId } from './command';
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

    /** `e.code` → id command yang sedang ditahan. */
    const held = new Map<string, CommandId>();

    const cancelHeld = (): void => {
      for (const id of held.values()) getCommand(id)?.hold?.cancel();
      held.clear();
    };

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
      const command = getCommand(id);
      if (command === undefined || !isCommandEnabled(command)) return;

      if (command.hold !== undefined) {
        // Beberapa OS mengirim keydown ulang tanpa `repeat` — satu tahan tetap
        // satu `press`.
        if (!held.has(e.code)) {
          command.hold.press();
          held.set(e.code, id);
        }
      } else if (!runCommand(id)) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
    };

    const onKeyUp = (e: KeyboardEvent): void => {
      const id = held.get(e.code);
      if (id === undefined) return;
      held.delete(e.code);
      // Command bisa sudah dicabut selama ditahan (halaman berpindah); yang
      // tersisa cukup dilupakan.
      const tapped = getCommand(id)?.hold?.release() ?? false;
      if (tapped) runCommand(id);
      e.preventDefault();
      e.stopPropagation();
    };

    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('keyup', onKeyUp, { capture: true });
    window.addEventListener('blur', cancelHeld);
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
      window.removeEventListener('keyup', onKeyUp, { capture: true });
      window.removeEventListener('blur', cancelHeld);
      cancelHeld();
    };
  }, [suspended]);
}
