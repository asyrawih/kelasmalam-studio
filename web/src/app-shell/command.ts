/**
 * REGISTRY COMMAND — satu daftar untuk semua yang bisa "dilakukan" aplikasi.
 *
 * ## Kenapa registry, bukan `switch (e.key)` di tiap halaman
 *
 * Sebuah aksi punya lebih dari satu pintu masuk. Hari ini: tombol di layar dan
 * keyboard. Berikutnya: command palette, MIDI controller, macro, remote. Kalau
 * tiap pintu memetakan sendiri ke `djActions.*`, jumlah pemetaan tumbuh
 * PERKALIAN — dan tiap pintu baru berarti menulis ulang seluruh daftar aksinya,
 * lalu menjaganya tetap sama selamanya.
 *
 * Dengan registry, tiap aksi punya **satu id stabil** (`dj.deckA.play`), dan
 * pintu mana pun cukup mengirim id itu. Menambah pintu baru berarti menulis satu
 * penerjemah, bukan satu salinan daftar.
 *
 * ## Kenapa command didaftarkan oleh HALAMAN, bukan dideklarasikan global
 *
 * `dj.deckA.play` tidak punya arti saat user sedang di `/studio`. Command yang
 * didaftarkan selama komponennya hidup membuat "apa yang bisa dilakukan
 * sekarang" jadi pertanyaan yang punya jawaban — dan itulah yang membuat
 * command palette bisa menampilkan daftar yang jujur alih-alih daftar penuh
 * berisi hal yang diam-diam tidak melakukan apa-apa.
 */

import type { Chord } from './keys';

export type CommandId = string;

export interface Command {
  /** Id STABIL. Ikut tersimpan di keymap user — jangan pernah diubah. */
  readonly id: CommandId;
  /** Label untuk palette dan daftar shortcut. */
  readonly title: string;
  /** Pengelompokan di palette, mis. `Deck A`, `Mixer`. */
  readonly group: string;
  /**
   * Binding bawaan. `null` = command yang hanya bisa dipanggil lewat palette.
   *
   * Itu keadaan yang sah dan sering benar: tidak semua aksi pantas memakan satu
   * tombol, dan keyboard punya lebih sedikit tombol daripada aplikasi ini punya
   * aksi.
   */
  readonly defaultChord: Chord | null;
  /**
   * Chord lain yang menjalankan command yang sama, tapi TIDAK ditampilkan.
   *
   * Ada karena satu aksi kadang punya dua tombol yang sama-sama wajar, dan
   * memaksa user menebak yang mana berarti salah satunya bocor ke browser.
   * Contohnya `/` dan `?` untuk daftar pintasan: keduanya diraih orang, dan
   * yang tidak terikat akan membuka Quick Find Firefox.
   *
   * Alias adalah BAWAAN saja. Begitu user mengikat chord-nya sendiri, alias
   * ikut dilepas — pilihan user menggantikan seluruhnya, bukan menumpuk.
   */
  readonly defaultAliases?: readonly Chord[];
  /**
   * `false` = command terdaftar tapi sedang tidak bisa dijalankan (mis. deck
   * kosong). Palette tetap menampilkannya, dalam keadaan redup — menyembunyikan
   * aksi yang sedang tidak bisa dipakai membuat user mengira ia tidak ada.
   */
  readonly enabled?: () => boolean;
  readonly run: () => void;
}

const commands = new Map<CommandId, Command>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of [...listeners]) fn();
}

export function subscribeCommands(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Daftarkan sekumpulan command. Kembaliannya membatalkan pendaftaran.
 *
 * Id yang sama didaftarkan dua kali MENIMPA, bukan menggandakan: saat React
 * me-mount ulang komponen (StrictMode di dev melakukannya dengan sengaja),
 * pendaftaran kedua harus menghasilkan keadaan yang sama, bukan dua entri.
 */
export function registerCommands(list: readonly Command[]): () => void {
  for (const c of list) commands.set(c.id, c);
  emit();
  return () => {
    for (const c of list) {
      // Hanya lepas kalau yang terdaftar MASIH milik kita. Kalau sudah ditimpa
      // pendaftaran yang lebih baru, melepasnya akan mencabut command yang
      // sedang dipakai halaman yang baru.
      if (commands.get(c.id) === c) commands.delete(c.id);
    }
    emit();
  };
}

export function getCommand(id: CommandId): Command | undefined {
  return commands.get(id);
}

export function listCommands(): readonly Command[] {
  return [...commands.values()];
}

export function isCommandEnabled(c: Command): boolean {
  return c.enabled === undefined ? true : c.enabled();
}

/**
 * Jalankan satu command.
 *
 * Mengembalikan `false` kalau tidak ada atau sedang tidak bisa dijalankan —
 * pemanggil yang butuh tahu (dispatcher keyboard) memakainya untuk memutuskan
 * apakah event-nya perlu di-`preventDefault`. Menelan tombol yang tidak
 * melakukan apa-apa akan mematikan perilaku bawaan browser tanpa gantinya.
 */
export function runCommand(id: CommandId): boolean {
  const c = commands.get(id);
  if (c === undefined || !isCommandEnabled(c)) return false;
  c.run();
  return true;
}

/** Hanya untuk tes. */
export function __clearCommandsForTest(): void {
  commands.clear();
  emit();
}
